/**
 * Tests for folding recorded checks over companies.yaml. Run: node test_windows.mjs
 *
 * The bug this closes: the ladder named the same firm every morning and there
 * was no way to say "I looked, there is still no date". A nag you cannot answer
 * is one you learn to skip, which is the exact failure the Daily redesign exists
 * to fix — so the answer has to actually move the queue, and that is what is
 * asserted here.
 *
 * applyChecks is pure so this needs no database. It does read the clock, so
 * every fixture is expressed as an offset from now rather than as a fixed date.
 */
import { applyChecks, undatedWindows, WINDOW_HORIZON_DAYS } from "./lib/deadlines.js";
import { windowKey } from "./lib/display.js";
import { daysUntil, daysFromToday } from "./lib/day.js";

let pass = 0;
const fails = [];
const is = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? pass++
    : fails.push(`${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
const ok = (cond, what) => is(!!cond, true, what);

const iso = (days) => new Date(Date.now() + days * 86400000).toISOString();

// FIXTURE DATES AND THE COUNTDOWN BOTH COME FROM day.js, and they have to: this
// file used to build dates off a UTC instant and then check them with its own
// copy of the implementation's arithmetic —
//
//   const daysUntil = (d) => Math.round((Date.parse(d + "T00:00:00Z") - Date.now()) / 86400000);
//
// — so it agreed with the code by reproducing the code's bug, and recorded the
// symptom as expected behaviour in a comment: "a date 20 calendar days out
// reads 19 when it is late in the day". It does not. It is 20 days out at every
// hour of the day, and reading 19 for nineteen hours out of twenty-four is the
// off-by-one that made every window countdown short by a day.
//
// A test helper that re-implements the thing under test can only ever confirm
// that the code does what the code does.
const day = (days) => daysFromToday(days);

const OW = {
  firm: "Oliver Wyman", program: "Consultant, undergraduate", status: "unconfirmed",
  closes: null, closeIn: null, confidence: "historical-estimate",
  verified: day(-30), verifiedAgo: 30, stale: true, urgent: false,
};
const KEARNEY = {
  firm: "Kearney", program: "Business Analyst, undergraduate", status: "unconfirmed",
  closes: null, closeIn: null, confidence: "historical-estimate",
  verified: day(-3), verifiedAgo: 3, stale: false, urgent: false,
};
const CLOSED = {
  firm: "McKinsey", program: "BA", status: "closed", closes: day(-17), closeIn: -17,
  confidence: "secondary-source", verified: day(-3), verifiedAgo: 3,
};

// ------------------------------------------------------- nothing recorded yet
is(applyChecks([OW, KEARNEY], new Map()), [OW, KEARNEY],
   "with no checks recorded, the yaml passes through untouched");
is(undatedWindows([OW, KEARNEY]).map((d) => d.firm), ["Oliver Wyman", "Kearney"],
   "least-recently-checked first: 30 days beats 3");

// --------------------------------------- a check with NO date: recency only
{
  const checks = new Map([[windowKey(OW), { at: iso(0), closes: null }]]);
  const [ow] = applyChecks([OW], checks);
  is(ow.verifiedAgo, 0, "checking it resets how long ago it was looked at");
  is(ow.closes, null, "and invents no date");
  is(ow.confidence, "historical-estimate",
     "'I looked, there is still nothing' must never become 'confirmed'");
  is(ow.status, "unconfirmed", "nor does it open a window that nobody has opened");
  is(ow.stale, false, "it is no longer stale");
  ok(ow.checkedByHand, "and the page can say a human looked");

  // The point of the whole feature: answering moves it to the back of the queue.
  const after = applyChecks([OW, KEARNEY], checks);
  is(undatedWindows(after).map((d) => d.firm), ["Kearney", "Oliver Wyman"],
     "the window you just checked drops behind the one you have not");
}

// ------------------------------------------- a check WITH a date: verified
{
  const found = day(20);
  const checks = new Map([[windowKey(OW), { at: iso(0), closes: found }]]);
  const [ow] = applyChecks([OW], checks);
  is(ow.closes, found, "the date you found is the date the page shows");
  is(ow.closeIn, daysUntil(found), "and the countdown follows from it");
  is(ow.confidence, "verified",
     "a date read off the firm's own site is what `verified` means here");
  is(ow.status, "open", "an unconfirmed window with a real date is an open one");
  // EXACTLY 20, AT EVERY HOUR. This used to read `>= 19 && <= 20` — "19 or 20
  // depending on the hour" — which is a test written to accept a bug it had
  // noticed. A countdown that depends on what time you look at it is the defect,
  // not a tolerance to allow for.
  is(ow.closeIn, 20, "a date 20 days out counts 20, whatever the hour");
  is(ow.urgent, true, `about 20 days is inside the ${WINDOW_HORIZON_DAYS}-day horizon`);
  is(undatedWindows([ow]).length, 0, "and it leaves the undated queue for good");
}

// A date outside the horizon is still a date — it just is not urgent.
{
  const checks = new Map([[windowKey(OW), { at: iso(0), closes: day(120) }]]);
  const [ow] = applyChecks([OW], checks);
  is(ow.urgent, false, "120 days out is not time-critical");
  is(ow.closeIn, daysUntil(day(120)), "but the day count is still shown");
}

// ---------------------------------------------------------------- boundaries
{
  // A check on one window must not touch another.
  const checks = new Map([[windowKey(OW), { at: iso(0), closes: day(20) }]]);
  const [, kearney] = applyChecks([OW, KEARNEY], checks);
  is(kearney, KEARNEY, "a check applies to exactly one window");
}
{
  // A closed window is history. Checking it does not reopen it.
  const checks = new Map([[windowKey(CLOSED), { at: iso(0), closes: null }]]);
  const [mck] = applyChecks([CLOSED], checks);
  is(mck.status, "closed", "checking a closed window does not reopen it");
  is(undatedWindows([mck]).length, 0, "and a closed window is never in the undated queue");
}
{
  // The key is firm + programme, so rewording a note in companies.yaml cannot
  // orphan a recorded check.
  const checks = new Map([[windowKey(OW), { at: iso(0), closes: day(20) }]]);
  const [ow] = applyChecks([{ ...OW, note: "completely rewritten", source: "https://new" }], checks);
  is(ow.closes, day(20), "a reworded note keeps its recorded checks");
}

// ----------------------------------------------------------------------------
if (fails.length) {
  console.log(`\n${fails.length} FAILED of ${pass + fails.length}\n`);
  for (const f of fails) console.log(`  ${f}\n`);
  process.exit(1);
}
console.log(`${pass}/${pass} passed`);
