/**
 * The Ask cap, tested by VALUE rather than by shape.
 *
 * WHY THIS EXISTS. test_ask_isolation.py rule 6 proves the cap is read and
 * compared BEFORE the request is sent. That was true the whole time the cap was
 * broken. `monthStart()` called capWindowStart(now) — whose first parameter is
 * capReset, not now — so the Date was stringified to "Tue Sep 02 2026 11:33:07
 * GMT-0700 (...)", which sorts above every ISO timestamp because "T" > "2". The
 * count query became `WHERE asked_at >= 'Tue Sep...'` and matched nothing.
 * usedThisMonth() returned 0 for every input, the box read "30 of 30" forever,
 * and the cap could not fire.
 *
 * Structure verified, value unverified. A test that asserts a comparison HAPPENS
 * says nothing about whether the thing compared is right. This one inserts rows
 * and demands the number move.
 *
 * IT WRITES TO THE REAL ask_queries TABLE, so every row it creates is marked
 * with the MARK prefix in BOTH id and question — including the row that ask()
 * logs when it refuses, which this test does not control the id of. Cleanup
 * runs in `finally`, sweeps leftovers from a crashed earlier run on the way IN,
 * and the run FAILS if the count does not return to where it started. A test
 * that silently leaves rows behind would eat the owner's 30 questions a month.
 */
// Loaded exactly as the app boots, so the key branch below depends on whether
// web/.env.local HAS the key, not on how this file happened to be invoked.
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());

import { run } from "./lib/driver.js";
import { usedThisMonth, ASK_CAP } from "./lib/asklog.js";
import { ask, askStatus } from "./lib/ask.js";
import { capWindowStart, today } from "./lib/day.js";

const MARK = "test-cap-";
let failures = 0;
let checks = 0;

function ok(label, cond, detail = "") {
  checks++;
  if (cond) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? "\n         " + detail : ""}`);
}

function abort(msg) {
  console.log(`\nABORT: ${msg}`);
  console.log("This test refuses to report success when it measured nothing.");
  process.exit(2);
}

const sweep = () => run(
  `DELETE FROM ask_queries WHERE id LIKE ? OR question LIKE ?`, [`${MARK}%`, `${MARK}%`]);

const insert = (id, askedAt) => run(
  `INSERT INTO ask_queries (id, asked_at, question, model, cost, status)
   VALUES (?, ?, ?, ?, ?, ?)`,
  [id, askedAt, `${MARK}synthetic row`, "test", 0, "ok"]);

// ---------------------------------------------------------------- preconditions
let baseline;
try {
  // Leftovers from a run that was interrupted (Ctrl-C between the inserts and
  // the finally). Swept rather than tolerated, and SAID OUT LOUD: while they sit
  // there they count against the real cap, and the box would read "0 of 30 left"
  // for reasons that have nothing to do with the owner asking questions.
  const before = await usedThisMonth(new Date());
  await sweep();
  baseline = await usedThisMonth(new Date());
  if (before !== baseline) {
    console.log(`swept ${before - baseline} leftover row(s) from an interrupted earlier run`);
  }
} catch (e) {
  abort(`the database is unreachable, so nothing could be measured: ${e.message}`);
}
if (typeof baseline !== "number" || Number.isNaN(baseline)) {
  abort(`usedThisMonth() returned ${baseline}, not a number.`);
}
console.log(`ask cap test — baseline ${baseline} row(s) this month, cap ${ASK_CAP}\n`);

try {
  // ------------------------------------------------- 1. the window's own value
  // The assertion whose absence let the bug live: not "a window was computed"
  // but "the window equals the first of this month, and sorts correctly against
  // real ISO timestamps".
  const now = new Date();
  const start = capWindowStart(null, now);
  const expected = `${today(now).slice(0, 7)}-01T00:00:00+00:00`;
  ok("capWindowStart(null, now) is the 1st of this month",
     start === expected, `got ${start}, expected ${expected}`);

  const thisMonth = `${today(now).slice(0, 7)}-15T12:00:00.000Z`;
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const lastMonth = lastMonthDate.toISOString();
  ok("an ISO timestamp from THIS month sorts >= the window", thisMonth >= start,
     `${thisMonth} >= ${start} was false`);
  ok("an ISO timestamp from LAST month sorts < the window", lastMonth < start,
     `${lastMonth} < ${start} was false`);

  // The exact regression: a Date in the capReset slot must not be accepted.
  let threw = false;
  try { capWindowStart(now); } catch { threw = true; }
  ok("capWindowStart(aDate) throws instead of returning a silent wrong window", threw);

  // ------------------------------------------------- 2. the count moves
  const three = [1, 2, 3].map((n) => `${MARK}${n}`);
  for (const id of three) await insert(id, new Date().toISOString());
  const afterThree = await usedThisMonth(new Date());
  ok("usedThisMonth() counts 3 inserted rows",
     afterThree === baseline + 3, `got ${afterThree}, expected ${baseline + 3}`);

  // ------------------------------------------------- 3. the window has a FLOOR
  // Without this, "counts everything ever" would pass test 2 and be wrong.
  await insert(`${MARK}old`, lastMonth);
  const afterOld = await usedThisMonth(new Date());
  ok("a row from LAST month is not counted",
     afterOld === baseline + 3, `got ${afterOld}, expected ${baseline + 3}`);

  // ------------------------------------------------- 4. the cap refuses AT 30
  // Both sides of the boundary, because a cap that is always true refuses at 29
  // too and would pass a one-sided check.
  const need = ASK_CAP - 1 - (baseline + 3);
  for (let i = 0; i < need; i++) await insert(`${MARK}fill${i}`, new Date().toISOString());
  const atEdge = await askStatus(new Date());
  ok(`at ${ASK_CAP - 1} used, atCap is false`,
     atEdge.used === ASK_CAP - 1 && atEdge.atCap === false,
     `used=${atEdge.used} atCap=${atEdge.atCap}`);

  await insert(`${MARK}last`, new Date().toISOString());
  const atCap = await askStatus(new Date());
  ok(`at ${ASK_CAP} used, atCap is true`,
     atCap.used === ASK_CAP && atCap.atCap === true,
     `used=${atCap.used} atCap=${atCap.atCap}`);
  ok("left never goes negative", atCap.left === 0, `left=${atCap.left}`);

  // ask() itself refuses. Only meaningful with a key present: without one it
  // returns "error" from the availability check, which sits ABOVE the cap and
  // would prove nothing about the cap. Said out loud rather than skipped
  // silently, so a keyless run cannot look like a passing cap test.
  const keyed = atCap.ready;
  if (keyed) {
    // NO CONTEXT IS PASSED, DELIBERATELY, AND IT IS A SAFETY INTERLOCK.
    //
    // A correct ask() refuses at the cap and returns before it looks at context
    // at all. A BROKEN cap means this call runs on to build a request body — and
    // with a key present that is a real, paid API call, fired by a test, at the
    // exact moment the cap is known to be broken. Omitting context guarantees it
    // dies on `context.text` first: the money is never spent, and the throw is
    // caught below and reported as the failure it is.
    //
    // Proved by the mutation run: with the bug restored, this threw at ask.js:135
    // rather than reaching fetch().
    let r, threwPastCap = false;
    try {
      r = await ask({ question: `${MARK}does the cap refuse?` });
    } catch {
      threwPastCap = true;
    }
    ok("ask() refuses at the cap, before touching context or the network",
       !threwPastCap && r?.ok === false && r?.status === "capped",
       threwPastCap
         ? "ask() ran PAST the cap check and threw building a request — the cap did not refuse"
         : `ok=${r?.ok} status=${r?.status}`);
    ok("the refusal says nothing was sent",
       !threwPastCap && /nothing was sent/i.test(r?.error || ""), `error=${r?.error}`);
  } else {
    console.log("  --   ask() refusal NOT exercised: no JOBOPS_ANTHROPIC_KEY, so");
    console.log("       availability refuses above the cap. askStatus above still checked.");
  }
} finally {
  // -------------------------------------------------------------- cleanup
  await sweep();
  const restored = await usedThisMonth(new Date());
  if (restored !== baseline) {
    console.log(`\nFAIL cleanup: count is ${restored}, was ${baseline} before the run.`);
    console.log(`     Rows marked "${MARK}" may remain and are eating the monthly cap.`);
    process.exit(1);
  }
  console.log(`\ncleanup ok — back to ${restored} row(s), the state before the run`);
}

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
