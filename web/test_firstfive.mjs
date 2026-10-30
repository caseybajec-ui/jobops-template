/**
 * "What do I do first?" — the done-rules. Run: node test_firstfive.mjs
 *
 * ONE PROPERTY MATTERS MORE THAN THE REST: a completed step is never shown. Not
 * dimmed, not struck through, not moved to the bottom — absent. That is the
 * entire reason this reads live state instead of being a static list, so it is
 * asserted for every step individually and then for all of them at once.
 */
import { NAMES_TARGET, firstFive, firstFiveSteps } from "./lib/firstfive.js";

let pass = 0;
const fails = [];
const ok = (c, what) => (c ? pass++ : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const CO = { slug: "palantir", label: "Palantir" };
const W = [{ id: "window:Accenture|Strategy", firm: "Accenture" },
           { id: "window:Deloitte|Consulting", firm: "Deloitte" },
           { id: "window:EY-Parthenon|Associate", firm: "EY-Parthenon" }];

/** Nothing done at all. */
const FRESH = {
  startCompany: CO, contactsAt: 0,
  openWindows: W, appliedWindows: [],
  outreachSent: 0,
  confirmToday: { surfaced: true, done: false },
  sf86Contact: { pct: 0, ready: true },
};
/** Everything done. */
const DONE = {
  startCompany: CO, contactsAt: 2,
  openWindows: W, appliedWindows: W.map((w) => w.id),
  outreachSent: 1,
  confirmToday: { surfaced: true, done: true },
  sf86Contact: { pct: 100, ready: true },
};

const ids = (s) => firstFive(s).steps.map((x) => x.id);

/* ------------------------------------------------------- shape and order */

eq(firstFiveSteps(FRESH).length, 5, "five steps");
eq(ids(FRESH), ["names", "consulting", "outreach", "confirm", "sf86"],
   "order: slowest to pay off first, the closing window second, homework last");
for (const s of firstFiveSteps(FRESH)) {
  ok(s.title && s.why && s.href && s.cta, `${s.id} is complete`);
  ok(s.why.length > 40, `${s.id} says why it matters`);
  ok(s.href.startsWith("/"), `${s.id} links somewhere real`);
}

/* ------------------------------------ THE PROPERTY: a done step disappears */

for (const [id, patch] of [
  ["names", { contactsAt: NAMES_TARGET }],
  ["consulting", { appliedWindows: W.map((w) => w.id) }],
  ["outreach", { outreachSent: 1 }],
  ["confirm", { confirmToday: { surfaced: true, done: true } }],
  ["sf86", { sf86Contact: { pct: 100, ready: true } }],
]) {
  const got = ids({ ...FRESH, ...patch });
  ok(!got.includes(id), `${id}: a completed step is GONE, not dimmed — got ${JSON.stringify(got)}`);
  eq(got.length, 4, `${id}: and the other four remain`);
}

eq(ids(DONE), [], "everything done shows nothing");
eq(firstFive(DONE).allDone, true, "and says so, so the caller can collapse it");
eq(firstFive(FRESH).allDone, false, "not all done when nothing is");
eq(firstFive({ ...FRESH, contactsAt: 2, outreachSent: 1 }).doneCount, 2,
   "the done count is the ones filtered out");

/* --------------------------------------------------- the un-obvious cases */

// NOTHING TO SUBMIT IS DONE, not pending. With no window open there is no
// application to make, and a step that cannot be completed is a step that sits
// there forever — the permanent-occupant failure this app has had once already.
ok(!ids({ ...FRESH, openWindows: [] }).includes("consulting"),
   "no open window means nothing to submit, so the step is done rather than stuck");

// Same shape: the confirm step is offered one window a day. On a weekend, or
// once every window has a date, nothing is surfaced and there is nothing to do.
ok(!ids({ ...FRESH, confirmToday: { surfaced: false, done: false } }).includes("confirm"),
   "nothing surfaced today means nothing to confirm");

// Partial progress still counts as not done, and SAYS how far.
{
  const s = firstFiveSteps({ ...FRESH, contactsAt: 1 }).find((x) => x.id === "names");
  ok(!s.done, "one of two names is not done");
  ok(/1 of 2/.test(s.note || ""), "and the row says 1 of 2 rather than looking untouched");
}
{
  const s = firstFiveSteps({ ...FRESH, appliedWindows: [W[0].id] }).find((x) => x.id === "consulting");
  ok(!s.done, "one of three applications is not done");
  ok(/1 of 3/.test(s.note || ""), "and it says so");
}
{
  const s = firstFiveSteps({ ...FRESH, sf86Contact: { pct: 60 } }).find((x) => x.id === "sf86");
  ok(!s.done, "60% is not finished");
  ok(/60%/.test(s.note || ""), "and the percentage is shown");
}

// The company is NAMED from the ranking, never hardcoded — so the step follows
// the queue it is telling you to work.
ok(/Palantir/.test(firstFiveSteps(FRESH)[0].title), "the top company is named in the step");
ok(/Anduril/.test(firstFiveSteps({ ...FRESH, startCompany: { slug: "anduril", label: "Anduril" } })[0].title),
   "and it follows the ranking rather than a literal");
ok(firstFiveSteps({ ...FRESH, startCompany: null })[0].href === "/people?add=1",
   "no ranking yet still links somewhere sensible");

/* ------------------------------------------------------ nothing explodes */

eq(firstFiveSteps({}).length, 5, "an empty state still produces five steps");
ok(firstFive({}).steps.length >= 1, "and shows the ones that are genuinely undone");

console.log(`${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFAILURES:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
