/**
 * The on-track meter. Run: node test_ontrack.mjs
 *
 * The dashboard has never said whether the owner is ahead or behind, because every
 * number on it counts what the PIPELINE found rather than what he DID. This is
 * the half he controls, and the reason it needs a test is that the failure mode
 * is silent: a meter that renders "0 of 3" when the query failed looks exactly
 * like a month with nothing in it, and only one of those is worth acting on.
 */
import { onTrackLine, targetApplications, weekOfSearch } from "./lib/ontrack.js";
import { ON_TRACK } from "./lib/config.generated.js";

let pass = 0;
const fails = [];
const ok = (c, w) => (c ? (pass++, 0) : fails.push(w));

const T = {
  applicationsPerMonth: { "09-11": 3, "01-03": 3, "04-12": 2 },
  outreachPerWeek: 5,
  repliesPerMonth: 2,
};
const SEP = new Date("2026-09-07T12:00:00Z");

/* ---- the phase table -------------------------------------------------- */

ok(targetApplications(9, T.applicationsPerMonth) === 3, "September is a 3 month");
ok(targetApplications(11, T.applicationsPerMonth) === 3, "November too");
ok(targetApplications(2, T.applicationsPerMonth) === 3, "February is defense season");
ok(targetApplications(6, T.applicationsPerMonth) === 2, "June is rolling");

/* A WRAPPING RANGE. Written the obvious way, 11-02 would match nothing under a
 * plain a<=m<=b test, and December -- the middle of the season -- would report
 * a target of zero. */
ok(targetApplications(12, { "11-02": 4 }) === 4, "a range that wraps the year end matches December");
ok(targetApplications(1, { "11-02": 4 }) === 4, "and January");
ok(targetApplications(6, { "11-02": 4 }) === null, "and not June");

/* FIRST MATCH WINS, so an overlap is resolved by config order rather than by
 * whatever order the object happens to iterate in. */
ok(targetApplications(9, { "09-09": 7, "09-11": 3 }) === 7,
   "the first matching range wins");

/* ---- the line --------------------------------------------------------- */

const behind = onTrackLine({ applications: 0, messages: 0, replies: 0 },
                           { now: SEP, targets: T });
ok(/0 of 3 applications this month/.test(behind.line), `states applications: ${behind.line}`);
ok(/0 of 5 messages this week/.test(behind.line), "states messages");
ok(/0 of 2 replies this month/.test(behind.line), "states replies");
ok(/Behind on all three\./.test(behind.line), "and names the verdict");
ok(behind.red === true, "three misses is red");
ok(behind.behind.length === 3, "and lists all three");

const partly = onTrackLine({ applications: 3, messages: 1, replies: 0 },
                           { now: SEP, targets: T });
ok(!/Behind on all three/.test(partly.line), "hitting one target drops 'all three'");
ok(/Behind on messages and replies\./.test(partly.line),
   `and names which two: ${partly.line}`);
ok(partly.red === false, "and is not red");

const met = onTrackLine({ applications: 3, messages: 5, replies: 2 },
                        { now: SEP, targets: T });
ok(!/Behind/.test(met.line), `meeting every target says nothing about being behind: ${met.line}`);
ok(met.behind.length === 0, "and lists nothing");

/* NO MOTIVATIONAL COPY, EVER. The line states counts and stops. A tool that
 * congratulates you for a week with nothing in it is one you stop believing. */
for (const r of [behind, partly, met]) {
  ok(!/keep going|great|well done|nice work|streak|you'?ve got this|progress/i
     .test(r.line), `no encouragement in: ${r.line.slice(0, 48)}`);
  ok(!/[—–]/.test(r.line), "and no em dash");
}

/* ---- a missing count is NOT a zero ------------------------------------ */
//
// "An always-empty source and an always-zero count are the same bug." A failed
// query rendering as "0 of 3" is indistinguishable from a real month with
// nothing in it, and only one of the two is worth an afternoon.

const none = onTrackLine({ applications: null, messages: null, replies: null },
                         { now: SEP, targets: T });
ok(none.red === true, "no counts at all is RED");
ok(/missing data, not a quiet month/.test(none.line),
   `and says so rather than reporting zeroes: ${none.line}`);
ok(!/0 of 3/.test(none.line), "it does not invent a zero");

const partial = onTrackLine({ applications: 2, messages: null, replies: 1 },
                            { now: SEP, targets: T });
ok(/messages unknown/.test(partial.line),
   `one unreadable count says unknown: ${partial.line}`);
ok(!/0 of 5 messages/.test(partial.line), "and is not reported as zero sent");
ok(!partial.behind.includes("messages"),
   "an unknown count is not counted as behind -- that would be a verdict on "
   + "data nobody has");

ok(onTrackLine(null) === null, "no input at all returns null");

/* ---- the week number -------------------------------------------------- */

// NOON UTC, not midnight. today() resolves to the owner's LOS ANGELES date, and
// 2026-09-07T00:00:00Z is still 2026-09-06 there -- so a midnight-UTC fixture
// silently tests the previous day. That is the bug this file is meant to catch
// in the code, so it must not be baked into the test's own dates.
ok(weekOfSearch(new Date("2026-09-07T12:00:00Z"), "2026-09-07") === 1,
   "the first day is week 1, not week 0");
ok(weekOfSearch(new Date("2026-09-13T12:00:00Z"), "2026-09-07") === 1,
   "six days later is still week 1");
ok(weekOfSearch(new Date("2026-09-14T12:00:00Z"), "2026-09-07") === 2,
   "day seven starts week 2");
ok(weekOfSearch(new Date("2026-09-01T12:00:00Z"), "2026-09-07") === null,
   "a date before the start is null, not a negative week");

// AND THE TIMEZONE ITSELF: late evening in LA is already tomorrow in UTC, and
// the week number must follow HIS calendar.
ok(weekOfSearch(new Date("2026-09-14T04:00:00Z"), "2026-09-07") === 1,
   "9pm Sunday in Los Angeles is still week 1, though UTC has rolled to Monday");

const withWeek = onTrackLine({ applications: 0, messages: 0, replies: 0 },
  { now: new Date("2026-09-07T12:00:00Z"), searchStart: "2026-01-05", targets: T });
ok(/^Week 36 of the search: /.test(withWeek.line),
   `the week number leads the line: ${withWeek.line.slice(0, 40)}`);

/* ---- the shipped targets are real ------------------------------------- */

ok(ON_TRACK && ON_TRACK.outreachPerWeek === 5,
   "the baked cadence is 5 a week, the same number CLAUDE.md and people.js use");
ok(Object.keys(ON_TRACK.applicationsPerMonth || {}).length >= 3,
   "and the phase table survived the bake");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
