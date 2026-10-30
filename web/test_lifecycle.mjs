/**
 * The application lifecycle rules. Run: node test_lifecycle.mjs
 *
 * lib/lifecycle.js is pure, so this runs against fixed dates with no database.
 *
 * The assertions that matter, and why:
 *
 *   LATEST WINS, AND THE ORDER IS TOTAL. Two clicks inside one second write
 *   identical ISO timestamps. Ordering on `at` alone would settle that pair at
 *   random, which is the exact trap the actions table already documents — three
 *   separate comparators in this repo have been fixed for it.
 *
 *   THE REFERRAL ANSWER BELONGS TO THE APPLIED EVENT. It is a fact about how he
 *   got in and has to survive every later move; reading it off the latest event
 *   would lose it the moment anything else happened.
 *
 *   NULL IS NOT FALSE. "He skipped the question" and "he applied cold" are
 *   different facts, and folding the first into the second invents evidence
 *   against the one thesis this data exists to test.
 *
 *   THE TALLY REFUSES TO DRAW A CONCLUSION under three applications, because
 *   "100% vs 0%" off a sample of two is the 2027 posting forecast all over
 *   again: a confident answer the data cannot support.
 */
import {
  LIFECYCLE, LIFECYCLE_KEYS, LIFECYCLE_LABEL, TERMINAL, HANDLED, PREPPING,
  NUDGE_AFTER_DAYS, MIN_FOR_TALLY, daysIn, currentStatus, inFlight,
  referralTally, PREP_CHECKLISTS, CHECKLIST_KEYS,
} from "./lib/lifecycle.js";
import { roleFamilyOf } from "./lib/people.js";
import { forbiddenClaim } from "./lib/clearance.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

const NOW = new Date("2026-09-16T12:00:00Z");
const ev = (id, status, at, referral = null) =>
  ({ id, status, at: `${at}T09:00:00+00:00`, referral, note: null });

/* ------------------------------------------------------------ the vocabulary */

eq(LIFECYCLE.length, 8, "eight stages");
ok(!LIFECYCLE_KEYS.includes("saved"),
   "there is no `saved` stage — saving is the `save` action, and a second one would be two places to look for one fact");
ok(LIFECYCLE_KEYS.includes("ghosted"),
   "`ghosted` has its own name — recording it as `rejected` would overstate how many decisions were actually made about him");
ok(LIFECYCLE_KEYS.every((k) => LIFECYCLE_LABEL[k]), "every stage has a label");
eq([...TERMINAL].sort(), ["ghosted", "offer", "rejected"], "three terminal stages");
ok(!HANDLED.has("saved"), "saved is not a handled state");
ok(HANDLED.has("applied") && HANDLED.has("rejected"),
   "applied and rejected both leave the inbox by default");
ok(PREPPING.has("phone_screen") && !PREPPING.has("applied"),
   "the prep checklist starts at the phone screen, not at applied");

/* ------------------------------------------------------------- the clock */

eq(daysIn("2026-09-02T09:00:00+00:00", NOW), 14, "two weeks in a stage");
eq(daysIn(null, NOW), null, "no timestamp is not zero days");

/* ------------------------------------------------------- the current status */

eq(currentStatus([], NOW), null, "a role with no events has no status");

{
  const s = currentStatus([
    ev("ev:1", "applied", "2026-09-01", 1),
    ev("ev:2", "phone_screen", "2026-09-10"),
  ], NOW);
  eq(s.status, "phone_screen", "the latest event is the status");
  eq(s.days, 6, "and days-in-stage counts from THAT event, not from the first");
  // The referral answer has to survive every later move: it is a fact about how
  // he got in, and reading it off the latest event would lose it immediately.
  eq(s.referral, true, "the referral answer comes from the APPLIED event");
  eq(s.terminal, false, "a phone screen is not the end");
}

// Order of arrival must not matter — rows come back from the database in
// whatever order it likes.
{
  const a = currentStatus([ev("ev:2", "offer", "2026-09-10"), ev("ev:1", "applied", "2026-09-01")], NOW);
  const b = currentStatus([ev("ev:1", "applied", "2026-09-01"), ev("ev:2", "offer", "2026-09-10")], NOW);
  eq([a.status, b.status], ["offer", "offer"], "arrival order does not decide the status");
  eq(a.terminal, true, "an offer is terminal — nothing more happens on its own");
}

// TOTAL ORDER. Two events with the SAME timestamp settle on id, so the answer
// cannot change between two loads of the same page.
{
  const same = [ev("ev:aaa", "applied", "2026-09-10"), ev("ev:bbb", "rejected", "2026-09-10")];
  const one = currentStatus(same, NOW).status;
  const two = currentStatus([...same].reverse(), NOW).status;
  eq([one, two], ["rejected", "rejected"],
     "two events sharing a timestamp break the tie on id, so the order is total");
}

// NULL IS NOT FALSE.
{
  const skipped = currentStatus([ev("ev:1", "applied", "2026-09-01", null)], NOW);
  eq(skipped.referral, null, "skipping the question stores null, never false");
  const cold = currentStatus([ev("ev:1", "applied", "2026-09-01", 0)], NOW);
  eq(cold.referral, false, "and answering 'cold' stores false");
}

/* --------------------------------------------------------------- in flight */

{
  const by = new Map([
    ["a|old", currentStatus([ev("ev:1", "applied", "2026-08-20")], NOW)],
    ["b|new", currentStatus([ev("ev:2", "applied", "2026-09-14")], NOW)],
    ["c|done", currentStatus([ev("ev:3", "rejected", "2026-09-01")], NOW)],
    ["d|offer", currentStatus([ev("ev:4", "offer", "2026-09-05")], NOW)],
  ]);
  const live = inFlight(by, NOW);
  eq(live.map((f) => f.groupKey), ["a|old", "b|new"],
     "terminal roles leave In flight; an offer is a decision to make, not a live application");
  // LONGEST WAITING FIRST. The thing that has not moved is the thing that needs
  // a decision; sorting by stage buries it under whatever is furthest along.
  eq(live[0].days > live[1].days, true, "longest-waiting first");
  eq(live[0].nudge, true, `${NUDGE_AFTER_DAYS}+ days in applied earns a nudge note`);
  eq(live[1].nudge, false, "two days in does not");
}

// An empty map is an empty list, not a crash — this renders on Daily before a
// single application exists.
eq(inFlight(new Map(), NOW), [], "no applications is an empty list");

/* ------------------------------------------------------------- the tally */

{
  const two = new Map([
    ["a|x", currentStatus([ev("ev:1", "applied", "2026-09-01", 1)], NOW)],
    ["b|y", currentStatus([ev("ev:2", "applied", "2026-09-02", 0)], NOW)],
  ]);
  eq(referralTally(two).enough, false,
     `${MIN_FOR_TALLY} applications are needed before this says anything — "100% vs 0%" off a sample of two is a confident answer the data cannot support`);
}

{
  const three = new Map([
    ["a|x", currentStatus([ev("ev:1", "applied", "2026-09-01", 1),
                           ev("ev:2", "phone_screen", "2026-09-08")], NOW)],
    ["b|y", currentStatus([ev("ev:3", "applied", "2026-09-02", 0)], NOW)],
    ["c|z", currentStatus([ev("ev:4", "applied", "2026-09-03", null)], NOW)],
  ]);
  const t = referralTally(three);
  eq(t.enough, true, "three is the threshold");
  eq({ withRef: t.withRef, without: t.without, unknown: t.unknown },
     { withRef: 1, without: 1, unknown: 1 },
     "the unanswered one is counted SEPARATELY, never folded into 'without'");
  eq(t.progressedWith, 1, "one referred application got past the application stage");
  eq(t.progressedWithout, 0, "and no cold one did");
  eq(t.withRef + t.without + t.unknown, t.total, "the three buckets account for every application");
}

/* ------------------------------------------------------- the prep checklists */

// The families must be the ones roleFamilyOf already returns, or a role is
// classified one way for conversation prep and another way for interview prep.
for (const k of CHECKLIST_KEYS) {
  const c = PREP_CHECKLISTS[k];
  ok(c.research.length >= 3, `${k} has at least three research items`);
  ok(c.questions.length >= 3, `${k} names at least three question types`);
  ok(c.label, `${k} has a label`);
  ok(!c.research.concat(c.questions).some((s) => /\{|\[/.test(s)),
     `${k} has no placeholder text`);
}
eq(CHECKLIST_KEYS.sort(), ["apm", "defense_ops", "deployment", "vc"],
   "the four checklist families match the four conversation-prep families");
for (const t of ["Deployment Strategist - US Government", "Associate Product Manager",
                 "Mission Operations Specialist"]) {
  const fam = roleFamilyOf(t);
  ok(fam && PREP_CHECKLISTS[fam],
     `roleFamilyOf("${t}") returns ${fam}, which must have a checklist`);
}

// The clearance wording is a hard constraint from CLAUDE.md and this is one of
// the few places the tool puts words about it in front of the owner before an
// interview. It may say he is willing to undergo the process; it may NEVER say
// he is cleared or eligible, because that is an adjudicator's determination.
{
  const defense = PREP_CHECKLISTS.defense_ops.questions.join(" ");
  ok(/no current or prior clearance|no known disqualifying/i.test(defense),
     "the defense checklist states the clearance position the way profile.json does");
  // The shared predicate -- see lib/clearance.js for why this is not a
  // regex written here.
  const claim = forbiddenClaim(defense);
  ok(claim === null,
     `and never claims eligibility or a clearance, which is a determination `
     + `nobody has made${claim ? ` (found ${JSON.stringify(claim)})` : ""}`);
}

/* ------------------------------------------------------------------ report */

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
