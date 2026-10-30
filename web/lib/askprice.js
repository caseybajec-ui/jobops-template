/**
 * What the Ask box costs, and how many questions it gets. Pure — no database,
 * no driver, no I/O.
 *
 * SPLIT OUT FROM asklog.js so it can be unit-tested. asklog.js imports the
 * driver, which a bare `node test_ask.mjs` cannot resolve, and the arithmetic
 * here is the part most worth testing: it is what a hard cap is enforced
 * against and what the footer reports.
 *
 * ONE RATE CARD. These numbers also live in PRICES in web/lib/cost.js and in
 * score_jobs.py. Two rate cards is how you get two answers to "what have I
 * spent" — if one moves, all three move.
 */

/** The one model this feature may use. */
export const ASK_MODEL = "claude-haiku-4-5";

/** The hard ceiling, per calendar month. Enforced in lib/ask.js. */
export const ASK_CAP = 30;

/** $/Mtok. Cache reads bill at a tenth of the input rate. */
const PRICE_IN = 1.0;
const PRICE_OUT = 5.0;
const CACHE_R = 0.1;

/**
 * What one call cost, from MEASURED usage.
 *
 * NO BATCH DISCOUNT. Every other priced row in this app went through the Batch
 * API and is halved inside cost.js; an interactive question cannot be, so these
 * bill at full rate. Halving them would under-report by exactly the factor this
 * meter has already been wrong by once.
 */
export function askCost({ in_tok = 0, out_tok = 0, cache_r_tok = 0 } = {}) {
  return (in_tok / 1e6) * PRICE_IN
       + (out_tok / 1e6) * PRICE_OUT
       + (cache_r_tok / 1e6) * PRICE_IN * CACHE_R;
}
