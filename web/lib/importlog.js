/**
 * Import an apply log: the one piece of logic behind two doors.
 *
 * The paste box at /applications (a signed-in human) and the token-protected
 * POST /api/applications/import (an external apply bot pushing its own log)
 * both end here. One implementation, so a rule added to one -- the row cap,
 * the zero-row red banner, the dedupe by employer and role -- cannot be
 * missing from the other.
 *
 * NOTHING HERE CONTACTS THE BOT. This accepts text; it never fetches, polls,
 * or holds a credential for anything outside this app. The security model of
 * the import route is a bearer token that unlocks exactly this write and
 * nothing else (see middleware.js).
 *
 * DETERMINISTIC ONLY on the happy path. Both formats are parsed by lib/grok.js
 * with a split and two regexes; the model is consulted only when that found
 * nothing (lib/ingest.js), and never overwrites a deterministic result.
 *
 * ZERO ROWS FROM NON-EMPTY TEXT IS A FAILURE, not a quiet success. It is
 * recorded in applied_imports with the raw text kept, so the shape that broke
 * it can be read afterwards rather than reconstructed from memory.
 */
import { all, run } from "./driver.js";
import { matchRows, dedupeKey, headerMismatch } from "./grok.js";
import { resolvePaste } from "./ingest.js";
import { GROK, COMPANY_NAMES } from "./config.generated.js";

export const SOURCES = ["grok_paste", "bot_api"];

const id = (p) => `${p}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function logImport(row) {
  await run(
    "INSERT INTO applied_imports (id, created_at, chars, parsed, stored, "
    + " updated, method, ok, raw, note) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [id("imp"), new Date().toISOString(), row.chars, row.parsed, row.stored,
     row.updated, row.method, row.ok ? 1 : 0, row.raw ?? null, row.note ?? null],
  ).catch(() => null);
}

/**
 * @param text     the pasted or pushed log
 * @param today    YYYY-MM-DD in the owner's timezone, for rows with no date
 * @param source   "grok_paste" (the box) or "bot_api" (the token route)
 * @param extract  the model fallback, injected so tests can count its calls
 * @returns {{ status: number, body: object }}
 */
export async function importApplyLog({ text, today, source = "grok_paste", extract }) {
  text = String(text || "");
  if (!text.trim()) return { status: 400, body: { error: "nothing pasted" } };
  if (!SOURCES.includes(source)) return { status: 400, body: { error: "bad source" } };

  const { rows, method, note: fallbackNote } = await resolvePaste({ text, today, extract });
  const echo = text.slice(0, GROK.echoChars);

  if (rows.length > GROK.maxRowsPerPaste) {
    // A paste that is not an apply log at all -- a whole page of HTML, or the
    // wrong clipboard -- must not become hundreds of junk rows that then have
    // to be found and removed by hand. Refuse the whole thing rather than
    // taking the first N: a truncated import looks like a complete one.
    const note = `That paste produced ${rows.length} rows, over the limit of `
      + `${GROK.maxRowsPerPaste}. Nothing was stored. If it really is that `
      + "large, send it in two halves.";
    await logImport({ chars: text.length, parsed: rows.length, stored: 0, updated: 0,
                      method: method || "none", ok: false, raw: echo, note });
    return { status: 200, body: { ok: false, stored: 0, updated: 0, note, echo } };
  }

  if (!rows.length) {
    const note = "Nothing in that text looked like an application. Expected "
      + "either pipe-delimited lines (date | channel | employer | role | "
      + "location | status | notes) or a bulleted company list."
      + (fallbackNote || "");
    await logImport({ chars: text.length, parsed: 0, stored: 0, updated: 0,
                      method: method || "none", ok: false, raw: echo, note });
    return { status: 200, body: { ok: false, stored: 0, updated: 0, note, echo } };
  }

  // A HEADER LINE THAT DISAGREES WITH HOW THE ROWS ARE READ. The rows are
  // positional; a header is skipped. When a bot writes `company | role |
  // status | source` as its header and then (correctly) writes data in the
  // positional order, the import is fine -- but when it writes the DATA in
  // its header's order, every row lands shifted: role in the employer column,
  // status in the role column. That happened for a whole wave and the banner
  // said "6 new". The row count was right and every row was wrong. The
  // mismatch is detected here and returned as a warning the caller shows,
  // and recorded on the import row, so the next person to read the table
  // knows why the channel column holds a company name.
  const header = headerMismatch(text);

  const matched = matchRows(rows, COMPANY_NAMES);

  // EXISTING ROWS KEYED THE WAY dedupeKey() KEYS THEM, read once.
  //
  // The first version asked the database `lower(employer_raw) = lower(?)`,
  // which is a LITERAL comparison -- so "Anduril" and "Anduril Industries,
  // Inc." were two applications, and the bot writes both. The unique index in
  // migration 022 is on the same literal form and stays as a coarse backstop;
  // the JUDGEMENT about what counts as the same employer lives in one place,
  // dedupeKey(), and the route has to use it rather than approximate it in
  // SQL. Caught by test_applied_db.mjs, which drives all three.
  const priorRows = await all(
    "SELECT id, employer_raw, role, status FROM applied_apps").catch(() => []);
  const prior = new Map(priorRows.map((p) => [dedupeKey(p), p]));

  let stored = 0;
  let updated = 0;
  const now = new Date().toISOString();
  for (const r of matched.rows) {
    // THE UPSERT IS BY HAND rather than ON CONFLICT, because the dedupe index
    // names expressions and an ON CONFLICT clause naming those is
    // Postgres-only syntax. The same code has to run against the local SQLite
    // file.
    const existing = prior.get(dedupeKey(r));
    if (existing) {
      // RE-IMPORTING UPDATES THE STATUS. The day's log, then the digest of the
      // same day, then quite likely the whole thing again next week; each must
      // land on the current outcome rather than pile up duplicates.
      //
      // COALESCE keeps what the richer paste already said: a digest carries
      // no channel, location or notes, so a later digest row must not blank
      // the detail an earlier pipe row supplied.
      await run(
        "UPDATE applied_apps SET status = ?, applied_date = ?, "
        + " channel = COALESCE(?, channel), location = COALESCE(?, location), "
        + " notes = COALESCE(?, notes), employer_id = COALESCE(?, employer_id), "
        + " updated_at = ? "
        + "WHERE id = ?",
        [r.status, r.applied_date, r.channel, r.location, r.notes,
         r.employer_id, now, existing.id]);
      updated++;
    } else {
      await run(
        "INSERT INTO applied_apps (id, applied_date, channel, employer_raw, "
        + " employer_id, role, location, status, notes, source, created_at) "
        + "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [id("app"), r.applied_date, r.channel, r.employer_raw, r.employer_id,
         r.role, r.location, r.status, r.notes, source, now]);
      // KEPT IN STEP WITHIN THE IMPORT. dedupeRows collapses duplicates in
      // the text, but a digest row and a log row for the same company are
      // different keys by design -- and anything that did collide would
      // otherwise be inserted twice in one request and hit the unique index.
      prior.set(dedupeKey(r), { id: "new", ...r });
      stored++;
    }
  }

  const notes = [];
  if (matched.unmatched.length) notes.push(`${matched.unmatched.length} employer(s) unmatched`);
  if (header) notes.push(`header order differs from the positional order: ${header}`);
  await logImport({
    chars: text.length, parsed: matched.rows.length, stored, updated,
    method, ok: true, raw: null, note: notes.join("; ") || null,
  });

  return {
    status: 200,
    body: {
      ok: true, stored, updated, parsed: matched.rows.length,
      format: method, unmatched: matched.unmatched,
      warning: header ? `Your header line reads "${header}" but rows are read `
        + "positionally as date | channel | employer | role | location | "
        + "status | notes. Check the rows that landed; if they are shifted, "
        + "fix the bot's column order and re-import." : null,
    },
  };
}
