/**
 * The cold-start retry. Run: node test_coldstart.mjs
 *
 * WHAT IT IS FOR. Neon scales compute to zero when idle — which is what keeps
 * the free tier free and stays on — so the first connection after a quiet spell
 * waits for a wake that takes a few seconds. Two Neon-touching tests failed
 * inside the pre-commit hook and passed standalone seconds later, which is
 * exactly what that looks like from the outside: intermittent, unreproducible,
 * and easy to blame on whichever test happened to run first.
 *
 * WHY THIS IS INJECTED RATHER THAN MEASURED AGAINST A REAL SUSPEND. Suspending
 * the compute needs a Neon API key with endpoint permissions, which lives in
 * GitHub secrets and not on this machine. A real cold start is the better test
 * and should be run by hand once; this one proves the retry LOGIC is live, which
 * a real suspend cannot do on its own — a run that happens to succeed first time
 * tells you nothing about the retry.
 *
 * It exercises the predicate and the retry count directly, with no database.
 */
import {
  isColdStartError, RETRY_ON_COLD_START, _resetWarm,
} from "./lib/driver.js";

let pass = 0;
const fails = [];
const ok = (c, w) => (c ? pass++ : fails.push(w));

/* ============ WHAT COUNTS AS A COLD START, AND WHAT DOES NOT ============= */

// The shapes Neon and node actually produce while compute is waking.
for (const m of [
  "Connection terminated due to connection timeout",
  "connect ETIMEDOUT 10.0.0.1:5432",
  "connect ECONNREFUSED 10.0.0.1:5432",
  "getaddrinfo ENOTFOUND ep-x.neon.tech",
  "read ECONNRESET",
  "Client has encountered a connection error",
  "socket hang up",
]) {
  ok(isColdStartError(new Error(m)), `treated as a cold start: ${m}`);
}

// AND WHAT MUST NOT BE. A query that is wrong will not be right the second
// time, and retrying it turns a clear message into a slow one.
for (const m of [
  'syntax error at or near "selct"',
  'column "blockers" does not exist',
  "duplicate key value violates unique constraint",
  "permission denied for table jobs",
  "null value in column violates not-null constraint",
]) {
  ok(!isColdStartError(new Error(m)), `NOT retried: ${m}`);
}

ok(!isColdStartError(null), "a null error is not a cold start");
ok(!isColdStartError(undefined), "nor is undefined");

/* ===================== IT RETRIES ONCE, AND ONLY ONCE ==================== */

/* A first query that fails on the transport is retried; the retry's result is
 * returned. This is the whole behaviour, so it is asserted rather than assumed
 * from the code reading correctly. */
{
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("Connection terminated due to connection timeout");
    return { rows: [{ n: 1 }] };
  };
  const r = await RETRY_ON_COLD_START(flaky);
  ok(calls === 2, `retried exactly once, got ${calls} calls`);
  ok(r.rows[0].n === 1, "and returned the retry's result");
}

/* A SECOND failure gives up rather than looping. An unbounded retry against a
 * database that is genuinely down is a cron step that never returns. */
{
  // RESET FIRST. `_warm` is per-process and the block above just warmed it --
  // which is the guard working, not a bug: once a process has talked to the
  // database successfully, a later failure is a real failure and not a cold
  // start. The first version of this test failed here for exactly that reason.
  _resetWarm();
  let calls = 0;
  const dead = async () => { calls += 1; throw new Error("connect ETIMEDOUT"); };
  let threw = null;
  try { await RETRY_ON_COLD_START(dead); } catch (e) { threw = e; }
  ok(calls === 2, `gave up after two attempts, got ${calls}`);
  ok(threw !== null, "and rethrew rather than swallowing it");
}

/* A NON-TRANSPORT ERROR IS NOT RETRIED AT ALL. */
{
  _resetWarm();
  let calls = 0;
  const wrong = async () => { calls += 1; throw new Error('syntax error at or near "x"'); };
  try { await RETRY_ON_COLD_START(wrong); } catch { /* expected */ }
  ok(calls === 1, `a syntax error is tried once, got ${calls}`);
}

/* A QUERY THAT SUCCEEDS IS NOT RETRIED, which sounds obvious and is the case
 * that would silently double every write if it were wrong. */
{
  let calls = 0;
  const fine = async () => { calls += 1; return { rows: [] }; };
  await RETRY_ON_COLD_START(fine);
  ok(calls === 1, "a successful query runs exactly once");
}

/* A WARM PROCESS DOES NOT RETRY. Once a query has succeeded, a later transport
 * failure is a real failure -- the database went away mid-session -- and
 * retrying it would hide that behind a delay. This is the behaviour that made
 * the second block above fail until it reset. */
{
  _resetWarm();
  await RETRY_ON_COLD_START(async () => ({ rows: [] }));   // warm it
  let calls = 0;
  const dies = async () => { calls += 1; throw new Error("connect ETIMEDOUT"); };
  try { await RETRY_ON_COLD_START(dies); } catch { /* expected */ }
  ok(calls === 1, `a warm process does not retry, got ${calls} calls`);
}

ok(pass > 15, `the suite exercised the retry (${pass} checks)`);

console.log(fails.length
  ? `test_coldstart: ${fails.length} FAILED, ${pass} passed`
  : `test_coldstart: ${pass} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
