/** Month-to-date spend against the hard cap, from the batch records.
 *
 * Three things have been wrong here. The first two under-reported; the third
 * over-reported, which is worse, because a red OVER CAP that is not real is a
 * meter the owner stops believing.
 *
 *  1. It opened jobs.db directly with node:sqlite. On Vercel that file does not
 *     exist, the try/catch swallowed the failure, and the meter would have
 *     rendered a confident **$0.00** on the deployed site — the number the owner
 *     checks to decide whether he can afford to score anything.
 *  2. It priced every batch from mean token shapes and ignored cache traffic
 *     entirely, which ran about 35% low.
 *  3. It read the cap-reset date from ../config.yaml at REQUEST time. That file
 *     is not in the Vercel bundle, the read threw, a bare `catch {}` swallowed
 *     it, and the fallback made every batch ever submitted count as this month:
 *     **$29.88 / $5.00 OVER CAP** deployed against $3.17 locally. See
 *     lib/genconfig.mjs, which now bakes the value in at build time.
 *
 * Now it goes through the shared driver (Postgres in production, SQLite
 * locally) and prefers the MEASURED token counts that `collect` stores. A batch
 * still in flight has none, so it falls back to the estimate and the meter says
 * so with a leading `~` rather than presenting a floor as a total.
 */
import { all } from "./driver.js";
import { once } from "./once.js";
import { capWindowStart } from "./day.js";
import { CAP_RESET, MONTHLY_CAP } from "./config.generated.js";
import { askSpendThisMonth } from "./asklog.js";

export { MONTHLY_CAP };

// Spend before the reset date is history, not a live overage — that distinction
// is the whole difference between $3.17 and $29.88.
//
// This used to read ../config.yaml here, at REQUEST time, and fall back to
// "1970-01-01" inside a bare `catch {}`. It worked locally and failed on Vercel,
// where the file is not in the bundle: the meter showed the LIFETIME total in
// red as OVER CAP on every page. lib/genconfig.mjs now bakes the value in at
// build time and fails the build if it cannot — there is no default left to fall
// back to, which is the point.

// Base $/Mtok. Cache write bills at 1.25x input, cache read at 0.10x.
// Keep in step with PRICES in score_jobs.py — two rate cards is how you get two
// different answers to "what have I spent".
const PRICES = {
  "claude-haiku-4-5": [1, 5], "claude-haiku-4-5-20251001": [1, 5],
  "claude-sonnet-5": [2, 10], "claude-opus-5": [5, 25],
};
const SHAPE = { triage: [1080, 30], score: [4100, 455] };
const BATCH = 0.5, CACHE_W = 1.25, CACHE_R = 0.1;

function costOf(b) {
  const [pin, pout] = PRICES[b.model] || [3, 15];
  if (b.in_tok != null) {
    const c = ((b.in_tok / 1e6) * pin
      + ((b.out_tok || 0) / 1e6) * pout
      + ((b.cache_w_tok || 0) / 1e6) * pin * CACHE_W
      + ((b.cache_r_tok || 0) / 1e6) * pin * CACHE_R) * BATCH;
    return [c, true];
  }
  const [tin, tout] = SHAPE[b.stage] || [2000, 300];
  const c = ((b.n * tin) / 1e6) * pin * BATCH + ((b.n * tout) / 1e6) * pout * BATCH;
  return [c, false];
}

async function _monthToDate() {
  // THE CAP IS PER MONTH AND THIS NEVER RESET. It summed everything since a
  // fixed cap_reset date, forever, under a label reading "this month" — so on
  // 1 September it was still counting August. Neither a calendar month nor a
  // rolling thirty days: a number that only grew.
  //
  // The window is the later of the reset and the first of the current month,
  // which keeps what the reset was for (excluding $29.88 of pre-cap history)
  // and makes the cap monthly, which is what it says it is.
  const since = capWindowStart(CAP_RESET);
  let spent = 0, historical = 0, measured = true;
  let rows = [];
  try {
    rows = await all(
      "SELECT stage, model, n, submitted_at, in_tok, out_tok,"
      + " cache_w_tok, cache_r_tok FROM batches");
  } catch {
    // No batches table yet. Report zero AND say it is unmeasured, so a fresh
    // database does not look like a month with no spend.
    return { spent: 0, historical: 0, since, cap: MONTHLY_CAP, measured: false };
  }
  for (const b of rows) {
    const [c, isMeasured] = costOf(b);
    if (String(b.submitted_at || "") >= since) {
      spent += c;
      measured = measured && isMeasured;
    } else {
      historical += c;
    }
  }

  // THE ASK BOX, AT SYNCHRONOUS PRICES. Every row in `batches` gets the Batch
  // API's 50% discount inside costOf, because every one of them was a batch. An
  // interactive question cannot be, so its rows live in their own table and are
  // priced at full rate there — applying the batch discount to them would
  // under-report by half, which is the exact failure this meter has already had.
  //
  // Summed here rather than shown separately because the $5 cap is a cap on
  // what this tool costs, not on what one feature of it costs. A spend the
  // footer cannot see is a spend nobody controls.
  let ask = { spent: 0, queries: 0 };
  try {
    ask = await askSpendThisMonth();
  } catch {
    // No ask_queries table yet (migration not applied). Zero is the honest
    // answer for a feature that has never run.
  }

  return {
    spent: spent + ask.spent, historical, since, cap: MONTHLY_CAP, measured,
    ask,
  };
}

/* ------------------------------------------------ once per request
 *
 * The cost meter renders in the topbar AND in Daily's rail, so it asked the
 * batches table twice on every Daily render. Same question, same answer.
 */
export const monthToDate = once(_monthToDate);
