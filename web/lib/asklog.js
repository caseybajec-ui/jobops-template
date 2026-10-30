/**
 * The Ask box's log. THE ONLY TABLE THIS FEATURE MAY WRITE, and the only module
 * that may write it.
 *
 * WHY IT EXISTS AT ALL. The rule for the Ask box is "no write path to the job
 * data" — not "no writes". A spend feature you cannot see the spend on is worse
 * than an extra table, and the entire point of a 30-a-month cap is being able to
 * watch it work. So the write surface is one table, one INSERT, in one file,
 * and test_ask_isolation.py fails if anything else in the Ask path writes
 * anywhere.
 *
 * THE COUNTER IS A COUNT, NOT A STORED NUMBER. `usedThisMonth` is a COUNT(*)
 * over these rows for the calendar month. A stored integer is a second copy of
 * a fact that desyncs the first time a write fails halfway, and then the cap is
 * either unenforceable or silently wrong. Deriving it costs one query and
 * cannot drift.
 *
 * PRICES ARE SYNCHRONOUS. Every other priced row in this app went through the
 * Batch API and gets its 50% discount; an interactive question cannot, so these
 * are billed at full rate. Applying the batch discount here would under-report
 * by half — the exact failure the cost meter has already had.
 */
// ".js", not "./driver" — Next's bundler resolves the extension-less form, so a
// bare specifier looks fine forever inside the app and cannot be loaded by raw
// Node at all. That is a testability hole, not a style point: it is why
// askAvailability() could not be exercised outside a running server, and the
// Ask box shipped with a crash in POST that no test could have reached.
import { all, run } from "./driver.js";
import { capWindowStart } from "./day.js";
// The arithmetic lives in a module with no driver import so it can be unit
// tested; re-exported here so callers have one place to reach for.
import { ASK_CAP, ASK_MODEL, askCost } from "./askprice.js";

export { ASK_CAP, ASK_MODEL, askCost };

/** The calendar month this cap applies to, as an ISO instant. */
function monthStart(now = new Date()) {
  // capWindowStart(capReset, now, tz) — capReset is FIRST. This called
  // capWindowStart(now), so the Date landed in the capReset slot and was
  // stringified to "Tue Sep 02 2026 11:33:07 GMT-0700 (...)". That sorts ABOVE
  // every ISO timestamp ("T" > "2"), so it was returned as the window start and
  // the count became `WHERE asked_at >= 'Tue Sep...'` — which matches nothing.
  //
  // usedThisMonth() therefore returned 0 no matter how many rows existed: the
  // box always read "30 of 30" and THE CAP COULD NEVER FIRE. Structural test
  // rule 6 proved the cap is compared before the request is sent, which was
  // true and not enough — nothing asserted the number being compared was right.
  //
  // null, not "", because the ask cap is a CALENDAR MONTH ("resets on the 1st")
  // and must not inherit the spend meter's cap-reset date.
  return capWindowStart(null, now);
}

/**
 * How many queries this calendar month.
 *
 * Counts EVERY logged row including refusals and errors, deliberately. A query
 * that errored still assembled context and still reached the API; letting it
 * not count would make the cap a suggestion, and "retry until it works" a way
 * around it.
 */
export async function usedThisMonth(now = new Date()) {
  const rows = await all(
    "SELECT COUNT(*) n FROM ask_queries WHERE asked_at >= ?", [monthStart(now)]);
  return Number(rows?.[0]?.n || 0);
}

/**
 * How many rows of one status this calendar month.
 *
 * Reads the same table usedThisMonth() reads, so a sub-cap can never disagree
 * with the cap it sits inside -- both are a COUNT(*) over ask_queries rather
 * than a stored integer that can desync, which is the property CLAUDE.md names
 * for the Ask cap and applies just as well to a slice of it.
 */
export async function countStatusThisMonth(status, now = new Date()) {
  const rows = await all(
    "SELECT COUNT(*) n FROM ask_queries WHERE asked_at >= ? AND status = ?",
    [monthStart(now), status]);
  return Number(rows?.[0]?.n || 0);
}

/**
 * Record one query. The only write this feature performs, anywhere.
 *
 * A refused query is logged too — the cap doing its job is a fact worth being
 * able to see, and it costs nothing.
 */
export async function logAsk(row) {
  await run(
    `INSERT INTO ask_queries
       (id, asked_at, question, model, in_tok, out_tok, cache_r_tok, cost, ctx_tok, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.asked_at,
      (row.question || "").slice(0, 2000),
      row.model || ASK_MODEL,
      row.in_tok ?? null,
      row.out_tok ?? null,
      row.cache_r_tok ?? null,
      row.cost ?? null,
      row.ctx_tok ?? null,
      row.status || "ok",
    ],
  );
}

/** Month-to-date spend from Ask, for the footer meter. */
export async function askSpendThisMonth(now = new Date()) {
  const rows = await all(
    "SELECT COALESCE(SUM(cost), 0) c, COUNT(*) n FROM ask_queries WHERE asked_at >= ?",
    [monthStart(now)]);
  return { spent: Number(rows?.[0]?.c || 0), queries: Number(rows?.[0]?.n || 0) };
}
