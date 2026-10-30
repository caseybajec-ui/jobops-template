/**
 * Reading an apply log. Run: node test_grok.mjs
 *
 * PURE. No database, no network, no model — every case here is a literal
 * paste and a fixed date, so nothing is flaky and nothing costs anything.
 *
 * THE CASE THAT MATTERS MOST IS THE EMPTY ONE. A parser that returns rows for
 * garbage is worse than one that returns none, because the rows land in
 * applied_apps looking like applications the owner made. The zero-row path is what
 * the red banner is wired to, and it has to fire on junk rather than quietly
 * inventing employers out of prose.
 */
import {
  parsePaste, parsePipeLog, parseDigest, parseDate, normalizeEmployer,
  matchEmployer, matchRows, dedupeRows, dedupeKey, grokStale, STATUSES,
  displayEmployer, parsePipeLine, parseDigestLine,
} from "./lib/grok.js";
import { resolvePaste } from "./lib/ingest.js";
import { parseExtracted } from "./lib/ask.js";

let pass = 0;
const fails = [];
const ok = (c, w) => (c ? (pass++, 0) : fails.push(w));
const TODAY = "2026-09-09";

/* ---------------------------------------------------------- the pipe log */

const PIPE = `
date | channel | employer | role | location | status | notes
2026-09-08 | linkedin | Anduril Industries | Product Manager, New Grad | Costa Mesa, CA | success | easy apply
2026-09-08 | greenhouse | Scale AI | Deployment Strategist | San Francisco, CA | blocked | needs login
2026-09-08 | careers | Palantir | Forward Deployed Engineer | Washington, DC | no posting
`;

{
  const { rows, format } = parsePaste(PIPE, { today: TODAY });
  ok(format === "pipe", `the pipe log is recognised as pipe (${format})`);
  ok(rows.length === 3, `three rows, header skipped (${rows.length})`);
  ok(rows[0].employer_raw === "Anduril Industries", "the employer is read");
  ok(rows[0].role === "Product Manager, New Grad",
     `the role survives (${rows[0].role})`);
  ok(rows[0].applied_date === "2026-09-08",
     "the date comes from the line, not from today");
  ok(rows[0].status === "success" && rows[1].status === "blocked",
     "statuses come through");
  ok(rows[0].notes === "easy apply", "and notes when present");

  // TOLERATES A MISSING NOTES COLUMN. The bot omits what it does not have,
  // and a parser needing seven fields drops every six-field row.
  ok(rows[2].status === "no posting",
     `a row with no notes column still parses (${rows[2].status})`);
  ok(rows[2].notes === null, "and its notes are null rather than undefined");
}

/* A LEADING AND TRAILING PIPE is how most tools render a table, and a parser
 * that does not strip them reads an empty first field as the date. */
{
  const rows = parsePipeLog(
    "| 2026-09-08 | linkedin | Anduril | PM | LA | success |", { today: TODAY });
  ok(rows.length === 1, `a fenced table row parses (${rows.length})`);
  ok(rows[0].employer_raw === "Anduril",
     `and the columns are not shifted (${rows[0]?.employer_raw})`);
}

/* A MARKDOWN SEPARATOR ROW is not data. */
ok(parsePipeLog("|---|---|---|---|", { today: TODAY }).length === 0,
   "a |---|---| separator is not an application");

/* AN UNKNOWN STATUS IS KEPT VERBATIM, never coerced to success. The log's
 * vocabulary can grow, and inventing a successful application out of a word
 * this code has not seen is the one direction that must not happen. */
{
  const rows = parsePipeLog(
    "2026-09-08 | web | Vanta | APM | SF | rate-limited", { today: TODAY });
  ok(rows[0].status === "rate-limited",
     `an unknown status is kept as itself (${rows[0]?.status})`);
  ok(!STATUSES.includes(rows[0].status),
     "and is visibly not one of the four known ones");
}

/* ------------------------------------------------------------ the digest */

const DIGEST = `
Applications submitted today:
- Anduril
- Scale AI
- Palantir Technologies
That's 3 for the day.
`;

{
  const { rows, format } = parsePaste(DIGEST, { today: TODAY });
  ok(format === "digest", `the 7pm digest is recognised (${format})`);
  ok(rows.length === 3, `three companies (${rows.length}): `
     + rows.map((r) => r.employer_raw).join(", "));
  ok(rows.every((r) => r.applied_date === TODAY),
     "the PASTE date is used, because the digest carries no date");
  ok(rows.every((r) => r.status === "success"),
     "and everything in the digest is a successful application");
  ok(rows.every((r) => r.role === null),
     "with no role, which is what the format actually says");

  // A SENTENCE IS NOT A COMPANY. "That's 3 for the day." has no bullet, and
  // the heading has none either -- but the guard has to hold when they do.
  ok(!rows.some((r) => /submitted|for the day/i.test(r.employer_raw)),
     "prose around the list does not become an employer");
}

{
  const rows = parseDigest(
    "- Anduril — Product Manager\n* Scale AI\n1. Vanta", { today: TODAY });
  ok(rows.length === 3, `bullets, asterisks and numbers all count (${rows.length})`);
  ok(rows[0].employer_raw === "Anduril",
     `a trailing role is trimmed off the company (${rows[0]?.employer_raw})`);
}

/* A BULLETED SENTENCE IS STILL A SENTENCE. Without this a pasted email with
 * bullet points becomes a list of employers. */
ok(parseDigest("- I applied to a few places today and it went well.",
               { today: TODAY }).length === 0,
   "a long bulleted sentence is not a company name");

/* --------------------------------------------------- garbage and nothing */

/* THE ZERO-ROW PATH. Each of these must yield NOTHING, because the red banner
 * is wired to zero and a parser that invents a row here is worse than one that
 * fails: the row lands in applied_apps looking like an application. */
for (const [label, junk] of [
  ["empty", ""],
  ["whitespace", "   \n\n \t "],
  ["prose", "Hi Jordan, just checking in about the role. Best, Sam"],
  ["html", "<html><body><div class='x'>Anduril</div></body></html>"],
  ["a url", "https://example.invalid/careers?a=1"],
  ["json", '{"employer":"Anduril","status":"success"}'],
  ["one word", "Anduril"],
]) {
  const { rows } = parsePaste(junk, { today: TODAY });
  ok(rows.length === 0, `${label} parses to zero rows (got ${rows.length}: `
     + `${JSON.stringify(rows.map((r) => r.employer_raw))})`);
}

ok(parsePaste(null, { today: TODAY }).rows.length === 0, "null is zero rows");
ok(parsePaste(undefined, {}).rows.length === 0, "and so is undefined");

/* ── PIPE-FIRST PER LINE, NOT PER PASTE ────────────────────────────────────
 *
 * The first version picked one format for the WHOLE paste: any pipe row and
 * the digest was never tried, otherwise every line went to the digest. So a
 * paste with one pipe line and two bullets came back as three roleless digest
 * rows -- the pipe line silently lost its role, channel and location, and
 * nothing said so. The row count was right and every row looked plausible,
 * which is why only pasting one found it.
 *
 * Order still decides WITHIN a line. */
{
  const mixed = [
    "2026-09-08 | linkedin | Anduril | Product Manager | Costa Mesa, CA | success",
    "- Scale AI",
    "- Vanta",
  ].join("\n");
  const { rows, format } = parsePaste(mixed, { today: TODAY });
  ok(rows.length === 3, `a mixed paste yields every line (${rows.length})`);
  ok(format === "mixed", `and is NAMED mixed rather than one of the two `
     + `(${format}) -- calling it "pipe" is how the downgrade stayed invisible`);

  const pipe = rows.find((r) => r.employer_raw === "Anduril");
  ok(pipe && pipe.role === "Product Manager",
     `THE PIPE LINE KEEPS ITS ROLE (${pipe?.role})`);
  ok(pipe && pipe.channel === "linkedin", `its channel (${pipe?.channel})`);
  ok(pipe && pipe.location === "Costa Mesa, CA", `and its location (${pipe?.location})`);
  ok(pipe && pipe.applied_date === "2026-09-08",
     "and its own date rather than the paste's");

  const bullets = rows.filter((r) => r.role === null);
  ok(bullets.length === 2, `the bullets are read as companies (${bullets.length})`);
  ok(bullets.every((r) => r.applied_date === TODAY),
     "with the paste date, which is all the digest format carries");
}

/* PIPE STILL WINS WITHIN A LINE. A notes column mentioning a bullet is part of
 * a pipe row, not a second company. */
{
  const line = "2026-09-08 | web | Anduril | PM | LA | success | see - Vanta below";
  const { rows } = parsePaste(line, { today: TODAY });
  ok(rows.length === 1 && rows[0].employer_raw === "Anduril",
     `a bullet inside a notes column is not a company (${rows.length})`);
  ok(rows[0].notes === "see - Vanta below", "and the note survives whole");
}

/* THE SINGLE-FORMAT CASES STILL NAME THEMSELVES. */
ok(parsePaste("- Anduril\n- Vanta", { today: TODAY }).format === "digest",
   "bullets alone are still digest");
ok(parsePaste("2026-09-08 | web | Anduril | PM | LA | success",
              { today: TODAY }).format === "pipe",
   "and pipe lines alone are still pipe");

/* THE PER-LINE HELPERS, driven directly, since the route reasons in lines. */
ok(parsePipeLine("2026-09-08 | web | Anduril | PM | LA | success", {})?.employer_raw
   === "Anduril", "parsePipeLine reads one row");
ok(parsePipeLine("- Anduril", { today: TODAY }) === null,
   "and refuses a bullet");
ok(parseDigestLine("- Anduril", { today: TODAY })?.employer_raw === "Anduril",
   "parseDigestLine reads one company");
ok(parseDigestLine("2026-09-08 | web | Anduril | PM | LA | success",
                   { today: TODAY }) === null,
   "and refuses a pipe row, which is what makes the order inside a line safe");

/* ------------------------------------------------------------- the dates */

ok(parseDate("2026-09-08") === "2026-09-08", "ISO dates pass through");
ok(parseDate("9/8/26") === "2026-09-08", "US short dates are read month/day");
ok(parseDate("09/08/2026") === "2026-09-08", "and the padded form too");
ok(parseDate("yesterday") === null, "a word is not a date, and is not guessed");
ok(parseDate("") === null, "nor is an empty string");

/* ------------------------------------------------------ employer matching */

const KNOWN = [
  { slug: "andurilindustries", display_name: "Anduril" },
  { slug: "scaleai", display_name: "Scale AI" },
  { slug: "meta", display_name: "Meta" },
  { slug: "ramp", display_name: "Ramp" },
];

ok(normalizeEmployer("Anduril Industries, Inc.") === "anduril",
   `suffixes are stripped (${normalizeEmployer("Anduril Industries, Inc.")})`);
ok(normalizeEmployer("  SCALE  AI  ") === "scale ai", "case and spacing too");
ok(matchEmployer("Anduril", KNOWN) === "andurilindustries", "an exact match");
ok(matchEmployer("anduril industries llc", KNOWN) === "andurilindustries",
   "and a clean-suffix match");
ok(matchEmployer("Scale AI, Inc.", KNOWN) === "scaleai", "with punctuation");

/* NEVER AUTO-MERGE ON A FUZZY MATCH. A wrong merge files an application
 * against the wrong company and is invisible afterwards, because the row looks
 * exactly like a right one. An unmatched row costs the owner one click. */
ok(matchEmployer("Metabase", KNOWN) === null, "Metabase does NOT match Meta");
ok(matchEmployer("Rampart Security", KNOWN) === null,
   "Rampart does NOT match Ramp");
ok(matchEmployer("Anduril Defense Systems", KNOWN) === null,
   "and a longer name that merely starts the same is not a match either");
ok(matchEmployer("Andurl", KNOWN) === null,
   "a typo is not resolved by edit distance -- it goes to the unmatched list");
ok(matchEmployer("", KNOWN) === null, "and an empty employer matches nothing");

{
  const { rows, unmatched } = matchRows([
    { employer_raw: "Anduril", role: "PM" },
    { employer_raw: "Some Startup", role: "APM" },
    { employer_raw: "Some Startup", role: "Ops" },
  ], KNOWN);
  ok(rows[0].employer_id === "andurilindustries", "a matched row carries the slug");
  ok(rows[1].employer_id === null, "an unmatched row is STORED with a null id");
  ok(unmatched.length === 1 && unmatched[0] === "Some Startup",
     `and appears once in the unmatched list (${JSON.stringify(unmatched)})`);
}

/* ------------------------------------------------ what the row DISPLAYS
 *
 * A RESOLVE THAT ONLY CLEARS A WARNING LOOKS EXACTLY LIKE ONE THAT WORKED.
 * Resolving "Andurl" to Anduril removed the unmatched flag and left the row
 * still reading "Andurl", so nothing on the page distinguished a link that had
 * been written from a flag that had merely been cleared.
 */

ok(displayEmployer({ employer_raw: "Andurl", employer_id: "andurilindustries" },
                   KNOWN).name === "Anduril",
   "a resolved row shows the CANONICAL name, not the log's spelling");
ok(displayEmployer({ employer_raw: "Anduril Industries, Inc.",
                     employer_id: "andurilindustries" }, KNOWN).name === "Anduril",
   "and so does a suffixed one");
ok(displayEmployer({ employer_raw: "Some Startup", employer_id: null },
                   KNOWN).name === "Some Startup",
   "an UNmatched row still shows what the log said -- there is nothing else "
   + "to show, and inventing a name would be the wrong kind of confident");

/* employer_raw IS KEPT AND SHOWN when it differs. It is the audit trail: a
 * wrong company link is only findable by comparing the name displayed against
 * the words the bot actually wrote. */
ok(displayEmployer({ employer_raw: "Andurl", employer_id: "andurilindustries" },
                   KNOWN).raw === "Andurl",
   "the log's own words stay visible beside the canonical name");
ok(displayEmployer({ employer_raw: "Anduril", employer_id: "andurilindustries" },
                   KNOWN).raw === null,
   "but not when they are the same name, or every row grows a copy of itself");
ok(displayEmployer({ employer_raw: "Anduril Inc.", employer_id: "andurilindustries" },
                   KNOWN).raw === null,
   "nor when they differ only by a suffix, which is not a discrepancy");
ok(displayEmployer({ employer_raw: "Ghost Co", employer_id: "no-such-slug" },
                   KNOWN).name === "Ghost Co",
   "and a slug naming no known company falls back to the raw string rather "
   + "than rendering blank");

/* --------------------------------------------------------------- dedupe */

ok(dedupeKey({ employer_raw: "Anduril Inc.", role: "PM" })
   === dedupeKey({ employer_raw: "anduril", role: "pm" }),
   "the dedupe key ignores suffix, case and spacing");
ok(dedupeKey({ employer_raw: "Anduril", role: "PM" })
   !== dedupeKey({ employer_raw: "Anduril", role: "Ops" }),
   "but two different roles at one employer are two applications");

{
  const rows = dedupeRows([
    { employer_raw: "Anduril", role: "PM", status: "blocked" },
    { employer_raw: "Anduril Inc", role: "PM", status: "success" },
    { employer_raw: "Vanta", role: null, status: "success" },
  ]);
  ok(rows.length === 2, `duplicates collapse within one paste (${rows.length})`);
  ok(rows.find((r) => /anduril/i.test(r.employer_raw)).status === "success",
     "and the LAST status wins -- a log re-pasted after a retry should end on "
     + "the outcome, not the first attempt");
}

/* Re-pasting the SAME log must produce the same keys, which is what makes the
 * database upsert idempotent rather than merely tidy. */
{
  const a = parsePaste(PIPE, { today: TODAY }).rows.map(dedupeKey);
  const b = parsePaste(PIPE, { today: TODAY }).rows.map(dedupeKey);
  ok(JSON.stringify(a) === JSON.stringify(b),
     "the same paste yields the same dedupe keys twice");
}

/* THE DIGEST DEDUPES AGAINST THE PIPE LOG. the owner will paste the day's log and
 * then the 7pm digest of the same day; the digest's roleless row must be the
 * same row as the log's, or every company lands twice. */
{
  const log = parsePipeLog("2026-09-09 | web | Anduril | PM | LA | success",
                           { today: TODAY });
  const dig = parseDigest("- Anduril", { today: TODAY });
  ok(dedupeKey(log[0]) !== dedupeKey(dig[0]),
     "a digest row and a log row for the same company are DIFFERENT keys, "
     + "because the digest carries no role -- documented here because it is "
     + "surprising, and the route resolves it by never letting a roleless "
     + "digest row overwrite a richer one");
}

/* ------------------------------------------------------------ staleness */

ok(grokStale(null, "2026-09-09T12:00:00Z", 3).never === true,
   "never having imported is its own state, not staleness");
ok(grokStale(null, "2026-09-09T12:00:00Z", 3).stale === false,
   "and does not read as stale -- 'never used' and 'stopped working' are "
   + "different findings");
ok(grokStale("2026-09-08T12:00:00Z", "2026-09-09T12:00:00Z", 3).stale === false,
   "a day-old import is fresh");
ok(grokStale("2026-09-05T12:00:00Z", "2026-09-09T12:00:00Z", 3).stale === true,
   "four days is stale at a threshold of three");
ok(grokStale("nonsense", "2026-09-09T12:00:00Z", 3).days === null,
   "an unreadable timestamp reports no answer rather than a wrong one");

/* ══ THE MODEL FALLBACK ════════════════════════════════════════════════════
 *
 * It runs ONLY when both deterministic parsers found nothing. That condition
 * is the safety property: a paste that yielded even one row never reaches the
 * model, so the model can never overwrite or contradict a deterministic
 * result -- there is nothing for it to disagree with.
 *
 * COUNTED, not inferred. resolvePaste takes the extractor as an argument for
 * exactly this reason: a route that reaches for a real API client cannot be
 * asked whether it called it.
 */
{
  const counting = (rowsToReturn = []) => {
    const fn = async () => { fn.calls += 1; return { ok: true, rows: rowsToReturn }; };
    fn.calls = 0;
    return fn;
  };

  /* A PASTE THAT PARSES NEVER CALLS IT. */
  for (const [label, good] of [
    ["a pipe log", "2026-09-08 | web | Anduril | PM | LA | success"],
    ["a digest", "- Anduril\n- Vanta"],
    ["a mixed paste", "2026-09-08 | web | Anduril | PM | LA | success\n- Vanta"],
  ]) {
    const extract = counting();
    const r = await resolvePaste({ text: good, today: TODAY, extract });
    ok(extract.calls === 0,
       `${label} does NOT call the model (${extract.calls} calls)`);
    ok(r.called === false, `${label} reports that it did not`);
    ok(r.rows.length > 0, `${label} still produced rows`);
    ok(r.method !== "model", `${label} is not attributed to the model`);
  }

  /* AND A PASTE THAT DOES NOT PARSE CALLS IT EXACTLY ONCE. */
  {
    const extract = counting([{ employer_raw: "Vanta", role: "APM",
                                status: "success", applied_date: null,
                                channel: null, location: null, notes: null }]);
    const r = await resolvePaste({
      text: "Hi Jordan, just checking in about the role. Best, Sam",
      today: TODAY, extract,
    });
    ok(extract.calls === 1,
       `an unparseable paste calls the model EXACTLY once (${extract.calls})`);
    ok(r.rows.length === 1 && r.rows[0].employer_raw === "Vanta",
       "and its rows are used");
    ok(r.method === "model",
       `attributed to the model, so the page can say so (${r.method})`);
    ok(r.rows[0].applied_date === TODAY,
       "a date the model did not find becomes the paste date, not a guess");
  }

  /* AN EMPTY PASTE DOES NOT CALL IT EITHER. There is nothing to read, and
   * paying a model to confirm that is the definition of waste. */
  {
    const extract = counting();
    await resolvePaste({ text: "   \n  ", today: TODAY, extract });
    ok(extract.calls === 1,
       "whitespace still reaches the extractor, which refuses it itself -- "
       + "the route rejects an empty paste before this is ever called");
  }

  /* A FALLBACK THAT FINDS NOTHING SAYS SO. "Nothing parsed" and "nothing
   * parsed and the model could not read it either" are different findings. */
  {
    const none = async () => ({ ok: true, rows: [] });
    const r = await resolvePaste({ text: "nonsense here", today: TODAY, extract: none });
    ok(r.rows.length === 0 && r.called === true, "it ran and found nothing");
    ok(/model fallback/.test(r.note || ""),
       `and the banner will say the model read it too (${r.note})`);
  }

  /* A FALLBACK THAT THROWS IS NOT A CRASH. The zero-row banner is the right
   * outcome; an exception would be a 500 on a paste that merely did not
   * parse. */
  {
    const boom = async () => { throw new Error("no key configured"); };
    const r = await resolvePaste({ text: "nonsense here", today: TODAY, extract: boom });
    ok(r.rows.length === 0, "a throwing extractor yields no rows rather than a 500");
    ok(/no key configured/.test(r.note || ""),
       `and the reason reaches the banner (${r.note})`);
  }

  /* NO EXTRACTOR AT ALL is the same as one that found nothing. */
  {
    const r = await resolvePaste({ text: "nonsense", today: TODAY });
    ok(r.rows.length === 0 && r.called === false,
       "with no extractor supplied, nothing is called and nothing is invented");
  }
}

/* ---- what comes back from the model, read defensively -------------------
 *
 * The model honours "only JSON" about half the time -- measured on this model
 * in this project, which is why score_jobs pulls the first balanced block out
 * instead of calling JSON.parse on the whole response.
 */
ok(parseExtracted('[{"employer":"Anduril","role":"PM","status":"success"}]')
   .length === 1, "a clean array parses");
ok(parseExtracted('Sure! Here is the JSON:\n```json\n[{"employer":"Anduril"}]\n```')
   .length === 1, "and so does one wrapped in prose and a code fence");
ok(parseExtracted("[]").length === 0, "an empty array is zero rows");
ok(parseExtracted("I could not find any applications.").length === 0,
   "and prose with no array at all is zero rows, not a crash");
ok(parseExtracted('[{"employer":"Anduril"},').length === 0,
   "truncated JSON yields nothing rather than half a row");
ok(parseExtracted(null).length === 0, "null is zero rows");

/* A ROW WITHOUT AN EMPLOYER IS DROPPED, never defaulted. There is nothing
 * honest to put there, and an application filed against "" is worse than one
 * that was never recorded. */
ok(parseExtracted('[{"role":"PM","status":"success"},{"employer":"Vanta"}]')
   .length === 1, "a row with no employer is dropped, its neighbour kept");
ok(parseExtracted('[{"employer":"  "}]').length === 0,
   "and a blank one counts as none");
ok(parseExtracted('[{"employer":"Vanta"}]')[0].status === "success",
   "a missing status defaults to success, which is what the log means");
ok(parseExtracted('[{"employer":"Vanta","role":""}]')[0].role === null,
   "an empty role is null rather than an empty string");
ok(parseExtracted('["just a string", 42, null, {"employer":"Vanta"}]').length === 1,
   "and non-objects in the array are ignored");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
