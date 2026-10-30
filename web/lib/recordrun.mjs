/**
 * Record what this workflow run did. Called by the last step of daily.yml.
 *
 *   node lib/recordrun.mjs <status> <run_url>
 *
 * WHY IT EXISTS. Daily's freshness stamp is computed from the newest job row,
 * which answers "is the data fresh" and cannot answer "did this morning's run
 * fail" — a failed run leaves yesterday's data looking exactly like a run with
 * nothing new to fetch. The stamp exists to catch silent staleness, so the one
 * thing it must not do is report a failure as calm.
 *
 * NEVER FAILS THE RUN. It is the last step and it runs with `if: always()`, so
 * a problem writing this row must not turn a successful fetch into a red build.
 * It says what went wrong and exits 0.
 */
import { one, run as exec, USING_PG } from "./driver.js";
import { todayIn } from "./scheduler.js";
import { daysFromToday } from "./day.js";
import { USER_TZ } from "./constants.js";

const status = process.argv[2] || "unknown";
const url = process.argv[3] || null;
// "fetch=success,watch=failure,gate=success,score=" -- each stage's outcome
// from the workflow. EMPTY MEANS THE STEP NEVER RAN, which is how a cancelled
// run is told apart from a finished one: daily #21 was killed at the job
// timeout with scoring still blocked on a batch poll, and this step then
// recorded it in one second. Without stages that row says a run happened.
// Read by runCompleted() in notify.js.
const stages = process.argv[4] || null;
const now = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");

// APPEND-ONLY HISTORY, alongside the pointer.
//
// pipeline_status held one row, overwritten every run, so "which runs failed
// last month" had no data behind it and a run that died before this step left
// no trace at all. The pointer is kept because existing readers use it; the
// history is what makes a missing day detectable.
//
// KEYED ON THE RUN URL, which is unique per Actions run, falling back to a
// timestamp locally. Keying on the DAY would silently overwrite a re-run.
const runId = url || `local-${now}`;
const day = todayIn(USER_TZ);
try {
  await exec(
    `INSERT INTO pipeline_runs (run_id, day, finished_at, status, stages, run_url)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (run_id) DO UPDATE SET
       status = excluded.status, finished_at = excluded.finished_at,
       stages = excluded.stages`,
    [runId, day, now, status, stages, url]);
  // NINETY DAYS. Long enough to see a pattern, short enough that the table
  // never becomes a thing anyone has to think about.
  await exec("DELETE FROM pipeline_runs WHERE day < ?",
             [daysFromToday(-90)]);
} catch (e) {
  console.error(`recordrun: could not append history (${e.message})`);
}

try {
  const existing = await one("SELECT id FROM pipeline_status WHERE id = ?", ["last"]);
  if (existing) {
    await exec(
      "UPDATE pipeline_status SET status = ?, run_url = ?, finished_at = ? WHERE id = ?",
      [status, url, now, "last"]);
  } else {
    await exec(
      `INSERT INTO pipeline_status (id, status, run_url, finished_at, note)
       VALUES (?,?,?,?,?)`,
      ["last", status, url, now, null]);
  }
  console.log(`recordrun: ${status} -> ${USING_PG ? "Neon" : "local SQLite"}`);
} catch (e) {
  // Loud, and green. A failure to record the status is worth seeing in the log
  // and is not worth failing a run that otherwise worked.
  console.log(`recordrun: could not record (${e.message}). The run itself is unaffected.`);
}
process.exit(0);
