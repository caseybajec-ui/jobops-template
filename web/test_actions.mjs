/**
 * The one verb per row, and the wrong-cycle flag. Run: node test_actions.mjs
 *
 * Table-driven, because the branches are the whole feature: every row looked
 * identical and the right action was not identical, and the cost of getting it
 * backwards is real — telling him to apply to a req that will be filled by
 * Christmas, or to go find a person at a company where the actual application
 * is open and closing.
 *
 * The named cases at the bottom come straight from the brief's acceptance
 * criteria, so a change that satisfies the rules but breaks the real rows fails
 * here rather than on screen.
 */
import {
  computePrimaryAction, primaryActionFor, foldFlags, isWrongCycle,
  wrongCycleNote, PRIMARY_ACTIONS, FLAG_WRONG_CYCLE,
} from "./lib/actions.js";
import { NAMES_PER_COMPANY } from "./lib/people.js";
import { USER_CLASS_YEAR } from "./lib/constants.js";
import { PROGRAM_WINDOW, CLASS_YEAR } from "./lib/config.generated.js";

// THE CLASS IS THE BAKED ONE. Every "dated for the owner's class" fixture is
// built from CLASS_YEAR / PROGRAM_WINDOW rather than typed, so the suite tests
// the next owner's build as well as this one's.
const Y = CLASS_YEAR;

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ the branches */

const CASES = [
  // [description, role, contacts, expected]
  ["a named programme dated for the owner's class",
   { entry_level: "program", start_window: PROGRAM_WINDOW }, 0, "apply"],
  ["an entry role dated for the owner's class",
   { entry_level: "entry", class_year: Y }, 0, "apply"],
  ["an entry role with the start YEAR set",
   { entry_level: "entry", start_year: Y }, 0, "apply"],
  // And the year BEFORE is not the owner's class, however the row says it: a
  // programme for another class is never apply, and a programme is never a
  // find_person either (it will run again), so it is watch.
  ["a programme dated for the class before",
   { entry_level: "program", start_window: `${Y - 1} program` }, 0, "watch"],
  // Dated is load-bearing: an UNDATED programme runs again next year, and this
  // year's intake is the wrong one to apply to.
  ["an undated programme, nobody known",
   { entry_level: "program" }, 0, "watch"],
  ["an undated programme at a company the owner knows",
   { entry_level: "program" }, 2, "watch"],
  ["an open-now role, nobody known",
   { entry_level: "entry" }, 0, "find_person"],
  ["an open-now role with one contact — one is a single point of failure",
   { entry_level: "entry" }, 1, "find_person"],
  ["an open-now role where two people are already known",
   { entry_level: "entry" }, NAMES_PER_COMPANY, "watch"],
  ["an experienced role, nobody known",
   { entry_level: "experienced" }, 0, "find_person"],
  ["an experienced role at a covered company",
   { entry_level: "experienced" }, 3, "watch"],
  ["a role with no level at all, nobody known",
   {}, 0, "find_person"],
];

for (const [what, role, contacts, want] of CASES) {
  eq(computePrimaryAction(role, contacts), want, what);
}

// A role for another class year is not "apply" however it is levelled.
eq(computePrimaryAction({ entry_level: "program", class_year: 2026 }, 0), "watch",
   "a 2026-dated programme is not his to apply to");
eq(computePrimaryAction({ entry_level: "entry", class_year: 2028 }, 0), "find_person",
   "and a 2028-dated entry role is an open-now req like any other");

ok(PRIMARY_ACTIONS.length === 3, "three verbs, no more");
ok(PRIMARY_ACTIONS.every(([, l, w]) => l && w), "each has a label and a reason");

/* ------------------------------------------------------------- the wrapper */

{
  const r = primaryActionFor({ entry_level: "entry", company: "palantir", score: 92 },
                             { palantir: 0 });
  eq(r.action, "find_person", "the wrapper reads the contact count for the row's company");
  eq(r.contacts, 0, "and reports it");
  ok(r.label && r.why, "with words for the button and the tooltip");
  eq(r.band, "Excellent", "and the band, for the tooltip");
}
{
  const r = primaryActionFor({ entry_level: "entry", company: "palantir" }, {});
  eq(r.contacts, 0, "a company absent from the counts is zero, not undefined");
}

/* --------------------------------------------------------------- the flags */

const flagRow = (id, scope, key, on_, note = null) =>
  ({ id, scope, key, flag: FLAG_WRONG_CYCLE, on_, note, at: "2026-08-31T00:00:00+00:00" });

{
  const f = foldFlags([flagRow("fl:1", "role", "bvpanalyst|full time analyst", 1, "wrong cycle")]);
  ok(f.roles.has("bvpanalyst|full time analyst"), "a set flag hides the role");
  eq(f.roles.get("bvpanalyst|full time analyst"), "wrong cycle", "and keeps the note");
}

// LATEST WINS, BY ID. Two clicks inside one second write identical timestamps;
// ordering on `at` would settle the pair at random.
{
  const f = foldFlags([
    flagRow("fl:1", "role", "x|y", 1),
    flagRow("fl:2", "role", "x|y", 0),
  ]);
  ok(!f.roles.has("x|y"), "un-hiding wins over the earlier hide");

  const g = foldFlags([
    flagRow("fl:2", "role", "x|y", 0),
    flagRow("fl:1", "role", "x|y", 1),
  ]);
  ok(!g.roles.has("x|y"), "and the arrival order does not change the answer");
}

// A company flag hides every role at that company, without a row per role.
{
  const f = foldFlags([flagRow("fl:1", "company", "bvpanalyst", 1, "wrong cycle for us")]);
  ok(isWrongCycle({ company: "bvpanalyst", groupKey: "bvpanalyst|anything" }, f),
     "a company flag hides its roles");
  ok(!isWrongCycle({ company: "palantir", groupKey: "palantir|x" }, f),
     "and nobody else's");
  eq(wrongCycleNote({ company: "bvpanalyst", groupKey: "bvpanalyst|x" }, f),
     "wrong cycle for us", "the note comes from whichever flag matched");
}

{
  const none = foldFlags([]);
  ok(!isWrongCycle({ company: "palantir", groupKey: "palantir|x" }, none),
     "no flags hides nothing");
  ok(!isWrongCycle(null, none), "and a missing role is not a crash");
}

/* ------------------------------------------- the rows the brief names */
//
// Straight from the acceptance criteria. A change that satisfies the rules
// above but breaks these fails here rather than on screen.

const NAMED = [
  ["Saronic Associate Product Manager (open now, nobody known)",
   { entry_level: "entry", company: "saronic" }, {}, "find_person"],
  ["Palantir Deployment Strategist (open now, nobody known)",
   { entry_level: "entry", company: "palantir" }, {}, "find_person"],
  [`Roblox [${Y}] Software Engineer, Early Career`,
   { entry_level: "program", start_window: PROGRAM_WINDOW, company: "roblox" }, {}, "apply"],
  [`Databricks Associate Product Manager, New Grad (${Y} Start)`,
   { entry_level: "program", start_window: PROGRAM_WINDOW, company: "databricks" }, {}, "apply"],
  ["Notion Software Engineer, Early Career",
   { entry_level: "program", start_window: PROGRAM_WINDOW, company: "notion" }, {}, "apply"],
];
for (const [what, role, counts, want] of NAMED) {
  eq(primaryActionFor(role, counts).action, want, what);
}

eq(USER_CLASS_YEAR, CLASS_YEAR, "the class year is the baked constant, not a literal in a branch");
ok(Number.isInteger(USER_CLASS_YEAR) && USER_CLASS_YEAR >= 2020 && USER_CLASS_YEAR <= 2040,
   "and it is a plausible graduation year");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
