/**
 * Neon's own monthly data-transfer figure, as a health line. Pure — no network.
 *
 * WHY IT IS HERE AT ALL. The allowance hit 100% at 11:57 pm and the first
 * anyone knew was an email from Neon. Nothing in this tool had ever printed how
 * much it moved, so the only signal was the bill — which is the same shape as
 * every other silent failure here: the number existed, nobody was shown it.
 *
 * THIS IS NEON'S NUMBER, NOT AN ESTIMATE. transfer_budget.py prices the row
 * payload this repository sends, which is useful for deciding what to fix and
 * is NOT what Neon bills — it ignores protocol overhead, TLS, and everything
 * the server sends back. Only the consumption API knows the real figure, so
 * when it cannot be read this says so rather than substituting the estimate.
 * An approximation wearing the authority of a measurement is how the deployed
 * cost meter came to read "$29.88 / $5.00 OVER CAP" against a reset cap.
 */
import { TRANSFER_ALLOWANCE_BYTES, TRANSFER_WARN_AT }
  from "./config.generated.js";

/**
 * The plan's allowance. Neon reports usage but never the limit, so nothing can
 * derive this -- it is stated in config.yaml and baked in by genconfig.
 *
 * IT WAS A CONSTANT AND THE CONSTANT WENT STALE. Hardcoded to the free tier's
 * 5 GB, it survived the upgrade to Launch on 2026-09-06 and made every figure
 * here wrong by 100x, in the dangerous direction: WARN_AT would have fired at
 * 3.5 GB and "ALLOWANCE EXHAUSTED, nothing should run against the database" at
 * 5 GB, which on Launch is 1% of the budget. The digest would have said stop
 * every morning while 99% sat unused. An alarm that is always wrong is one you
 * stop reading, and this is the line that matters the month it runs out.
 */
export const ALLOWANCE_BYTES = TRANSFER_ALLOWANCE_BYTES;

/**
 * Warn at 70%.
 *
 * Chosen from the response time, not from taste — the same rule as
 * WINDOW_HORIZON_DAYS: a threshold has to leave longer than the fix takes.
 *
 * ON LAUNCH'S 500 GB, 70% is 350 GB. At the measured post-fix rate of ~0.5
 * GB/month that is years away and the line is simply a number to glance at.
 * It earns its keep against a REGRESSION — the pre-fix fetch moved 2.3 GB a
 * month and a genuinely broken one could move gigabytes a day, where 30% of
 * headroom is still weeks. A threshold at 95% would be an alarm about
 * something already lost.
 *
 * The value is in config.yaml, not here, so it moves with the plan.
 */
export const WARN_AT = TRANSFER_WARN_AT;

const gb = (n) => (n / 1e9).toFixed(2);

/**
 * The line for the digest's pipeline-health section.
 *
 * @param usage { bytes, periodStart } from lib/neonusage.mjs, or
 *              { error, hint } when it could not be read, or null when no key
 *              is configured at all. Those three are DIFFERENT and each says so.
 */
export function transferLine(usage, { allowance = ALLOWANCE_BYTES } = {}) {
  if (!usage) {
    // NOT AN ERROR AND NOT A CLEAN BILL. No key means nobody asked.
    return {
      red: false,
      line: "**Neon transfer: not being read.** `NEON_API_KEY` is not set, so "
        + "this run has no idea how much of the allowance is gone. That is "
        + "missing data, not headroom.",
    };
  }
  if (usage.error) {
    // A FAILED READ IS RED. The one time this number matters is the month it
    // runs out, and "the API refused" must not look like "plenty left".
    return {
      red: true,
      line: `**Neon transfer: could not be read — ${usage.error}.** `
        + (usage.hint ? `${usage.hint} ` : "")
        + "Treat the allowance as unknown; it is not known to be fine.",
    };
  }

  const used = Number(usage.bytes || 0);
  const pct = used / allowance;
  const head = `Neon transfer: ${gb(used)} GB of ${gb(allowance)} GB `
    + `(${Math.round(pct * 100)}%)`
    + (usage.periodStart ? ` since ${String(usage.periodStart).slice(0, 10)}` : "");

  if (pct >= 1) {
    return {
      red: true,
      line: `**${head} — ALLOWANCE EXHAUSTED.** Compute is at risk of `
        + `suspension. Nothing should run against the database until this `
        + `resets or the plan is upgraded.`,
    };
  }
  if (pct >= WARN_AT) {
    return {
      red: true,
      line: `**${head} — over ${Math.round(WARN_AT * 100)}%.** `
        + "Check the transfer line on the fetch before running any backfill.",
    };
  }
  return { red: false, line: `${head}.` };
}
