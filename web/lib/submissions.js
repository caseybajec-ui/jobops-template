/**
 * The one line that says whether the job search is actually moving.
 * Pure — no database, no network, no `node:`.
 *
 *     Submitted this week: 0 · Open rolling windows unsubmitted: 3 · Interviews scheduled: 0
 *
 * IT WILL READ ZERO, AND THAT IS THE POINT. Everything else in this tool
 * measures what the pipeline found. This measures what the owner did with it, which
 * is the only number that changes the outcome, and a zero at the top of the
 * digest is a truer statement about the search than any count of open roles.
 *
 * BUT ZERO MUST NEVER BE AMBIGUOUS. "An always-empty source and an always-zero
 * count are the same bug" — and the failure has hit this project on three
 * separate surfaces already. `Submitted this week: 0` cannot distinguish a
 * quiet week from a counter wired to nothing, so `everSubmitted` rides with it
 * and the renderer says "none yet" rather than "0" until the first one lands.
 * The day that flips to "1 this week · 4 ever" is the day the line proves
 * itself; until then it says plainly that it has never counted anything.
 *
 * THE THREE NUMBERS ARE THREE POPULATIONS AND THE LABELS SAY WHICH. "Two
 * numbers on one row must come from one population, or the row invites a
 * conclusion that is not true" — the cost meter showed lifetime spend against a
 * since-reset cap, and Companies counted every 2027 role beside only-reachable
 * ones. These three genuinely differ: one is a rolling seven days, one is a
 * current state with no time bound, one is a count of live processes. So each
 * carries its own words rather than sharing a header.
 */

/**
 * The week runs Monday to Sunday in AMERICA/CHICAGO.
 *
 * DELIBERATELY NOT `USER_TZ`, which is America/Los_Angeles and is what every
 * other date in this app uses — Daily's "today", the deadline countdowns, the
 * digest's own dedup key. the owner asked for Chicago for this counter specifically.
 *
 * The consequence is real and worth knowing rather than discovering: between
 * 22:00 and 23:59 Pacific on a Sunday, this counter has already rolled into the
 * new week while the rest of the app is still on the old day. A submission made
 * in that window counts toward the week the app has not started yet. It is two
 * hours a week and it is stated here rather than hidden.
 */
export const WEEK_TZ = "America/Chicago";

/** Stages that mean an application actually went in. */
export const SUBMITTED_STAGES = new Set([
  "applied", "oa", "phone_screen", "interview", "final", "offer",
  // `rejected` and `ghosted` are counted too: a rejection is evidence that
  // something WAS submitted, and dropping it would make the ever-count fall
  // over time, which is the one thing a cumulative total must never do.
  "rejected", "ghosted",
]);

/** Stages that mean a live conversation is scheduled or under way. */
export const INTERVIEW_STAGES = new Set(["phone_screen", "interview", "final"]);

/** YYYY-MM-DD for an instant, in the counter's timezone. */
export function dayIn(when, tz = WEEK_TZ) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA gives ISO order. Same trick lib/day.js uses, for the same reason:
  // toISOString() would answer in UTC, which is a different day for eight hours
  // out of every twenty-four.
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * The Monday on or before `now`, as YYYY-MM-DD in the counter's timezone.
 *
 * MONDAY, not "seven days ago". A rolling seven-day window would move the goal
 * every morning and never let a week be finished; "this week" is a thing you
 * can end.
 */
export function weekStart(now = new Date(), tz = WEEK_TZ) {
  const iso = dayIn(now, tz);
  if (!iso) return null;
  const name = new Date(now).toLocaleDateString("en-US",
    { timeZone: tz, weekday: "short" });
  const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
  // Sunday is the END of the week here, so it steps back six days, not zero.
  const back = idx === 0 ? 6 : idx - 1;
  const [y, m, d] = iso.split("-").map(Number);
  return _isoFromUTC(Date.UTC(y, m - 1, d) - back * 86400000);
}

/**
 * YYYY-MM-DD from a UTC millisecond value, spelled out.
 *
 * NOT `toISOString().slice(0, 10)`, which test_day.mjs forbids across the whole
 * app -- and it is right to. That call is how "today" gets computed in UTC and
 * comes out a day early for eight hours of every day in Los Angeles; it has
 * caused that bug here twice. The input to THIS function is already pure
 * calendar arithmetic on a date that was resolved in the counter's timezone
 * above, so no timezone question remains -- but a grep cannot see that, and a
 * guard with an exemption list is a guard people learn to add themselves to.
 */
function _isoFromUTC(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * The counter.
 *
 * @param submissions rows with { stage, at } — one per recorded submission
 *                    event, from applications and manual_application_events.
 * @param outstanding open rolling windows with nothing submitted, from
 *                    consultingBanner(). A CURRENT STATE, not a weekly count.
 * @param interviews  rows with { stage } currently in an interview stage.
 */
export function submissionCounts({
  submissions = [], outstanding = 0, interviews = [], now = new Date(),
} = {}) {
  const start = weekStart(now);
  let thisWeek = 0;
  let ever = 0;
  for (const s of submissions || []) {
    if (!SUBMITTED_STAGES.has(s?.stage)) continue;
    ever += 1;
    const day = dayIn(s?.at);
    // A row with no usable date counts toward EVER and not toward the week.
    // Dropping it entirely would make the cumulative total understate itself;
    // counting it this week would invent a date nobody recorded.
    if (day && day >= start) thisWeek += 1;
  }
  const scheduled = (interviews || [])
    .filter((i) => INTERVIEW_STAGES.has(i?.stage)).length;

  return {
    weekStart: start,
    thisWeek,
    ever,
    outstanding: Number(outstanding || 0),
    interviews: scheduled,
    // TRUE ONLY WHEN NOTHING HAS EVER BEEN COUNTED. The renderers branch on
    // this rather than on `thisWeek === 0`, so a genuinely quiet week after a
    // busy one still reads as a quiet week.
    neverAny: ever === 0,
  };
}

/** The line, for the digest and the dashboard. One implementation, two callers. */
export function submissionLine(c) {
  if (!c) {
    return "**Submissions: not counted.** The read failed — this is missing "
      + "data, not a quiet week.";
  }
  const submitted = c.neverAny
    // NOT "0". A bare zero here is indistinguishable from a broken counter, and
    // this line's whole job is to be believed.
    ? "Submitted this week: none yet — nothing has ever been submitted"
    : `Submitted this week: ${c.thisWeek} · ${c.ever} in total`;
  return `${submitted} · Open rolling windows unsubmitted: ${c.outstanding}`
    + ` · Interviews scheduled: ${c.interviews}`;
}
