/**
 * Counting words. Pure, no imports, so anything may use it.
 *
 * The page said "in 1 days", "1 windows close", "1 people known". Each one on
 * its own is a typo; together they are the thing that makes a tool read as
 * unfinished, and there were enough of them that fixing each at its call site
 * would have guaranteed the next one. So it is one function, and the rule is
 * that no count string in this app is assembled by hand any more.
 */

/** "1 day" / "2 days". Pass an explicit plural for anything irregular. */
export function plural(n, one, many = null) {
  return `${n} ${Number(n) === 1 ? one : (many || one + "s")}`;
}

/** Just the word, when the number is rendered separately (a rail row, a chip). */
export function pluralWord(n, one, many = null) {
  return Number(n) === 1 ? one : (many || one + "s");
}

/**
 * "today" / "tomorrow" / "in 3 days" / "2 days ago".
 *
 * Today and tomorrow get words rather than numbers because that is how the
 * distinction is actually read: "in 0 days" is a sentence nobody says, and the
 * whole point of the urgency scale is that the nearest step is unmistakable.
 */
export function inDays(n) {
  const d = Math.round(Number(n));
  if (!Number.isFinite(d)) return "";
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d < 0) return `${plural(-d, "day")} ago`;
  return `in ${plural(d, "day")}`;
}

/**
 * "3 of 21", with the wider population named once and only once.
 *
 * Two numbers on one row are being compared whether or not that was intended,
 * so the denominator has to be stated rather than implied — the no-date count
 * appeared twice on Daily against two different totals, and each looked correct
 * beside the other.
 */
export function outOf(n, total, noun = null, aside = null) {
  const core = `${n} of ${total}${noun ? " " + pluralWord(total, noun) : ""}`;
  return aside ? `${core} (${aside})` : core;
}
