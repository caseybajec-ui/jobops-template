/**
 * One "today", and the queue that three pages have to agree about.
 * Run: node test_day.mjs
 *
 * THE BUG THIS EXISTS FOR. app/page.js wrote `surfaced_on` using the Pacific
 * date; app/Daily.js and app/Items.js looked for it using
 * `new Date().toISOString().slice(0, 10)`, which is UTC. From 5pm Pacific
 * onwards the two disagreed, so the child surfaced that morning stopped
 * matching, both parents rendered "Nothing surfaced today", and a ladder whose
 * entire design is one-thing-per-day delivered zero — every evening.
 *
 * The same split put the Monday retro under a header reading Tuesday: the retro
 * asked Pacific, the date line asked the server, and Vercel runs in UTC.
 *
 * Nothing about either call site looked wrong. `toISOString()` is the ordinary
 * way to get a date string. It is only wrong when the value has to agree with
 * something written elsewhere — so the test is not "is this site careful", it
 * is "is there exactly one answer".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  today, daysFromToday, weekday, isMonday, longDate, weekdayName, capWindowStart,
  daysUntil, daysSince,
} from "./lib/day.js";
import { planToday } from "./lib/scheduler.js";
import { mondayRetro, computePulse, weekStart } from "./lib/pulse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ============================== ONE TODAY, NOT TWO ======================= */

// 17:34 Pacific on Monday 31 August 2026 — already Tuesday 1 September in UTC.
// This exact instant is what the audit was looking at.
const EVENING = new Date("2026-09-01T00:34:00Z");

eq(today(EVENING), "2026-08-31", "at 5:34pm Pacific it is still 31 August");
eq(EVENING.toISOString().slice(0, 10), "2026-09-01",
   "while UTC has already rolled over — the two answers that disagreed");
eq(weekdayName(EVENING), "Monday", "the weekday follows the same timezone");
eq(longDate(EVENING), "31 August 2026", "and so does the date in the header");
ok(isMonday(EVENING), "so the Monday retro is correct at that instant");

// And the reverse edge: early morning Pacific, same UTC day.
const MORNING = new Date("2026-08-31T15:00:00Z");   // 8am Pacific
eq(today(MORNING), "2026-08-31", "8am Pacific is the same day as 5:34pm Pacific");
eq(today(MORNING), today(EVENING),
   "so a task surfaced in the morning still matches in the evening");

// The retro's eligibility, across a whole week, read in Pacific.
{
  // Seven consecutive days from Monday 31 August, stepped in real time rather
  // than by pasting date strings together — the first version built
  // "2026-08-32" and produced two Mondays, which is the test being wrong
  // rather than the code.
  const days = [];
  const base = Date.parse("2026-08-31T19:00:00Z");   // noon Pacific, Monday
  for (let i = 0; i < 7; i++) {
    const t = new Date(base + i * 86400000);
    days.push([weekdayName(t), isMonday(t)]);
  }
  eq(days.map(([n]) => n),
     ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
     "seven consecutive days name themselves correctly in Pacific");
  eq(days.filter(([, m]) => m).length, 1, "exactly one of them is a Monday");
}
// Tuesday must NOT get a retro. This is the audit's A3.
{
  const tue = new Date("2026-09-01T19:00:00Z");     // noon Pacific, Tuesday
  eq(weekdayName(tue), "Tuesday", "1 September is a Tuesday in Pacific");
  const pulse = computePulse({ now: tue });
  eq(mondayRetro(pulse, [], tue), null, "and Tuesday gets no retro");
}
{
  const mon = new Date("2026-08-31T19:00:00Z");     // noon Pacific, Monday
  const pulse = computePulse({ now: mon });
  ok(mondayRetro(pulse, [], mon) !== null, "Monday does");
}
// And at the evening instant that started all this, it is STILL Monday.
{
  const pulse = computePulse({ now: EVENING });
  ok(mondayRetro(pulse, [], EVENING) !== null,
     "including at 5:34pm Pacific, when UTC already says Tuesday");
}

eq(daysFromToday(0, EVENING), "2026-08-31", "an offset of zero is today");
eq(daysFromToday(3, EVENING), "2026-09-03", "three days out crosses the month");
eq(daysFromToday(-1, EVENING), "2026-08-30", "and negative goes back");
// The clocks go back on 1 November, inside this recruiting cycle.
eq(daysFromToday(1, new Date("2026-11-01T15:00:00Z")), "2026-11-02",
   "adding a day across the DST change still advances by one date");

eq(weekStart(EVENING), "2026-08-31", "the week starts on the Pacific Monday");
eq(weekStart(new Date("2026-09-06T19:00:00Z")), "2026-08-31",
   "and a Sunday still belongs to the Monday that began it");

/* ------------------------- NOBODY REACHES FOR toISOString ANY MORE -------- */
//
// The durable half. Every site that computed a date itself was correct in
// isolation and wrong together, so the test is that they no longer exist.

{
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".next")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      const rel = path.relative(here, p).replace(/\\/g, "/");
      // day.js is where the one implementation lives; the tests may say the
      // words in order to assert about them.
      if (rel === "lib/day.js" || /^test_/.test(path.basename(rel))) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const line of src.split("\n")) {
        if (/toISOString\(\)\.slice\(0,\s*10\)/.test(line)
            && !/^\s*(\/\/|\*)/.test(line)) {
          offenders.push(`${rel}: ${line.trim().slice(0, 62)}`);
        }
      }
    }
  };
  walk(path.join(here, "lib"));
  walk(path.join(here, "app"));

  // Some are legitimately about an INSTANT rather than about "what day is it
  // for the owner": a filename stamp, an export date, echoing back a date the user
  // typed. Those are listed so the exception is explicit rather than implied.
  const ALLOWED = [
    "app/api/export/route.js",     // the export's own filename
    "app/api/people/route.js",     // validating a date the user typed
    "app/api/windows/route.js",    // same
    "lib/sf86.js",                 // "assembled on" stamp in the export
    "lib/db.js",                   // an 18-month floor, a duration not a day
    "app/PersonRow.js",            // form default, corrected by the user
    "app/TrackApplication.js",     // same
    "lib/pulse.js",                // inside weekStart, which is timezone-aware
    "app/Items.js",                // inside exampleForDay, a rotation index
  ];
  const unexpected = offenders.filter(
    (o) => !ALLOWED.some((a) => o.startsWith(a + ":")));
  eq(unexpected, [],
     "no module computes the owner's 'today' with toISOString — that is day.js's job");
}

/* --------------- NOR WITH THE OTHER SPELLING, WHICH IS THE ONE THAT HID ----
 *
 * The scan above looks for `toISOString().slice(0, 10)` and is blind to the
 * second, commoner shape of the identical bug:
 *
 *     Math.round((Date.parse(date + "T00:00:00Z") - Date.now()) / 86400000)
 *
 * which subtracts an INSTANT from midnight UTC on a date. That is a duration,
 * not a count of days, and Los Angeles being seven hours behind UTC made it
 * round DOWN for nineteen hours out of every twenty-four. It sat in FIVE
 * modules — every window countdown, both item countdowns and the contact
 * follow-up ages — while this file passed, because a guard blind to the
 * dominant spelling in the code it guards is not a guard. That is the same
 * finding as test_ci_scripts.py's regex missing `const env = {...process.env}`.
 *
 * An INSTANT minus an INSTANT is fine and is not matched: `Date.now() -
 * Date.parse(created_at)` measures an elapsed duration and is correct. What is
 * forbidden is mixing the two — a bare date string on one side of the
 * subtraction and a clock on the other.
 */
{
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".next")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      const rel = path.relative(here, p).replace(/\\/g, "/");
      if (rel === "lib/day.js" || /^test_/.test(path.basename(rel))) continue;
      // Comments are stripped rather than skipped line by line: several modules
      // now EXPLAIN this bug in prose, and a scan that fired on its own
      // documentation is one you learn to ignore — the same mistake
      // test_nothing_private_staged.py made when it matched the word
      // `postgresql://` inside CLAUDE.md.
      const src = fs.readFileSync(p, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // A date string meeting the clock, in either order.
      if (/T00:00:00Z["'`]?\s*\)?\s*\)?\s*-\s*Date\.now\(\)/.test(src)
          || /Date\.now\(\)\s*-\s*Date\.parse\([^)]*T00:00:00Z/.test(src)) {
        offenders.push(rel);
      }
    }
  };
  walk(path.join(here, "lib"));
  walk(path.join(here, "app"));
  eq(offenders, [],
     "no module counts days by subtracting a clock from a midnight-UTC date — "
     + "that is daysUntil()/daysSince() in day.js");
}

/* ------------------- AND THE COUNT ITSELF IS THE CALENDAR'S ---------------
 *
 * The durable half is the scan above; this is the behaviour, at the hours that
 * actually broke. 2026-09-30 is nineteen calendar days after 2026-09-11, and it
 * has to read nineteen at every hour of that day rather than only before dawn.
 */
{
  const CLOSE = "2026-09-30";
  for (const h of ["00", "06", "12", "17", "23"]) {
    const at = new Date(`2026-09-11T${h}:00:00-07:00`);
    eq(daysUntil(CLOSE, at), 19,
       `${h}:00 Pacific — the window is 19 calendar days out`);
  }
  // 17:00 Pacific is already tomorrow in UTC. This is the exact instant the
  // original toISOString bug turned on, and the countdown bug with it.
  eq(new Date("2026-09-11T17:00:00-07:00").toISOString().slice(0, 10), "2026-09-12",
     "…and at 17:00 Pacific the server would say it is already the 12th");

  eq(daysUntil("2026-09-11", new Date("2026-09-11T23:00:00-07:00")), 0,
     "today is zero days out, late in the evening");
  eq(daysUntil("2026-09-12", new Date("2026-09-11T23:00:00-07:00")), 1,
     "and tomorrow is one, not zero");
  eq(daysUntil("2026-09-01", new Date("2026-09-11T12:00:00-07:00")), -10,
     "a past date counts backwards");
  eq(daysSince("2026-09-01", new Date("2026-09-11T12:00:00-07:00")), 10,
     "…which is what daysSince says the other way round");
  eq(daysUntil(null), null, "no date is no count");
  eq(daysUntil("not-a-date"), null, "and neither is an unparseable one");
  // A DATE AND AN INSTANT ARE DIFFERENT THINGS, and `verified` and a check's
  // `at` arrive in both shapes. A date means the same day everywhere; an
  // instant falls on whichever calendar day it is where the owner is standing.
  eq(daysUntil("2026-09-30T14:22:01+00:00", new Date("2026-09-11T12:00:00-07:00")), 19,
     "a full timestamp is counted by the day it falls on");

  // THE ONE THAT CAUGHT THE FIRST VERSION OF THIS FUNCTION. It did
  // `String(date).slice(0, 10)`, which takes the UTC date off an instant — so a
  // window checked at 5:35pm Pacific was recorded as checked TOMORROW and came
  // back "verified -1 days ago". That is the original toISOString bug reached
  // from the other direction, inside the fix for its sibling.
  const JUST_NOW = "2026-09-12T00:35:00+00:00";          // 17:35 Pacific, 11 Sep
  eq(daysSince(JUST_NOW, new Date("2026-09-11T17:35:00-07:00")), 0,
     "something that just happened was 0 days ago, not -1");
  eq(daysUntil(JUST_NOW, new Date("2026-09-11T17:35:00-07:00")), 0,
     "…and 0 days away, not 1");
  eq(JUST_NOW.slice(0, 10), "2026-09-12",
     "…while slicing the string would have said the 12th — the whole distinction");

  // ACROSS THE DST BOUNDARY. The clocks go back on 1 November, inside this
  // recruiting cycle, and a countdown that loses or gains a day that week would
  // be blamed on anything but arithmetic.
  eq(daysUntil("2026-11-08", new Date("2026-10-30T12:00:00-07:00")), 9,
     "nine days across the 1 November change, not eight or ten");
}

/* ==================== THE LADDER KEEPS YESTERDAY'S PICK ================== */
//
// The audit's A1: Monday surfaced two children, neither was completed, and on
// Tuesday both were gone. The rule is that an uncompleted surfaced child stays
// until it is done.

const kid = (id, kind, company, extra = {}) =>
  ({ id, unit_kind: kind, unit_company: company, done: false, surfaced_on: null, ...extra });

const RANKING = ["palantir", "anduril", "saronic"];
const STALE = { "analysis-group": 8, kearney: 7, bcg: 3 };

{
  const children = [
    kid("c:analysis-group", "confirm_date", "analysis-group"),
    kid("c:kearney", "confirm_date", "kearney"),
    kid("c:bcg", "confirm_date", "bcg"),
    kid("n:palantir", "find_names", "palantir"),
    kid("n:anduril", "find_names", "anduril"),
  ];
  const counts = {};

  // DAY 1 — Monday. One of each kind is chosen.
  const d1 = planToday({ children, ranking: RANKING, contactCounts: counts,
                         windowStaleness: STALE, today: "2026-08-31" });
  eq(d1.surface.sort(), ["c:analysis-group", "n:palantir"],
     "day 1 surfaces one confirm_date and one find_names");
  // The caller writes surfaced_on for exactly those.
  for (const id of d1.surface) children.find((c) => c.id === id).surfaced_on = "2026-08-31";

  // DAY 2 — nothing was completed. THE SAME TWO MUST STILL BE THERE.
  const d2 = planToday({ children, ranking: RANKING, contactCounts: counts,
                         windowStaleness: STALE, today: "2026-09-01" });
  eq(d2.surface, [], "day 2 surfaces nothing new, because day 1's are unfinished");
  eq(d2.keep.sort(), ["c:analysis-group", "n:palantir"],
     "and keeps yesterday's two — the rule the audit found broken");
  eq(d2.reason.confirm_date, "still open from a previous day",
     "and says why, so the page can too");

  // DAY 3 — one is completed. The next rotates in; the other still stands.
  children.find((c) => c.id === "c:analysis-group").done = true;
  const d3 = planToday({ children, ranking: RANKING, contactCounts: counts,
                         windowStaleness: STALE, today: "2026-09-02" });
  eq(d3.surface, ["c:kearney"], "completing one lets the next in");
  eq(d3.keep, ["n:palantir"], "and the untouched one is still standing");
}

// A WEEKEND does not withdraw Friday's pick either.
{
  const children = [kid("c:a", "confirm_date", "analysis-group", { surfaced_on: "2026-09-04" })];
  const sat = planToday({ children, windowStaleness: STALE, today: "2026-09-05" });
  eq(sat.keep, ["c:a"], "Saturday keeps Friday's unfinished item");
  eq(sat.surface, [], "and chooses nothing new");
}

/* ============ THE COOLDOWN ORDERS THE QUEUE; IT NEVER EMPTIES IT ========= */
//
// The audit's A2: the rail said "Confirm one now", Forecast said "nothing is
// due for 6 days", Daily said "0 of 16". Two rules for one queue, cancelling.

{
  // Every window checked recently — inside the 14-day cooldown.
  const children = [
    kid("c:a", "confirm_date", "analysis-group"),
    kid("c:b", "confirm_date", "kearney"),
  ];
  const fresh = { "analysis-group": 2, kearney: 1 };
  const p = planToday({ children, windowStaleness: fresh, today: "2026-09-01" });
  eq(p.surface, ["c:a"],
     "a window is still offered even when everything was checked days ago");
  ok(/longest|oldest|checked/i.test(p.reason.confirm_date || ""),
     "and the reason names staleness as the ORDERING, not the gate");
}
{
  // Staleness decides WHICH.
  const children = [
    kid("c:new", "confirm_date", "bcg"),
    kid("c:old", "confirm_date", "analysis-group"),
  ];
  const p = planToday({ children, windowStaleness: { bcg: 1, "analysis-group": 30 },
                        today: "2026-09-01" });
  eq(p.surface, ["c:old"], "the stalest window comes first");
}

/* ------------------------------- the cap window ------------------------- */

eq(capWindowStart("2026-08-25T04:32:47+00:00", new Date("2026-08-28T19:00:00Z")),
   "2026-08-25T04:32:47+00:00",
   "inside the reset month, the window starts at the reset");
eq(capWindowStart("2026-08-25T04:32:47+00:00", new Date("2026-09-02T19:00:00Z")),
   "2026-09-01T00:00:00+00:00",
   "and in September it starts on the 1st — the cap is monthly, and did not reset");
eq(capWindowStart("2026-08-25T04:32:47+00:00", new Date("2026-12-15T19:00:00Z")),
   "2026-12-01T00:00:00+00:00", "and keeps moving, month after month");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
