/**
 * The submissions counter. Run: node test_submissions.mjs
 *
 * The week-boundary cases are the ones the owner asked for, and they are the ones
 * most likely to be wrong: Monday-to-Sunday in America/Chicago, evaluated from
 * a machine on Pacific time, across a DST change.
 */
import {
  submissionCounts, submissionLine, weekStart, dayIn,
  WEEK_TZ, SUBMITTED_STAGES, INTERVIEW_STAGES,
} from "./lib/submissions.js";
import { buildDigest } from "./lib/notify.js";

let pass = 0;
const fails = [];
const ok = (c, w) => (c ? pass++ : fails.push(w));
const eq = (g, w, what) => ok(JSON.stringify(g) === JSON.stringify(w),
  `${what}\n      got  ${JSON.stringify(g)}\n      want ${JSON.stringify(w)}`);

/* ========================= THE WEEK IS MONDAY TO SUNDAY =================== */

// 2026-09-06 is a Sunday. In a Monday-start week it belongs to the week that
// began Monday 2026-08-31 -- it is the LAST day, not the first.
eq(weekStart(new Date("2026-09-06T12:00:00-05:00")), "2026-08-31",
   "Sunday belongs to the week that began the previous Monday");
eq(weekStart(new Date("2026-09-07T12:00:00-05:00")), "2026-09-07",
   "Monday starts its own week");
eq(weekStart(new Date("2026-09-08T12:00:00-05:00")), "2026-09-07",
   "Tuesday belongs to Monday's week");
eq(weekStart(new Date("2026-09-05T12:00:00-05:00")), "2026-08-31",
   "Saturday belongs to Monday's week");

/* THE TIMEZONE IS CHICAGO, NOT THE MACHINE'S. 23:30 Pacific on Sunday is
 * already Monday in Chicago, so the week has rolled. This is the case that
 * breaks if anyone reaches for toISOString(). */
{
  const sundayLatePacific = new Date("2026-09-06T23:30:00-07:00");
  eq(dayIn(sundayLatePacific), "2026-09-07",
     "23:30 Pacific Sunday is already Monday in Chicago");
  eq(weekStart(sundayLatePacific), "2026-09-07",
     "and the week has rolled over with it");
  ok(WEEK_TZ === "America/Chicago", "the counter's timezone is Chicago");
}

/* ACROSS A DST CHANGE. US clocks go back on 2026-11-01, so the week containing
 * it is 25 hours longer than usual and naive arithmetic drifts a day. */
eq(weekStart(new Date("2026-11-03T12:00:00-06:00")), "2026-11-02",
   "the week after the clocks change still starts on its Monday");
eq(weekStart(new Date("2026-10-31T12:00:00-05:00")), "2026-10-26",
   "and the week containing the change is not shifted");

/* ==================== SEEDED ACROSS A WEEK BOUNDARY ====================== */

// Now = Wednesday 2026-09-09, so the week began Monday 2026-09-07.
const NOW = new Date("2026-09-09T12:00:00-05:00");
{
  const c = submissionCounts({
    submissions: [
      { stage: "applied", at: "2026-09-09T09:00:00-05:00" },   // today
      { stage: "applied", at: "2026-09-07T09:00:00-05:00" },   // Monday, in
      { stage: "applied", at: "2026-09-06T23:00:00-05:00" },   // Sunday, OUT
      { stage: "applied", at: "2026-08-20T09:00:00-05:00" },   // long ago, out
    ],
    now: NOW,
  });
  eq(c.weekStart, "2026-09-07", "the week began Monday");
  eq(c.thisWeek, 2, "only the two inside the week count toward it");
  eq(c.ever, 4, "but all four count toward the total");
  ok(!c.neverAny, "and the counter knows it has counted something");
}

/* THE SUNDAY EDGE, EXACTLY. A submission at 23:59 Sunday Chicago is last week;
 * one at 00:01 Monday is this week. One minute apart, different weeks. */
{
  const c = submissionCounts({
    submissions: [
      { stage: "applied", at: "2026-09-06T23:59:00-05:00" },
      { stage: "applied", at: "2026-09-07T00:01:00-05:00" },
    ],
    now: NOW,
  });
  eq(c.thisWeek, 1, "one minute either side of Monday midnight splits the weeks");
  eq(c.ever, 2, "and both still count ever");
}

/* ========================= WHAT COUNTS AS SUBMITTED ====================== */

{
  const all = [...SUBMITTED_STAGES].map((stage) => ({ stage, at: "2026-09-08T09:00:00-05:00" }));
  const c = submissionCounts({ submissions: all, now: NOW });
  eq(c.thisWeek, SUBMITTED_STAGES.size, "every submitted stage counts");

  // A REJECTION IS EVIDENCE SOMETHING WAS SUBMITTED. Excluding it would make
  // the cumulative total FALL over time, which a running total must never do.
  ok(SUBMITTED_STAGES.has("rejected") && SUBMITTED_STAGES.has("ghosted"),
     "rejected and ghosted still count as having been submitted");

  // `saved` is not an application.
  eq(submissionCounts({
    submissions: [{ stage: "saved", at: "2026-09-08T09:00:00-05:00" }], now: NOW,
  }).ever, 0, "a saved role is not a submission");
}

/* A ROW WITH NO USABLE DATE counts toward EVER and not toward the week.
 * Dropping it would understate the total; dating it would invent a fact. */
{
  const c = submissionCounts({
    submissions: [{ stage: "applied", at: null },
                  { stage: "applied", at: "not a date" }],
    now: NOW,
  });
  eq(c.ever, 2, "undated submissions still count toward the total");
  eq(c.thisWeek, 0, "but never toward a week they cannot be placed in");
}

/* ========================= INTERVIEWS ARE A STATE ======================== */

{
  const c = submissionCounts({
    interviews: [{ stage: "phone_screen" }, { stage: "interview" },
                 { stage: "final" }, { stage: "applied" }, { stage: "offer" }],
    now: NOW,
  });
  eq(c.interviews, 3, "only live conversation stages count as scheduled");
  ok(!INTERVIEW_STAGES.has("applied") && !INTERVIEW_STAGES.has("offer"),
     "applied and offer are not interviews");
}

/* ===================== ZERO MUST NOT LOOK LIKE BROKEN ==================== */

/* THE WHOLE POINT OF THE LINE, AND THE PROJECT'S #1 FAILURE CLASS. "Submitted
 * this week: 0" cannot tell a quiet week from a counter wired to nothing. */
{
  const empty = submissionCounts({ outstanding: 3, now: NOW });
  ok(empty.neverAny, "nothing ever submitted is flagged as such");
  const line = submissionLine(empty);
  ok(/none yet/.test(line) && /nothing has ever been submitted/.test(line),
     `an empty counter says so in words, got: ${line}`);
  ok(!/Submitted this week: 0/.test(line),
     "and does NOT render a bare zero, which is the ambiguous case");
  ok(/Open rolling windows unsubmitted: 3/.test(line),
     "while the other numbers still render");
  ok(/Interviews scheduled: 0/.test(line), "including a genuine zero");
}

/* A QUIET WEEK AFTER A BUSY ONE IS DIFFERENT, and reads as a real zero. */
{
  const c = submissionCounts({
    submissions: [{ stage: "applied", at: "2026-08-10T09:00:00-05:00" }],
    outstanding: 2, now: NOW,
  });
  ok(!c.neverAny, "having submitted before is not 'never'");
  const line = submissionLine(c);
  ok(/Submitted this week: 0 · 1 in total/.test(line),
     `a quiet week after a real one shows 0 and the total, got: ${line}`);
  ok(!/none yet/.test(line), "and does not claim nothing has ever happened");
}

/* A FAILED READ IS NOT A QUIET WEEK. */
{
  const line = submissionLine(null);
  ok(/not counted/i.test(line) && /missing data/i.test(line),
     "a null counter reports missing data rather than zeros");
  ok(!/Submitted this week: 0/.test(line), "and renders no number at all");
}

/* ===================== THE THREE NUMBERS ARE THREE POPULATIONS =========== */

/* Each carries its own words. "Two numbers on one row must come from one
 * population" -- these deliberately do not, so none of them shares a header. */
{
  const line = submissionLine(submissionCounts({ outstanding: 3, now: NOW }));
  ok(/this week/.test(line), "the weekly figure says it is weekly");
  ok(/Open rolling windows unsubmitted/.test(line),
     "the window figure says what it counts and does not say 'this week'");
  ok(/Interviews scheduled/.test(line), "and so does the interview figure");
  ok(line.split("·").length === 3, "three fields, three labels");
}

/* ============ IT IS AT THE TOP OF THE DIGEST, WHICH IS THE ASK ========== */

/* A mutation deleting the counter from buildDigest passed green until this
 * existed: every other assertion tested the LINE, and none tested that the
 * email actually carries it, let alone first. */
{
  const fired = [{
    key: "k", group: "board_anomaly", subject: "a board broke",
    lines: ["**Some board** — broke."],
  }];
  const counter = submissionCounts({ outstanding: 3, now: NOW });
  const mail = buildDigest({ fired, cfg: {}, counter });
  const lines = mail.text.split("\n");

  ok(/none yet/.test(lines[0]),
     `the counter is the FIRST line of the email, got: ${JSON.stringify(lines[0])}`);
  ok(lines[1] === "", "with a blank line under it, so it reads as a header");
  ok(lines[2].startsWith("- **Some board**"),
     "and the triggers follow beneath it");

  // WITHOUT a counter the email is unchanged -- a failed read must not shift
  // every other line down by two or leave an empty header.
  const bare = buildDigest({ fired, cfg: {} });
  ok(bare.text.split("\n")[0].startsWith("- **Some board**"),
     "no counter means no header, not a blank one");
}

/* IT DOES NOT MAKE A DIGEST FIRE. An email that arrives daily whether or not
 * anything happened is one that gets filtered. */
{
  const counter = submissionCounts({ outstanding: 3, now: NOW });
  eq(buildDigest({ fired: [], cfg: {}, counter }), null,
     "a counter alone does not produce an email");
}

ok(pass > 30, `the suite exercised the counter (${pass} checks)`);

console.log(fails.length
  ? `test_submissions: ${fails.length} FAILED, ${pass} passed`
  : `test_submissions: ${pass} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exit(fails.length ? 1 : 0);
