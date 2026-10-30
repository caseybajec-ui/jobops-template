/**
 * The run history APPENDS. Run: node test_runhistory.mjs
 *
 * BEHAVIOURAL: it runs lib/recordrun.mjs as a real process against a real
 * Postgres, and asserts two rows exist afterwards. A structural check that the
 * file contains the word INSERT would pass just as happily against the version
 * that overwrote a single row, which is the bug this replaces -- pipeline_status
 * held one row, id='last', rewritten every morning, so a run that died before
 * the record step left no trace and the next run buried it.
 *
 * IT RUNS IN A SCRATCH SCHEMA, NOT PRODUCTION.
 *
 * It used to write into the live tables and clean up after itself, and the
 * first version's cleanup was incomplete: recordrun writes pipeline_runs AND
 * the single pipeline_status row, only the first was restored, and the digest
 * then reported a fake run at example.invalid as the most recent. Restoring by
 * hand made it safe and left it FRAGILE -- correctness depended on the cleanup
 * being exhaustive, and the next table anyone adds to recordrun would silently
 * not be in it.
 *
 * So it creates its own schema, points the driver at it with JOBOPS_PG_SCHEMA,
 * and drops it at the end. The search path contains that schema and NOTHING
 * else: a table this file forgets to create ERRORS rather than quietly
 * resolving to the production one, which is the whole failure being designed
 * out. Cleanup is one DROP SCHEMA CASCADE rather than a list that has to stay
 * in step with whatever recordrun happens to write.
 *
 * On SQLite (JOBOPS_LOCAL_DB=1) there are no schemas, so it SKIPS loudly
 * rather than pretending -- a test that silently does nothing is the thing
 * this repository keeps being bitten by.
 */
import { spawnSync } from "node:child_process";
import { all, run as exec, USING_PG } from "./lib/driver.js";
import { hoursSinceCompletedRun, runCompleted, STALE_RUN_HOURS }
  from "./lib/notify.js";

let pass = 0;
const fails = [];
const ok = (c, w) => (c ? (pass++, 0) : fails.push(w));

if (!USING_PG) {
  console.log("test_runhistory: SKIPPED — this test needs Postgres for its "
    + "scratch schema, and JOBOPS_LOCAL_DB=1 points at SQLite.");
  process.exit(0);
}

// A NEW SCHEMA PER RUN. Two of these at once (a push while a hook is still
// going) must not collide, and a leftover from a killed run must not be
// adopted by the next one and read as real history.
const SCHEMA = `jobops_test_${Date.now().toString(36)}`
  + `_${Math.random().toString(36).slice(2, 7)}`;
const MARK = "https://example.invalid/test-run-history";

function record(status, url, stages) {
  const args = ["lib/recordrun.mjs", status, url];
  if (stages !== undefined) args.push(stages);
  return spawnSync(process.execPath, args,
    { cwd: import.meta.dirname, encoding: "utf8",
      env: { ...process.env, JOBOPS_DIRECT: "1", JOBOPS_PG_SCHEMA: SCHEMA } });
}

/**
 * Read back through a CHILD process, so this file's own pool keeps the default
 * search path. The parent has to stay on it: the DROP at the end, and the
 * assertion that production is clean, are both statements that must NOT be
 * redirected into the scratch schema.
 */
function query(sql) {
  const r = spawnSync(process.execPath, ["-e", `
    import("./lib/driver.js").then(async ({ all }) => {
      process.stdout.write("<<" + JSON.stringify(await all(${JSON.stringify(sql)})));
      process.exit(0);
    });`],
    { cwd: import.meta.dirname, encoding: "utf8",
      env: { ...process.env, JOBOPS_DIRECT: "1", JOBOPS_PG_SCHEMA: SCHEMA } });
  const out = (r.stdout || "");
  const at = out.indexOf("<<");
  if (at < 0) {
    throw new Error(`query returned nothing for ${sql}: ${r.stderr?.slice(0, 400)}`);
  }
  return JSON.parse(out.slice(at + 2));
}

try {
  // Created on the DEFAULT search path. These are the only statements in this
  // file that reach the production connection, and they create rather than
  // read or write anything that exists.
  await exec(`CREATE SCHEMA ${SCHEMA}`);
  await exec(`CREATE TABLE ${SCHEMA}.pipeline_runs (
      run_id TEXT PRIMARY KEY, day TEXT NOT NULL, started_at TEXT,
      finished_at TEXT, status TEXT NOT NULL, stages TEXT, error TEXT,
      run_url TEXT)`);
  await exec(`CREATE TABLE ${SCHEMA}.pipeline_status (
      id TEXT PRIMARY KEY, status TEXT, run_url TEXT, finished_at TEXT,
      note TEXT)`);

  /* THE SAFETY PROPERTY, PROVED POSITIVELY AND WITHOUT WRITING ANYTHING.
   *
   * Everything below depends on one thing: the redirected search path contains
   * this schema and NOT public. If it were `${SCHEMA}, public` the isolation
   * would be silent and partial -- tables created here would shadow the real
   * ones, and any table NOT created here would resolve straight through to
   * production, which is precisely the accident being designed out.
   *
   * So ask a redirected connection for a table that exists only in production.
   * It must ERROR. Demonstrating it the other way -- letting a write reach the
   * real tables and then cleaning up -- is how this file behaved for two days
   * and is not a thing to do on purpose. */
  let reachedProd = null;
  try {
    query("SELECT key FROM jobs LIMIT 1");
    reachedProd = true;
  } catch {
    reachedProd = false;
  }
  ok(reachedProd === false,
     "a redirected connection CANNOT see production tables -- `jobs` does not "
     + "resolve, so the search path has no public fallback and nothing "
     + "recordrun writes can land in the real schema");

  const r1 = record("success", `${MARK}/1`);
  ok(r1.status === 0, `first record exits 0 (${r1.status}) ${r1.stderr?.slice(0, 200)}`);
  const r2 = record("failure", `${MARK}/2`);
  ok(r2.status === 0, `second record exits 0 (${r2.status})`);

  const rows = query(
    "SELECT run_id, status, day FROM pipeline_runs ORDER BY run_id");

  // THE ASSERTION THAT MATTERS: two runs, two rows.
  ok(rows.length === 2,
     `two runs produced TWO rows, not one overwritten (${rows.length})`);
  ok(rows.some((r) => r.status === "success") && rows.some((r) => r.status === "failure"),
     "and both statuses survive -- the failure was not overwritten by anything");

  // THE SCHEMA IS REALLY ISOLATED. Without this, everything above passes just
  // as well while writing into production -- which is what it used to do.
  ok(rows.every((r) => String(r.run_id).startsWith(MARK)),
     "the scratch schema holds ONLY this test's rows, so no statement here is "
     + "reaching the real history");

  // A RE-RUN OF THE SAME ACTIONS RUN UPDATES, rather than duplicating. Keying
  // on the day would have overwritten a re-run; keying on the URL does not.
  const r3 = record("success", `${MARK}/2`);
  ok(r3.status === 0, "re-recording the same run id exits 0");
  const again = query(
    `SELECT run_id, status FROM pipeline_runs WHERE run_id = '${MARK}/2'`);
  ok(again.length === 1, "the same run id stays one row");
  ok(again[0].status === "success", "and its status is updated, not duplicated");

  // AND THE POINTER ROW LANDS HERE TOO. This is the table the old cleanup
  // forgot; asserting it proves the redirect covers everything recordrun
  // writes rather than only the table this file is named after.
  const ptr = query("SELECT id, status, run_url FROM pipeline_status");
  ok(ptr.length === 1 && ptr[0].id === "last",
     `pipeline_status is written here, not in production (${JSON.stringify(ptr)})`);
  ok(ptr[0].run_url === `${MARK}/2`,
     "carrying this test's run -- in production that overwrote the record of "
     + "a real one, and the digest reported example.invalid as the last run");

  /* ── A CANCELLED RUN STILL WRITES A ROW, AND MUST STILL ALERT ───────────
   *
   * daily #21. Scoring blocked on a Batch API poll for 27m49s, the job was
   * cancelled at its 30-minute timeout, and "Record the run" -- `if: always()`
   * so that it CAN report a failure -- completed green in one second and wrote
   * a row. A presence check reads that as "the pipeline ran".
   *
   * This drives the whole path for real: a spawned recordrun writes the row,
   * it is read back out of the database, and the SHIPPED runCompleted() and
   * hoursSinceCompletedRun() are asked what they make of it. Nothing here
   * reimplements the rule. */
  const r4 = record("cancelled", `${MARK}/21`,
                    "fetch=success,watch=success,gate=success,score=,deadlines=");
  ok(r4.status === 0, `a cancelled run records exits 0 (${r4.status})`);

  // EVERY COLUMN THE RULE READS. Omitting finished_at here is the same defect
  // the digest query had -- an unselected column is indistinguishable from a
  // null one -- and this file had it too.
  const written = query("SELECT run_id, day, status, stages, finished_at "
    + `FROM pipeline_runs WHERE run_id = '${MARK}/21'`)[0];
  ok(written, "the cancelled run left a row behind -- it does, and that is "
     + "exactly the problem");
  ok(written && written.status === "cancelled",
     `the row carries the cancelled status (${written?.status})`);
  ok(written && /score=(,|$)/.test(String(written.stages)),
     `and records that scoring never ran (${written?.stages})`);

  // Staleness is measured in HOURS from the last run that finished, so ask
  // what it says a day and a bit later with no completed run since.
  const later = new Date(Date.parse(String(written.finished_at).replace(" ", "T"))
                         + (STALE_RUN_HOURS + 1) * 3600000).toISOString();
  ok(hoursSinceCompletedRun([written], later) >= STALE_RUN_HOURS,
     "a run cancelled mid-stage that STILL WROTE A ROW triggers the alert -- "
     + "the silent-success failure the alert exists to catch");
  // The same row marked complete reads as no time elapsed, so the check above
  // is discriminating rather than true of any row at all.
  ok(hoursSinceCompletedRun([{ ...written, status: "success",
       stages: "fetch=success,gate=success,score=success" }],
     written.finished_at) < 1,
     "while the same row COMPLETE reads as no time elapsed at all");
  ok(runCompleted(written) === false,
     "because the row is not a completed run, whatever its presence implies");
  ok(runCompleted({ ...written, status: "success",
                    stages: "fetch=success,gate=success,score=success" }) === true,
     "while the same row with every required stage green IS complete");
} finally {
  // ONE STATEMENT, and it cannot miss a table. That is the point of the
  // schema: the old cleanup was a list of DELETEs and an UPDATE that had to
  // stay in step with whatever recordrun writes, and it had already fallen
  // behind once.
  await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  const left = await all(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name = ?",
    [SCHEMA]).catch((e) => ({ error: e.message }));
  ok(Array.isArray(left) && left.length === 0,
     `the scratch schema is dropped (${JSON.stringify(left)})`);

  // AND PRODUCTION IS UNTOUCHED. The old version wrote a fake run into the
  // real history every time the slow gate ran. This asserts it no longer can.
  const prod = await all(
    "SELECT run_id FROM pipeline_runs WHERE run_id LIKE ?", [`${MARK}%`])
    .catch((e) => ({ error: e.message }));
  ok(Array.isArray(prod) && prod.length === 0,
     `no test row reached the production history (${JSON.stringify(prod)})`);
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
