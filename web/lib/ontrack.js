/**
 * Ahead or behind, in one line. Pure -- no database, no model.
 *
 * WHY THIS IS DIFFERENT FROM "there is no on-track score and there will not be
 * one". That rule forbids a number nobody can derive: a single 0-100 figure
 * claiming to know what on track MEANS for a job search. This is not that.
 * Every figure here is a target the owner wrote in config.yaml counted against a
 * row in a real table, and the line states both halves so the comparison is
 * visible rather than baked into a score.
 *
 * WHAT IT MEASURES IS THE HALF HE CONTROLS. Everything else on the dashboard
 * counts what the PIPELINE found -- roles fetched, roles scored, packs built.
 * None of that moves because the owner did something. Applications sent, messages
 * sent, replies received: those are his.
 *
 * NO MOTIVATIONAL COPY. No streaks, no "keep going", no congratulation for a
 * week with nothing in it. A tool that cheers you on for standing still is one
 * you stop reading, and the whole value of this line is that it can say
 * "behind on all three" flatly and be believed.
 */
import { ON_TRACK } from "./config.generated.js";
// today(), NOT toISOString(). UTC midnight is not the owner's midnight, and
// "this week" computed in UTC rolls over 7-8 hours early in Los Angeles --
// so a Sunday-evening message would count toward next week. day.js is the
// one place that knows his timezone; test_day.mjs fails any module that
// works it out for itself.
import { today } from "./day.js";

/**
 * The application target for a calendar month.
 *
 * Keys are inclusive MM-MM ranges and the FIRST match wins, so an overlapping
 * pair is resolved by config order rather than silently by object iteration.
 * A range that wraps the year end (11-02) is handled: without it, a December
 * target written the obvious way would return nothing and the meter would
 * report a target of zero in the middle of the season.
 */
export function targetApplications(month, targets = ON_TRACK.applicationsPerMonth) {
  const m = Number(month);
  for (const [range, n] of Object.entries(targets || {})) {
    const [a, b] = String(range).split("-").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const inside = a <= b ? (m >= a && m <= b) : (m >= a || m <= b);
    if (inside) return n;
  }
  return null;
}

/** Weeks since the search began, 1-based. Week 1 is the week of `from`. */
export function weekOfSearch(now, from) {
  const a = new Date(String(from).slice(0, 10) + "T00:00:00Z");
  const b = new Date(today(now) + "T00:00:00Z");
  if (Number.isNaN(a.getTime()) || b < a) return null;
  return Math.floor((b - a) / (7 * 86400000)) + 1;
}

/**
 * The line.
 *
 * @param counts { applications, messages, replies } -- real counts, this
 *        month for applications and replies, this week for messages.
 * @returns { line, behind: [...], red } or null when the inputs are missing.
 *
 * NULL, NOT ZERO, WHEN A COUNT COULD NOT BE READ. "An always-empty source and
 * an always-zero count are the same bug": a failed query rendering as "0 of 3"
 * is indistinguishable from a month with nothing in it, and the second is
 * actionable while the first is a broken tool. A missing count says so.
 */
export function onTrackLine(counts, { now = new Date(), searchStart = null,
                                      targets = ON_TRACK } = {}) {
  if (!counts) return null;
  const { applications, messages, replies } = counts;
  if (applications == null && messages == null && replies == null) {
    return {
      red: true,
      line: "On track: no counts could be read. That is missing data, not a "
        + "quiet month.",
      behind: [],
    };
  }

  // The month from HIS calendar, not UTC's. On the 1st of a month, UTC is
  // already in the new month while Los Angeles is still in the old one --
  // and the target changes between phases, so that is a wrong target for
  // seven hours a month.
  const appTarget = targetApplications(Number(today(now).slice(5, 7)),
                                       targets.applicationsPerMonth);
  const parts = [];
  const behind = [];

  const say = (got, want, unit, period) => {
    if (got == null) return `${unit} unknown`;
    if (want == null) return `${got} ${unit} ${period}`;
    if (got < want) behind.push(unit);
    return `${got} of ${want} ${unit} ${period}`;
  };

  parts.push(say(applications, appTarget, "applications", "this month"));
  parts.push(say(messages, targets.outreachPerWeek, "messages", "this week"));
  parts.push(say(replies, targets.repliesPerMonth, "replies", "this month"));

  const week = searchStart ? weekOfSearch(now, searchStart) : null;
  const head = week ? `Week ${week} of the search: ` : "";

  // THE VERDICT NAMES WHAT IS BEHIND, never a score. "Behind on all three" and
  // "behind on applications" call for different afternoons.
  let verdict = "";
  if (behind.length === 3) verdict = " Behind on all three.";
  else if (behind.length) verdict = ` Behind on ${behind.join(" and ")}.`;

  return {
    red: behind.length === 3,
    behind,
    line: head + parts.join(", ") + "." + verdict,
  };
}
