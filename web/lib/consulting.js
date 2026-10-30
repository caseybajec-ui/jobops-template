/**
 * The rolling windows that are open right now and not submitted.
 * Pure — no database, no network, no `node:`.
 *
 * WHY THESE ARE NAMED RATHER THAN DERIVED. The original owner flagged three
 * consulting firms specifically: they were open, they were rolling, and
 * nothing had been submitted. Deriving the set instead from `category:
 * consulting AND status: open` would also pull in a firm with a VERIFIED close
 * date a few days out, which is a different situation — the ordinary
 * closing_window trigger already handles that one at 7/3/1 days and handles it
 * better, because it can say the real date.
 *
 * THE PROBLEM A ROLLING WINDOW HAS IS THE OPPOSITE ONE. Its close date is a
 * historical-estimate and its own note says ROLLING — "roles close as they
 * fill". So the date is not the filter, submission order is, and a countdown
 * to an invented deadline would be the McKinsey failure again: a date nobody
 * at the firm set, rendered as though somebody had. They need a standing
 * reminder that does not pretend to know when it ends.
 *
 * THE NAMES COME FROM companies.yaml, NOT FROM HERE. The original hardcoded
 * the three firms in this file; a template cannot know which firms its owner
 * is chasing, so each deadlines entry says `rolling: true` and genconfig bakes
 * the list as ROLLING_FIRMS. Empty is a legitimate state — no rolling windows
 * tracked — and renders nothing.
 *
 * NAMED, BUT NOT TRUSTED. FIRMS is a list of names, and names drift — a firm
 * gets renamed in companies.yaml, or its window is marked closed, and a banner
 * keyed on a string it can no longer find would silently render nothing while
 * looking like it worked. So consultingBanner() reports what it could not
 * match, and the callers show that instead of pretending. An always-empty
 * source and an always-zero count are the same bug.
 */
import { ROLLING_FIRMS } from "./config.generated.js";

/**
 * Exactly the firms flagged `rolling: true`. Not a category query — see above.
 * Matched case-insensitively against `firm`, trimmed, so "EY-Parthenon" and
 * "ey-parthenon " are the same firm and a stray space in the yaml cannot
 * silently drop a row.
 */
export const FIRMS = ROLLING_FIRMS;

const norm = (s) => String(s || "").trim().toLowerCase();

/**
 * @param windows  deadline rows, already through applyChecks()
 * @param applied  Set of `firm|program` window ids that have been submitted
 *                 (windowsApplied() from lib/applications.js)
 * @param firms    the rolling firms to watch. Defaults to the baked list;
 *                 tests pass a fixture so they do not depend on the yaml.
 *
 * Returns { outstanding, submitted, missing, red, lines }.
 *   outstanding — open, not submitted. These are what turns the banner red.
 *   submitted   — matched and already in. Kept so the banner can say "1 of 3
 *                 done" rather than silently shrinking, which reads as the
 *                 feature breaking rather than as progress.
 *   missing     — named in FIRMS but not found open in the windows at all.
 *                 Surfaced, never swallowed.
 */
export function consultingBanner(windows = [], applied = new Set(), firms = FIRMS) {
  const firmSet = new Set((firms || []).map(norm));
  const rows = (windows || []).filter((w) => firmSet.has(norm(w.firm)));

  const outstanding = [];
  const submitted = [];
  for (const w of rows) {
    // `status` is the window's own state. A window marked closed is not
    // outstanding no matter what it says here — the banner must never tell the
    // owner to apply to something that has shut.
    if (w.status !== "open") continue;
    const id = `${w.firm}|${w.program}`;
    (applied.has?.(id) ? submitted : outstanding).push(w);
  }

  const seen = new Set(rows.map((w) => norm(w.firm)));
  const missing = (firms || []).filter((f) => !seen.has(norm(f)));

  // Unique tie-break on firm — the list is rendered, and a comparator that can
  // return 0 for two distinct rows reshuffles the banner between loads.
  const byFirm = (a, b) => String(a.firm).localeCompare(String(b.firm));
  outstanding.sort(byFirm);
  submitted.sort(byFirm);

  const lines = [];
  if (outstanding.length) {
    lines.push(
      `**${outstanding.map((w) => w.firm).join(", ")}** — open now, nothing `
      + `submitted. These are ROLLING: roles close as they fill, so the `
      + `submission date is the filter, not the published cutoff.`);
  }
  if (missing.length) {
    // LOUD, because the alternative is a banner that quietly stops working.
    lines.push(
      `(${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} named in `
      + `companies.yaml as rolling but no OPEN window matched there — `
      + `either the firm was renamed or its window was marked closed.)`);
  }

  return {
    outstanding,
    submitted,
    missing,
    // RED WHILE ANYTHING IS OUTSTANDING, or while a name could not be matched.
    // An unmatched name is not evidence that there is nothing to do.
    red: outstanding.length > 0 || missing.length > 0,
    lines,
  };
}
