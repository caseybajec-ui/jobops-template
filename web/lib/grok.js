/**
 * Reading an apply log. Pure — no database, no network, no `node:`, no model.
 *
 * An external bot submits applications and produces a log. the owner pastes it in, or a bot pushes it
 * through the token route.
 * NOTHING HERE OR ANYWHERE ELSE CONTACTS THAT BOT: no client, no webhook, no
 * polling, no credential. The paste box is the only way in.
 *
 * TWO FORMATS, BOTH DETERMINISTIC, because a model is the expensive way to do
 * something a split can do. The pipe log is the primary one; the 7pm digest is
 * a bullet list of company names with no role, which is less information and
 * must still land as a row rather than being discarded for being thin.
 *
 * The model is a FALLBACK and only when deterministic parsing found nothing at
 * all — see the route. It extracts; it never deletes and never overwrites a
 * deterministic result.
 */

/** Statuses the log uses. Anything else is kept verbatim and flagged. */
export const STATUSES = ["success", "blocked", "no posting", "skipped",
                         "rejected", "parked", "queued", "pending"];

/**
 * Words a bot writes that MEAN one of the statuses above.
 *
 * A real apply log turned out to use fourteen statuses where this parser knew
 * four: "submitted" for a completed application, and a family of PARK_*
 * tags for a form it could not finish. Keeping "submitted" verbatim was
 * honest and useless: it is a success, and every count of successes missed
 * it. The map is deliberately small -- only words whose meaning is not in
 * doubt. "parked" and its PARK_* variants stay their own status (a parked
 * application is neither blocked by the site nor skipped by choice), so the
 * page can show them as what they are.
 */
const STATUS_ALIASES = {
  submitted: "success", applied: "success", done: "success",
  park: "parked", park_captcha: "parked", park_fact_needed: "parked",
  park_tech: "parked", "no_posting": "no posting", "no-posting": "no posting",
};

/**
 * Company suffixes that carry no identity.
 *
 * "Anduril" and "Anduril Industries, Inc." are one company; "Scale AI" and
 * "Scale" are one company. STRIPPED ONLY FROM THE END, and only as whole
 * words: a bare substring test files a Metabase engineer under Meta, which is
 * the same mistake `companyMatches` in sourcing.js was written to avoid.
 */
const SUFFIXES = [
  "inc", "inc.", "llc", "l.l.c.", "corp", "corp.", "corporation", "co",
  "co.", "ltd", "ltd.", "limited", "plc", "gmbh", "sa", "s.a.", "ag", "nv",
  "bv", "pty", "llp", "lp", "holdings", "group", "technologies", "technology",
  "labs", "systems", "industries", "the",
];

/** Lower-case, unpunctuated, suffix-free. The key both sides compare on. */
export function normalizeEmployer(s) {
  let t = String(s || "").toLowerCase().trim();
  t = t.replace(/[‘’“”]/g, "'");
  t = t.replace(/[^a-z0-9&+. ]+/g, " ").replace(/\s+/g, " ").trim();
  // Repeatedly, so "Foo Technologies Inc." loses both.
  for (let i = 0; i < 4; i++) {
    const parts = t.split(" ");
    if (parts.length > 1 && SUFFIXES.includes(parts[parts.length - 1])) {
      parts.pop();
      t = parts.join(" ");
    } else {
      break;
    }
  }
  return t.replace(/\.$/, "").trim();
}

/**
 * Which known company this employer string IS, or null.
 *
 * EXACT OR CLEAN-SUFFIX ONLY. Nothing fuzzier gets a match: no edit distance,
 * no prefix rule, no "starts with". An unmatched row is stored with a null
 * employer and shown in the unmatched list for the owner to resolve, which costs a
 * click; a wrong auto-merge files an application against the wrong company and
 * is invisible afterwards, because the row looks exactly like a right one.
 *
 * @param known [{ slug, display_name }]
 */
export function matchEmployer(employerRaw, known = []) {
  const want = normalizeEmployer(employerRaw);
  if (!want) return null;
  for (const c of known) {
    if (normalizeEmployer(c.display_name) === want) return c.slug;
  }
  for (const c of known) {
    if (normalizeEmployer(c.slug) === want) return c.slug;
  }
  return null;
}

/**
 * What to SHOW for a row: the canonical company name once one is known.
 *
 * "Anduril Industries, Inc." and a resolved "Andurl" are both Anduril, and a
 * page that keeps rendering whatever the log happened to say makes a resolved
 * row look exactly like an unresolved one -- which is how a resolve that only
 * cleared a warning would have passed for a resolve that worked.
 *
 * employer_raw IS KEPT AND KEPT VISIBLE. It is what the log actually said,
 * which is the audit trail: if a company link is ever wrong, the only way to
 * see that is to compare the name shown against the words the bot wrote.
 * Replacing it would make the mistake unfindable.
 */
export function displayEmployer(row, known = []) {
  const id = row?.employer_id;
  if (!id) return { name: String(row?.employer_raw || ""), raw: null };
  const c = known.find((k) => k.slug === id);
  const name = c ? c.display_name : String(row?.employer_raw || "");
  const raw = String(row?.employer_raw || "");
  // Only show the raw form when it differs, or every row grows a redundant
  // second copy of its own name.
  return { name, raw: normalizeEmployer(raw) === normalizeEmployer(name) ? null : raw };
}

const CANON = (s) => {
  let t = String(s || "").toLowerCase().trim().replace(/[.]+$/, "");
  // "PARK_FACT_NEEDED 2026-09-17: ..." -> the tag alone decides the status;
  // the rest is the bot's note and belongs in notes, which it usually also is.
  const tag = t.match(/^(park(?:_[a-z]+)?|submitted|applied|done|rejected|blocked|skipped|queued|pending|success)\b/);
  if (tag) t = tag[1];
  if (STATUS_ALIASES[t]) t = STATUS_ALIASES[t];
  return STATUSES.includes(t) ? t : null;
};

/** The exact column order rows are read in. The header, if any, is skipped. */
export const COLUMNS = ["date", "channel", "employer", "role", "location", "status", "notes"];

/** Header words that mean the same column, so a mismatch is judged on meaning. */
const HEADER_SYNONYMS = {
  date: "date", applied: "date", applied_date: "date",
  channel: "channel", source: "channel", site: "channel", ats: "channel",
  employer: "employer", company: "employer", firm: "employer",
  role: "role", title: "role", position: "role",
  location: "location", city: "location", loc: "location",
  status: "status", outcome: "status", result: "status",
  notes: "notes", note: "notes", comment: "notes", comments: "notes",
};

/**
 * If the text starts with a header line whose column ORDER differs from
 * COLUMNS, return the header as written; otherwise null.
 *
 * Rows are positional and the header is skipped, so a header in the wrong
 * order is harmless by itself -- but a bot that writes its header one way
 * usually writes its rows the same way, and then every row lands shifted with
 * the row count looking right. This cannot know which of the two the bot did;
 * it can only say the header disagrees with how the rows will be read, so a
 * person looks. Synonyms are folded (company = employer, source = channel) so
 * a header that merely uses different words for the same order is not a
 * mismatch.
 */
export function headerMismatch(text) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes("|")) return null;
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|")
      .map((c) => c.trim().toLowerCase().replace(/\s+/g, "_"));
    // A header is a line where (nearly) every cell is a column name.
    const named = cells.map((c) => HEADER_SYNONYMS[c] || null);
    if (named.filter(Boolean).length < Math.max(3, cells.length - 1)) return null;
    const order = named.filter(Boolean);
    const expect = COLUMNS.slice(0, order.length);
    const same = order.every((c, i) => c === expect[i]);
    return same ? null : line;
  }
  return null;
}

/** ISO date if the field is one, else null. Never guesses. */
export function parseDate(s) {
  const t = String(s || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // 09/08/2026 and 9/8/26, read as month/day — the bot is American and so is
  // the log. Ambiguous by nature, which is why it is the second rule and not
  // the first: an ISO date in the paste always wins.
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  return null;
}

/** Lines that are obviously not data. */
const NOISE = /^(date|channel|employer|company|role|status|notes|---+|===+|\|[\s|:-]*\|?)$/i;
const SEPARATOR = /^[\s|+:-]+$/;

/**
 * The pipe log:  date | channel | employer | role | location | status | notes
 *
 * TOLERATES A MISSING NOTES COLUMN, and in fact tolerates any tail being
 * absent — the bot omits what it does not have, and a parser that requires
 * seven fields drops every row that had six. Fewer than the minimum is not a
 * row and is left alone rather than guessed at.
 */
/** One pipe-delimited line, or null if it is not one. */
export function parsePipeLine(rawLine, { today = null } = {}) {
  const line = String(rawLine || "").trim()
    .replace(/^\|/, "").replace(/\|$/, "").trim();
  if (!line || SEPARATOR.test(line)) return null;
  if (!line.includes("|")) return null;
  const f = line.split("|").map((x) => x.trim());
  if (f.length < 3) return null;
  // A header row: every cell is a column name.
  if (f.filter((x) => NOISE.test(x)).length >= 3) return null;

  const [d, channel, employer, role, location, status, notes] = f;
  const applied = parseDate(d);
  if (!applied && !today) return null;
  if (!employer) return null;
  return {
    applied_date: applied || today,
    channel: channel || null,
    employer_raw: employer,
    role: role || null,
    location: location || null,
    // AN UNRECOGNISED STATUS IS KEPT, not dropped and not coerced to
    // success. The log's vocabulary can grow, and the honest reading of a
    // word this code does not know is the word itself.
    status: CANON(status) || (status ? status.toLowerCase() : "success"),
    notes: notes || null,
  };
}

export function parsePipeLog(text, { today = null } = {}) {
  return String(text || "").split(/\r?\n/)
    .map((l) => parsePipeLine(l, { today })).filter(Boolean);
}

/**
 * The 7pm digest: a bullet list of company names, nothing else.
 *
 * LESS INFORMATION IS STILL INFORMATION. the owner applied to these companies
 * today; there is no role, no channel and no location, so those are null and
 * the date is the day of the paste. Refusing the format because it is thin
 * would lose the one record that says an application happened.
 *
 * REQUIRES A BULLET. Free prose is not a company list, and a parser that
 * reads every line of any paste as a company name turns a stray email into
 * forty employers. That is what the zero-row red banner is for: better to
 * report that nothing parsed than to invent rows.
 */
/** One bulleted company line, or null if it is not one. */
export function parseDigestLine(rawLine, { today = null } = {}) {
  const line = String(rawLine || "").trim();
  const m = /^(?:[-*•–—]|\d+[.)])\s+(.*)$/.exec(line);
  if (!m) return null;
  // "Anduril - Product Manager" keeps only the company; a digest line that
  // happens to carry a role is still a digest line.
  let name = m[1].trim().replace(/\s*[–—-]\s+.*$/, "").trim();
  name = name.replace(/\s*\((?:applied|submitted)[^)]*\)\s*$/i, "").trim();
  if (!name || NOISE.test(name)) return null;
  // A sentence is not a company name.
  if (name.split(/\s+/).length > 6 || name.length > 80) return null;
  if (/[.!?]$/.test(name) && name.split(/\s+/).length > 3) return null;
  return {
    applied_date: today,
    channel: null,
    employer_raw: name,
    role: null,
    location: null,
    status: "success",
    notes: null,
  };
}

export function parseDigest(text, { today = null } = {}) {
  return String(text || "").split(/\r?\n/)
    .map((l) => parseDigestLine(l, { today })).filter(Boolean);
}

/**
 * Everything a paste yields, deterministically.
 *
 * PIPE-FIRST PER LINE, NOT PER PASTE.
 *
 * The first version chose one format for the whole paste: any pipe row at all
 * and the digest was never tried, and otherwise every line went to the digest.
 * That silently DOWNGRADED a mixed paste -- one pipe line beside two bullets
 * came back as three roleless digest rows, so the pipe line lost its role, its
 * channel and its location and nothing said so. Found by pasting one, which is
 * the only way it could have been found: the row count was right and every row
 * looked plausible.
 *
 * Per line, each line is read as what it is. The order still matters WITHIN a
 * line -- a pipe row whose notes column contains "see - Vanta below" is a pipe
 * row, because pipe is tried first and matches.
 *
 * The cost is that a bullet on its OWN line inside a pipe log is now a company
 * rather than being ignored. That is the better reading: a line saying nothing
 * but "- Vanta" in an apply log is Vanta, and the old rule silently dropped it.
 */
export function parsePaste(text, { today = null } = {}) {
  const rows = [];
  const formats = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const piped = parsePipeLine(line, { today });
    if (piped) { rows.push(piped); formats.add("pipe"); continue; }
    const dig = parseDigestLine(line, { today });
    if (dig) { rows.push(dig); formats.add("digest"); }
  }
  if (!rows.length) return { rows: [], format: null };
  // NAMED HONESTLY. "mixed" is what the paste was, and the page says so:
  // reporting a mixed paste as "pipe" is how the downgrade stayed invisible.
  const format = formats.size > 1 ? "mixed" : [...formats][0];
  return { rows, format };
}

/**
 * Same employer and same role is the same application. Last write wins.
 *
 * THE SEPARATOR IS WRITTEN AS AN ESCAPE, never as a literal byte. A raw NUL
 * got in here and test_line_endings.py refused it -- correctly: a control
 * byte in source is indistinguishable from the ones a shell heredoc leaves
 * behind when it collapses an escape, and that has cost this project real
 * time twice. NUL cannot occur in an employer or a role, so the two halves
 * can never run together and make "Anduril"+"PM" collide with "AndurilP"+"M".
 */
export const dedupeKey = (r) =>
  `${normalizeEmployer(r.employer_raw)}\u0000${String(r.role || "").toLowerCase().trim()}`;

/** Collapse duplicates WITHIN one paste, keeping the last of each. */
export function dedupeRows(rows = []) {
  const out = new Map();
  for (const r of rows) out.set(dedupeKey(r), r);
  return [...out.values()];
}

/**
 * Attach a company to each row, and say which ones could not be attached.
 *
 * The unmatched list is the deliverable here, not a byproduct: it is the only
 * place a wrong-looking employer surfaces, and it is deliberately the owner's job
 * rather than a model's.
 */
export function matchRows(rows = [], known = []) {
  const matched = rows.map((r) => ({
    ...r, employer_id: matchEmployer(r.employer_raw, known),
  }));
  const unmatched = [...new Set(
    matched.filter((r) => !r.employer_id).map((r) => r.employer_raw))].sort();
  return { rows: matched, unmatched };
}

/**
 * Is the applied_apps table going stale?
 *
 * THE FAILURE THIS CATCHES IS SILENT BY CONSTRUCTION. If the owner stops pasting,
 * or the bot stops producing a log, the table simply stops growing -- and a
 * table that stops growing looks exactly like a table nobody has written to
 * yet. Returns null when there is nothing to judge from, which renders
 * differently from "fresh": never having imported and having stopped
 * importing are different findings.
 */
export function grokStale(lastImportedAt, now, staleDays) {
  if (!lastImportedAt) return { stale: false, never: true, days: null };
  const a = Date.parse(String(lastImportedAt).replace(" ", "T"));
  const b = Date.parse(String(now).replace(" ", "T"));
  if (Number.isNaN(a) || Number.isNaN(b)) {
    return { stale: false, never: false, days: null };
  }
  const days = Math.max(0, (b - a) / 86400000);
  return { stale: days > staleDays, never: false, days };
}
