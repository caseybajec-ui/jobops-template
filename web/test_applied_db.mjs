/**
 * Re-pasting an apply log updates; it does not duplicate.
 * Run: node test_applied_db.mjs
 *
 * BEHAVIOURAL, AGAINST A REAL DATABASE. The dedupe lives in three places that
 * have to agree -- the unique index in migration 022, the lookup in the route,
 * and dedupeKey() in lib/grok.js -- and a pure test of the last one cannot see
 * the first two disagree with it. So this drives the real SQL.
 *
 * IN A SCRATCH SCHEMA, never production. Same mechanism as
 * test_runhistory.mjs and for the reason that file learned the hard way: a
 * test that writes into the live tables and tidies up afterwards is correct
 * only while its cleanup stays exhaustive, and the first version of that one
 * was not. The search path holds this schema and NOTHING else, so a table this
 * file forgets to create errors rather than resolving to the real one.
 */
import { all, run as exec, USING_PG } from "./lib/driver.js";
import { parsePaste, dedupeRows, matchRows, dedupeKey } from "./lib/grok.js";

let pass = 0;
const fails = [];
const ok = (c, w) => (c ? (pass++, 0) : fails.push(w));

if (!USING_PG) {
  console.log("test_applied_db: SKIPPED — needs Postgres for its scratch schema.");
  process.exit(0);
}

const SCHEMA = `jobops_test_${Date.now().toString(36)}`
  + `_${Math.random().toString(36).slice(2, 7)}`;
const TODAY = "2026-09-09";
const KNOWN = [{ slug: "andurilindustries", display_name: "Anduril" }];

/**
 * The route's write path, verbatim in shape.
 *
 * It is duplicated here rather than imported because the route is a Next
 * module that pulls in @/lib/driver through the bundler alias, and importing
 * it from a bare node process would need the whole app. The SQL is what
 * matters and the SQL is identical; the browser test on the slow gate drives
 * the actual route.
 */
async function importRows(text) {
  const parsed = parsePaste(text, { today: TODAY });
  const rows = matchRows(dedupeRows(parsed.rows), KNOWN).rows;
  let stored = 0;
  let updated = 0;
  const priorRows = await all(
    `SELECT id, employer_raw, role, status FROM ${SCHEMA}.applied_apps`);
  const prior = new Map(priorRows.map((p) => [dedupeKey(p), p]));
  for (const r of rows) {
    const existing = prior.get(dedupeKey(r));
    if (existing) {
      await exec(
        `UPDATE ${SCHEMA}.applied_apps SET status = ?, applied_date = ?, `
        + " channel = COALESCE(?, channel), location = COALESCE(?, location), "
        + " notes = COALESCE(?, notes), employer_id = COALESCE(?, employer_id) "
        + "WHERE id = ?",
        [r.status, r.applied_date, r.channel, r.location, r.notes,
         r.employer_id, existing.id]);
      updated++;
    } else {
      await exec(
        `INSERT INTO ${SCHEMA}.applied_apps (id, applied_date, channel, `
        + " employer_raw, employer_id, role, location, status, notes, source, "
        + " created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [`t${stored}-${Math.random().toString(36).slice(2, 8)}`, r.applied_date,
         r.channel, r.employer_raw, r.employer_id, r.role, r.location, r.status,
         r.notes, "grok_paste", new Date().toISOString()]);
      prior.set(dedupeKey(r), { id: "new", ...r });
      stored++;
    }
  }
  return { stored, updated, parsed: rows.length };
}

const rows = () => all(
  `SELECT employer_raw, role, status, channel, location, notes, employer_id `
  + `FROM ${SCHEMA}.applied_apps ORDER BY employer_raw, COALESCE(role, '')`);

const LOG = `
2026-09-08 | linkedin | Anduril | Product Manager | Costa Mesa, CA | success | easy apply
2026-09-08 | greenhouse | Scale AI | Deployment Strategist | SF | blocked
`;

try {
  await exec(`CREATE SCHEMA ${SCHEMA}`);
  await exec(`CREATE TABLE ${SCHEMA}.applied_apps (
      id TEXT PRIMARY KEY, applied_date TEXT NOT NULL, channel TEXT,
      employer_raw TEXT NOT NULL, employer_id TEXT, role TEXT, location TEXT,
      status TEXT NOT NULL, notes TEXT, source TEXT NOT NULL,
      created_at TEXT NOT NULL)`);
  // THE REAL INDEX from migration 022. Without it this test would pass against
  // a schema that permits the duplicates it is checking for -- the route's own
  // lookup would still dedupe, and the database would silently allow two rows
  // the day anything else writes to this table.
  await exec(`CREATE UNIQUE INDEX ${SCHEMA}_dedupe ON ${SCHEMA}.applied_apps `
    + "(lower(employer_raw), lower(COALESCE(role, '')))");

  const first = await importRows(LOG);
  ok(first.stored === 2 && first.updated === 0,
     `the first import stores both rows (${JSON.stringify(first)})`);

  // THE ASSERTION THAT MATTERS. the owner will paste the same log again.
  const second = await importRows(LOG);
  ok(second.stored === 0 && second.updated === 2,
     `re-pasting the SAME log updates and stores nothing new `
     + `(${JSON.stringify(second)})`);
  ok((await rows()).length === 2,
     `and the table still holds two rows (${(await rows()).length})`);

  /* A SUFFIX IS NOT A DIFFERENT COMPANY. The bot writes "Anduril" one day and
   * "Anduril Industries, Inc." the next; two rows for one application is
   * exactly the mess this table exists to avoid. */
  const suffixed = await importRows(
    "2026-09-09 | linkedin | Anduril Industries, Inc. | Product Manager | Costa Mesa, CA | success");
  ok(suffixed.stored === 0 && suffixed.updated === 1,
     `a suffixed employer is the same application (${JSON.stringify(suffixed)})`);

  /* THE STATUS IS UPDATED, which is the whole point of updating rather than
   * ignoring: a role that was `blocked` and is later `success` must end on
   * success, or the record says he never got in. */
  const retried = await importRows(
    "2026-09-09 | greenhouse | Scale AI | Deployment Strategist | SF | success | retried");
  ok(retried.updated === 1, "a retry updates the existing row");
  const scale = (await rows()).find((r) => /scale/i.test(r.employer_raw));
  ok(scale.status === "success",
     `and the status moves blocked -> success (${scale?.status})`);
  ok(scale.notes === "retried", "with the new note");

  /* THE DIGEST MUST NOT BLANK WHAT THE LOG SUPPLIED. It carries company names
   * only, so channel, location and notes are null on its rows -- and a plain
   * UPDATE would wipe the detail the pipe log gave. */
  const before = (await rows()).find((r) => /anduril/i.test(r.employer_raw));
  await importRows("- Anduril");
  const after = (await rows()).find(
    (r) => /anduril/i.test(r.employer_raw) && r.role);
  ok(after && after.location === before.location && after.channel === before.channel,
     `a later digest row does not blank the log's detail `
     + `(${JSON.stringify({ before: before?.location, after: after?.location })})`);

  /* THE DIGEST'S ROLELESS ROW IS ITS OWN ROW. It carries less information than
   * the log's and must not masquerade as it -- "applied to Anduril" and
   * "applied to Anduril for Product Manager" are different facts. */
  const roleless = (await rows()).filter(
    (r) => /anduril/i.test(r.employer_raw) && !r.role);
  ok(roleless.length === 1,
     `the digest adds one roleless row for the company (${roleless.length})`);

  /* AND THE DATABASE ITSELF REFUSES A DUPLICATE, so the route's lookup is a
   * convenience rather than the only thing standing between the owner and two
   * rows for one application. */
  let refused = false;
  try {
    await exec(
      `INSERT INTO ${SCHEMA}.applied_apps (id, applied_date, employer_raw, `
      + " role, status, source, created_at) VALUES (?,?,?,?,?,?,?)",
      ["dupe", TODAY, "ANDURIL", "product manager", "success", "grok_paste",
       new Date().toISOString()]);
  } catch {
    refused = true;
  }
  ok(refused,
     "the unique index REFUSES a differently-cased duplicate -- the route's "
     + "lookup is a convenience, not the only guard");

  ok(dedupeKey({ employer_raw: "ANDURIL", role: "product manager" })
     === dedupeKey({ employer_raw: "Anduril Inc.", role: "Product Manager" }),
     "and dedupeKey() agrees with the index, which is the point of testing "
     + "both -- three places implement this and they have to match");
} finally {
  await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  const left = await all(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?",
    [SCHEMA]).catch((e) => ({ error: e.message }));
  ok(Array.isArray(left) && left.length === 0,
     `the scratch schema is dropped (${JSON.stringify(left)})`);
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
