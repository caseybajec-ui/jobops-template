/**
 * What day it is, everywhere, in the owner's timezone. Pure.
 *
 * THIS EXISTS BECAUSE THE APP HAD TWO ANSWERS AND THEY DISAGREED FOR SEVEN
 * HOURS OF EVERY DAY.
 *
 * `app/page.js` wrote `surfaced_on` using the Pacific date. `app/Daily.js` and
 * `app/Items.js` looked for it using `new Date().toISOString().slice(0, 10)`,
 * which is the UTC date. From 5pm Pacific onward UTC has already rolled over,
 * so the child surfaced that morning no longer matched, both parents rendered
 * "Nothing surfaced today", and the one-per-day ladder produced zero per day
 * every single evening.
 *
 * The same split showed the Monday retro beside a header reading Tuesday: the
 * retro asked Pacific (correctly Monday), the date line asked the SERVER, and
 * Vercel runs in UTC.
 *
 * None of the individual call sites was obviously wrong. `toISOString()` is the
 * ordinary way to get a date string, and it is right up until the moment the
 * value has to agree with something written by different code. So the fix is
 * not to be careful at each site; it is to have exactly one function and no
 * reason to reach for `toISOString` at all.
 *
 * WHY NOT THE SERVER'S CLOCK. Vercel is UTC, this laptop is Pacific, and the
 * Actions runner is UTC. A "today" that depends on which machine rendered the
 * page is not a day, it is a coincidence.
 */
import { USER_TZ } from "./constants.js";

/**
 * Today as YYYY-MM-DD, in the user's timezone.
 *
 * en-CA because its short date format IS ISO — no padding to do, no month and
 * day to get the wrong way round, and no locale surprise on a machine set to
 * something else.
 */
export function today(now = new Date(), tz = USER_TZ) {
  return now.toLocaleDateString("en-CA", { timeZone: tz });
}

/** A date `n` days from today, in the same terms. Negative goes backwards. */
export function daysFromToday(n, now = new Date(), tz = USER_TZ) {
  // Anchored to NOON of the local day rather than midnight: adding days across
  // a daylight-saving boundary from midnight can land on the previous date,
  // and the clocks go back on 1 November, inside this recruiting cycle.
  const base = new Date(`${today(now, tz)}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + n);
  return base.toISOString().slice(0, 10);
}

/**
 * How many CALENDAR DAYS from today until `date` (YYYY-MM-DD). Negative = past.
 *
 * THE SECOND SHAPE OF THE SAME BUG THIS MODULE EXISTS FOR, and it hid here for
 * longer because it does not spell `toISOString` anywhere.
 *
 * The countdown on every window was:
 *
 *     Math.round((Date.parse(closes + "T00:00:00Z") - Date.now()) / 86400000)
 *
 * which subtracts an INSTANT from MIDNIGHT UTC on the close date. That is not a
 * count of days, it is a duration, and it carries a fraction that depends on
 * what time of day you ask. Los Angeles is seven hours behind UTC, so the
 * fraction is always short of the calendar answer and rounds DOWN for most of
 * the day. Measured against a window closing 2026-09-30, asked on 2026-09-11:
 *
 *     00:00 PDT  18.71 -> 19    correct
 *     05:00 PDT  18.50 -> 19    correct
 *     06:00 PDT  18.46 -> 18    WRONG
 *     12:00 PDT  18.21 -> 18    WRONG
 *     23:00 PDT  17.75 -> 18    WRONG
 *
 * Right for five hours, wrong for nineteen — and the five are the hours the owner
 * is asleep. A deadline tracker whose countdown is short by a day is the
 * McKinsey miss in miniature: it does not fail, it just quietly says you have
 * less time than you do, and the 7/3/1 warning emails fire a day early forever
 * without anyone being able to point at what is wrong.
 *
 * THE FIX IS TO STOP MEASURING A DURATION. Both sides are anchored to midnight
 * UTC of a DATE STRING — today's date in the owner's timezone, and the target date
 * — so the subtraction is an exact whole number of days with no fraction to
 * round and no DST edge to cross. `Math.round` stays only as a guard against a
 * leap second nobody will ever see.
 */
export function daysUntil(date, now = new Date(), tz = USER_TZ) {
  const to = calendarDate(date, tz);
  if (!to) return null;
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${today(now, tz)}T00:00:00Z`))
    / 86400000);
}

/**
 * The calendar day a value falls on, for the owner.
 *
 * THE DISTINCTION THAT MATTERS, and the first version of daysUntil got it
 * wrong by doing `String(date).slice(0, 10)`:
 *
 *   "2026-09-30"                  a DATE. It is already a calendar day and
 *                                 means the same thing everywhere.
 *   "2026-09-12T00:35:00+00:00"   an INSTANT. Which calendar day it falls on
 *                                 depends on where you are standing — that one
 *                                 is still 11 September in Los Angeles.
 *
 * Slicing the second to its first ten characters gives the UTC date, which is
 * the original `toISOString().slice(0, 10)` bug arrived at from the other
 * direction: a window checked at 5:35pm Pacific came back "verified -1 days
 * ago", i.e. tomorrow. Caught by test_windows.mjs on the commit that
 * introduced it.
 */
function calendarDate(value, tz = USER_TZ) {
  if (!value) return null;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : today(new Date(t), tz);
}

/** The same count, the other way round: calendar days SINCE `date`. */
export function daysSince(date, now = new Date(), tz = USER_TZ) {
  const d = daysUntil(date, now, tz);
  return d === null ? null : -d;
}

/** The weekday, 0 = Sunday, in the user's timezone. */
export function weekday(now = new Date(), tz = USER_TZ) {
  const name = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/** Is today Monday where the owner is? The retro's whole eligibility rule. */
export function isMonday(now = new Date(), tz = USER_TZ) {
  return weekday(now, tz) === 1;
}

/** The date as the owner reads it: "1 September 2026", in his timezone. */
export function longDate(now = new Date(), tz = USER_TZ) {
  return now.toLocaleDateString("en-GB", {
    timeZone: tz, day: "numeric", month: "long", year: "numeric",
  });
}

/** "Monday". Same timezone, same instant, so it cannot disagree with longDate. */
export function weekdayName(now = new Date(), tz = USER_TZ) {
  return now.toLocaleDateString("en-GB", { timeZone: tz, weekday: "long" });
}

/**
 * The window the monthly cap actually covers.
 *
 * The cap is "$5 per MONTH" and the meter summed everything since a fixed
 * `cap_reset` date, forever — so on 1 September it was still counting August,
 * under a label reading "this month". Neither a calendar month nor a rolling
 * thirty days: a number that only ever grows.
 *
 * The window is the LATER of the cap reset and the first of the current month.
 * That keeps what the reset was for — excluding the $29.88 of pre-cap history —
 * while making the cap monthly, which is what it says it is.
 */
export function capWindowStart(capReset, now = new Date(), tz = USER_TZ) {
  // A Date in the FIRST slot means the caller used the (now, tz) convention of
  // today() rather than this function's (capReset, now, tz). That mistake does
  // not throw on its own: String(aDate) is "Tue Sep 02 2026 ..." , which sorts
  // above every ISO timestamp, so it wins the comparison below and is returned
  // as the window start — and every `WHERE asked_at >= ...` using it matches
  // nothing. It reads as "no rows this month" forever. asklog.js shipped that
  // way and the 30/month cap could never fire.
  //
  // Throwing is the point: a silent wrong window is worse than a crash, because
  // a cap that always reads zero looks exactly like a cap that is working.
  if (capReset instanceof Date) {
    throw new TypeError(
      "capWindowStart(capReset, now, tz): the FIRST argument is the cap-reset "
      + "date string, not a Date. For a plain calendar month use "
      + "capWindowStart(null, now).",
    );
  }
  const monthStart = `${today(now, tz).slice(0, 7)}-01T00:00:00+00:00`;
  const reset = String(capReset || "");
  return reset > monthStart ? reset : monthStart;
}
