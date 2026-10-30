/**
 * Numbers that might not be numbers.
 *
 * THIS EXISTS BECAUSE THE SAME BUG HAPPENED THREE TIMES IN ONE DAY.
 *
 * `Number(null)` is 0, and `Number("")` is 0, and `Number.isFinite(0)` is true.
 * So the natural-looking guard
 *
 *     const d = Number(days);
 *     if (!Number.isFinite(d)) return null;
 *
 * treats "no value" as "zero" and sails straight past. Every time, the zero
 * meant something loud:
 *
 *   urgencyOf(null) returned "today", so a window with NO close date rendered
 *   as the filled red TODAY pill — the loudest thing on the page, asserting a
 *   deadline nobody had ever read. 16 of 25 tracked windows have no date, so
 *   that was most of them.
 *
 *   graduation_year missing baked a year of 0 into the bundle, which would have
 *   reported every role as starting before he graduates.
 *
 *   windowStep(null) returned 1, which would have EMAILED him that an undated
 *   window closes tomorrow.
 *
 * Each was found by a test that happened to pass null. The fix is not to be
 * more careful; it is to stop writing the guard by hand.
 */

/**
 * A finite number, or null. Nothing else.
 *
 * null, undefined, "", whitespace, NaN, Infinity and non-numeric strings all
 * come back as null — never as 0, which is the whole point.
 */
export function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  if (typeof v === "boolean") return null;      // true is not 1 here
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A finite number inside a range, or null. */
export function numIn(v, lo, hi) {
  const n = num(v);
  if (n === null) return null;
  return n >= lo && n <= hi ? n : null;
}
