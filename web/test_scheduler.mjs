/**
 * The one-a-day scheduler. Run: node test_scheduler.mjs
 *
 * It is pure, so all of this runs against fixed dates with no database — which
 * matters because the behaviour being checked is "what happens on the second
 * page load of the same day", and waiting a day to find out is not a test.
 *
 * The four that carry weight:
 *
 *   IDEMPOTENT. Daily renders this on every load. If a second call surfaced a
 *   second item, opening the page twice would put two confirm-date tasks in
 *   front of him, which is the wall this feature exists to remove.
 *
 *   IT DOES NOT ROTATE AWAY. An item surfaced yesterday and still open stays.
 *   A page that forgets what it asked for yesterday teaches you to ignore it,
 *   and that is exactly why the old page was being closed.
 *
 *   WEEKENDS ADD NOTHING AND TAKE NOTHING. Friday's unfinished pick survives
 *   Saturday; no new one is chosen.
 *
 *   THE ORDER IS TOTAL. Two companies absent from the ranking tie, and a
 *   comparator that can return 0 for two distinct rows picks differently
 *   between loads — the defect three separate comparators in this repo have
 *   already been fixed for.
 */
import {
  planToday, parentProgress, ageSignal, isWeekend, todayIn,
  UNIT_KINDS, AGE_QUIET_DAYS, AGE_LOUD_DAYS,
} from "./lib/scheduler.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

const TUE = "2026-09-15";       // a Tuesday
const SAT = "2026-09-19";       // a Saturday

const child = (id, kind, company, over = {}) =>
  ({ id, unit_kind: kind, unit_company: company, surfaced_on: null, done: false, ...over });

const RANKING = ["palantir", "andurilindustries", "saronic", "notion"];
const NOBODY = {};

/* ------------------------------------------------------------- the calendar */

ok(isWeekend(new Date("2026-09-19T12:00:00Z")), "Saturday is a weekend");
ok(isWeekend(new Date("2026-09-20T12:00:00Z")), "so is Sunday");
ok(!isWeekend(new Date("2026-09-18T12:00:00Z")), "Friday is not");

// The user's timezone, not the server's. A UTC "today" flips at 5pm Pacific and
// would move the day's item mid-afternoon.
{
  const evening = new Date("2026-09-16T04:30:00Z");   // 21:30 on the 15th in LA
  eq(todayIn("America/Los_Angeles", evening), "2026-09-15",
     "half past nine at night in Los Angeles is still the 15th, though UTC says the 16th");
  eq(todayIn("UTC", evening), "2026-09-16", "and the same instant is the 16th in UTC");
}

/* ------------------------------------------------------------ one per kind */

{
  const kids = [
    child("f1", "find_names", "palantir"),
    child("f2", "find_names", "andurilindustries"),
    child("c1", "confirm_date", "bcg"),
    child("c2", "confirm_date", "kearney"),
  ];
  const p = planToday({ children: kids, ranking: RANKING, contactCounts: NOBODY,
                        windowStaleness: { bcg: 3, kearney: null }, today: TUE });
  eq(p.surface.length, 2, "exactly one of each kind is surfaced, never two of one");
  ok(p.surface.includes("f1"), "the highest-ranked company under two names");
  ok(p.surface.includes("c2"), "and the window that has NEVER been checked, over one checked 3 days ago");
}

/* ------------------------------------------------------------- idempotence */

{
  const kids = [child("f1", "find_names", "palantir"), child("c1", "confirm_date", "bcg")];
  const first = planToday({ children: kids, ranking: RANKING, today: TUE });
  eq([...first.surface].sort(), ["c1", "f1"], "first call of the day surfaces one of each");

  // The caller has now written surfaced_on. Second render of the same day:
  const after = kids.map((c) => ({ ...c, surfaced_on: first.surface.includes(c.id) ? TUE : null }));
  const second = planToday({ children: after, ranking: RANKING, today: TUE });
  eq(second.surface, [],
     "the second call surfaces NOTHING — opening Daily twice must not produce two tasks");
  eq(second.keep.sort(), ["c1", "f1"], "it keeps what is already up");
}

/* ------------------------------------------------- it does not rotate away */

{
  // Surfaced yesterday, still not done.
  const kids = [
    child("f1", "find_names", "palantir", { surfaced_on: "2026-09-14" }),
    child("f2", "find_names", "andurilindustries"),
  ];
  const p = planToday({ children: kids, ranking: RANKING, today: TUE });
  // Yesterday's is not today's, so a new one IS chosen — but the old one is not
  // withdrawn by this function; nothing here clears surfaced_on.
  ok(!p.surface.includes("f2") || p.surface.length === 1,
     "at most one find_names is ever surfaced in a single call");
  ok(!("clear" in p), "the plan never asks the caller to UNSURFACE anything");
}

/* ---------------------------------------------------------------- rotation */

{
  // Palantir's child is done, so the next-ranked company comes up.
  const kids = [
    child("f1", "find_names", "palantir", { done: true }),
    child("f2", "find_names", "andurilindustries"),
    child("f3", "find_names", "saronic"),
  ];
  const p = planToday({ children: kids, ranking: RANKING, today: TUE });
  eq(p.surface, ["f2"], "completing Palantir surfaces Anduril, the next in rank");
}

{
  // A company that already has two names drops out entirely — two is the goal,
  // not a preference.
  const kids = [
    child("f1", "find_names", "palantir"),
    child("f2", "find_names", "andurilindustries"),
  ];
  const p = planToday({ children: kids, ranking: RANKING,
                        contactCounts: { palantir: 2 }, today: TUE });
  eq(p.surface, ["f2"], "a company already at two names is not offered again");
}

/* ---------------------------------------------------------------- weekends */

{
  const kids = [child("f1", "find_names", "palantir"), child("c1", "confirm_date", "bcg")];
  const p = planToday({ children: kids, ranking: RANKING, today: SAT });
  eq(p.surface, [], "nothing new is chosen on a Saturday");
  ok(p.weekend, "and the plan says why");
}

{
  // Friday's pick survives the weekend rather than being withdrawn.
  const kids = [child("f1", "find_names", "palantir", { surfaced_on: SAT })];
  const p = planToday({ children: kids, ranking: RANKING, today: SAT });
  eq(p.keep, ["f1"], "an item already up on the weekend stays up");
}

/* ------------------------------------------------------------- total order */

{
  // Two companies neither of which is in the ranking: they tie on rank, and a
  // comparator that stopped there would pick differently between page loads.
  const a = [child("x", "find_names", "zeta"), child("y", "find_names", "alpha")];
  const one = planToday({ children: a, ranking: RANKING, today: TUE }).surface;
  const two = planToday({ children: [...a].reverse(), ranking: RANKING, today: TUE }).surface;
  eq(one, two, "two unranked companies resolve the same way whatever order they arrive in");
}

/* ----------------------------------------------------------------- nothing */

eq(planToday({ children: [], today: TUE }).surface, [],
   "no children is an empty plan, not a crash");
ok(UNIT_KINDS.length === 2, "two kinds are scheduled one-a-day");

/* ---------------------------------------------------------------- progress */

{
  const kids = [
    { id: "a", parent_id: "p", done: true },
    { id: "b", parent_id: "p", done: false },
    { id: "c", parent_id: "other", done: true },
  ];
  const pr = parentProgress({ id: "p" }, kids);
  eq({ done: pr.done, total: pr.total }, { done: 1, total: 2 },
     "a parent counts only its own children");
}

/* ------------------------------------------------------- what comes next */

/**
 * `plan.next` is what a COLLAPSED parent row says instead of "Nothing surfaced
 * today" — four lines to report an absence, on both parents, every day.
 *
 * It has to be the pick the scheduler WOULD make. The view cannot compute it:
 * find_names orders by company ranking and confirm_date by staleness, and a
 * second implementation of either in a component is two rules that will
 * disagree the first time one of them is tuned. So it comes out of the same
 * pickers, and these check that it does.
 *
 * The un-obvious half is that `next` must never be the item that is CURRENTLY
 * surfaced. "Next up: Palantir" printed above a row already reading "Find 2
 * names at Palantir" is the page arguing with itself.
 */
{
  const kids = [
    { id: "1", unit_kind: "find_names", unit_company: "palantir", done: false },
    { id: "2", unit_kind: "find_names", unit_company: "anduril", done: false },
    { id: "3", unit_kind: "find_names", unit_company: "saronic", done: false },
  ];
  const ranking = ["palantir", "anduril", "saronic"];
  const args = { children: kids, ranking, contactCounts: {}, today: "2026-09-02" };

  const fresh = planToday(args);
  eq(fresh.surface, ["1"], "the highest-ranked company is surfaced");
  eq(fresh.next.find_names?.company, "anduril",
     "and the one after it is NAMED, not surfaced");

  // With today's already standing, next is still the one after it.
  const standing = planToday({
    ...args,
    children: kids.map((k) => (k.id === "1" ? { ...k, surfaced_on: "2026-09-01" } : k)),
  });
  eq(standing.keep, ["1"], "yesterday's unfinished pick stands");
  eq(standing.next.find_names?.company, "anduril",
     "next skips the standing one — naming it would have the row argue with itself");

  // Done means gone from both.
  const doneFirst = planToday({
    ...args,
    children: kids.map((k) => (k.id === "1" ? { ...k, done: true } : k)),
  });
  eq(doneFirst.surface, ["2"], "finishing today's promotes the one that was next");
  eq(doneFirst.next.find_names?.company, "saronic", "and the queue advances");

  // The last one has nothing after it, and says so rather than repeating itself.
  const last = planToday({ ...args, children: [kids[0]] });
  eq(last.next.find_names, null, "the last child has no next, and null is the honest answer");
}

{
  // confirm_date orders by staleness: never-checked first, then oldest.
  const kids = [
    { id: "a", unit_kind: "confirm_date", unit_company: "bain", done: false },
    { id: "b", unit_kind: "confirm_date", unit_company: "kearney", done: false },
    { id: "c", unit_kind: "confirm_date", unit_company: "mckinsey", done: false },
  ];
  const p2 = planToday({
    children: kids, today: "2026-09-02",
    windowStaleness: { bain: 3, kearney: null, mckinsey: 20 },
  });
  eq(p2.surface, ["b"], "never-checked outranks long-ago-checked");
  eq(p2.next.confirm_date?.company, "mckinsey",
     "then the oldest actual check — the same order the picker uses, not a re-derivation");
}

{
  // A weekend surfaces nothing new, and the row still has something to say.
  const kids = [{ id: "z", unit_kind: "find_names", unit_company: "notion", done: false }];
  const sat = planToday({ children: kids, ranking: ["notion"], today: "2026-09-05" });
  ok(sat.weekend, "Saturday is a weekend");
  eq(sat.surface, [], "nothing new is chosen");
  eq(sat.next.find_names?.company, "notion",
     "but Monday's pick is named — a row that says nothing on Saturday is a row that looks broken");
}

/* ------------------------------------------------------------------- aging */

eq(ageSignal(0), null, "nothing is said about a task added today");
eq(ageSignal(AGE_QUIET_DAYS - 1), null, `nor under ${AGE_QUIET_DAYS} days`);
ok(ageSignal(AGE_QUIET_DAYS)?.level === "soon", `${AGE_QUIET_DAYS} days is a gentle note`);
ok(ageSignal(AGE_LOUD_DAYS)?.level === "now", `${AGE_LOUD_DAYS} days is loud`);
ok(ageSignal(12)?.text === "untouched 12 days",
   "and it counts UP — a countdown implies progress that is not happening");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
