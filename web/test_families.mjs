/**
 * Interview families, the notes, and the availability trim. Run: node test_families.mjs
 *
 * The family decides which interview-prep note a role shows. A wrong one is
 * worse than none: it is confident, specific and misleading, on the morning of
 * an interview. So "unknown" has to be a real answer, and the table below is
 * built from titles verbatim in the corpus rather than from tidy examples.
 */
import { familyOf, FAMILY_KEYS, FAMILY_RULES } from "./lib/families.js";
import { INTERVIEWS, interviewNote, DISCLAIMER, ALWAYS_ASK } from "./lib/interviews.js";
import {
  trimToFit, minutesFor, todayIn, HOUR_CHOICES, DEFAULT_MINUTES,
} from "./lib/availability.js";
import { forbiddenClaim } from "./lib/clearance.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- the mapping */
//
// [title, company category, expected family]. Every title is real.

const CASES = [
  // The acceptance criterion the brief names by hand.
  ["Deployment Strategist - US Government", "defense", "deployment_strategist_fdse"],
  ["Deployment Strategist, Build to Apply - US Government", "defense", "deployment_strategist_fdse"],
  ["Forward Deployed Software Engineer, New Grad - Commercial", "defense", "deployment_strategist_fdse"],
  ["Forward Deployed Engineer - Software", "product", "deployment_strategist_fdse"],

  ["Associate Product Manager, New Grad (2027 Start)", "product", "apm_product"],
  ["Product Manager - Mission Agents", "defense", "apm_product"],
  ["Business Operations Associate", "product", null],

  ["Mission Operations Engineer", "defense", "defense_ops"],
  ["Mission Operations Engineer (Platform - UUV)", "defense", "defense_ops"],
  ["Mission Success Operations Manager", "defense", "defense_ops"],
  ["SkillBridge Mission Operations Associate", "defense", "defense_ops"],

  ["Full Time Analyst 2027", "vc", "vc_analyst"],
  ["Investment Analyst", "vc", "vc_analyst"],

  ["Strategy & Consulting, undergraduate", "consulting", "consulting"],
  ["Associate, Strategy & Operations / Consulting", "consulting", "consulting"],

  // UNKNOWN IS AN ANSWER. A prep checklist for the wrong format is worse than
  // none, so a role that matches nothing gets nothing.
  ["Mission Software Engineer, EW", "defense", null],
  ["Product Security Engineer, Programs", "defense", null],
  ["AI Engineer, Product", "product", null],
  ["Research Engineer - New Grad (2027)", "product", null],
  ["", "product", null],
];

for (const [title, category, want] of CASES) {
  eq(familyOf({ title }, category), want, `${JSON.stringify(title)} @ ${category}`);
}

// CATEGORY ALONE IS NEVER ENOUGH. Otherwise every Palantir posting — including
// its hardware roles — would be a deployment strategist.
eq(familyOf({ title: "Warehouse Associate" }, "defense"), null,
   "a defense company does not make every role a defense-ops role");
eq(familyOf({ title: "Recruiter" }, "consulting"), null,
   "and a consulting firm does not make every role a case interview");

// ORDER MATTERS, and this is the pair that proves it: an FDSE title contains
// "engineer" and sits at a defense company, and it must resolve as a
// deployment strategist rather than as defense ops.
eq(familyOf({ title: "Forward Deployed Software Engineer" }, "defense"),
   "deployment_strategist_fdse", "the more specific rule wins");

ok(FAMILY_RULES.every((r) => r.key && (r.title || []).length),
   "every rule has a key and at least one title pattern");
ok(new Set(FAMILY_KEYS).size === FAMILY_KEYS.length, "and the keys are unique");

/* ---------------------------------------------------------------- the notes */

for (const key of FAMILY_KEYS) {
  const n = interviewNote(key);
  ok(!!n, `${key} has a note`);
  ok(n.process.length >= 4 && n.process.length <= 6, `${key}: 4-6 process lines`);
  ok(n.prep.length >= 4 && n.prep.length <= 6, `${key}: 4-6 prep lines`);
  ok(n.label && n.label.length > 3, `${key} has a label`);

  // NEVER A BRACKET. This text is read on the morning of an interview, and a
  // placeholder there is the tool visibly unfinished at the worst moment.
  const all = [...n.process, ...n.prep, ...n.ask].join(" ");
  ok(!/\[|\{/.test(all), `${key}: no placeholder brackets`);

  // THE CLEARANCE RULE, through the shared predicate. defense_ops is the note
  // that talks about clearance at all, and it is read right before a defense
  // interview — the highest-stakes place in this pipeline to get wrong.
  const claim = forbiddenClaim(all);
  ok(claim === null, `${key}: claims no determination${claim ? ` (${JSON.stringify(claim)})` : ""}`);
}

eq(interviewNote("nonsense"), null, "an unknown family has no note");
eq(interviewNote(null), null, "and neither does none at all");

ok(/unverified/i.test(DISCLAIMER) && /confirm with a contact/i.test(DISCLAIMER),
   "the disclaimer says the source is weak and names the way to check it");

// THE START-DATE QUESTION, on every family.
//
// 668 of 734 open scored roles state no start at all, and no parser fixes that
// — the posting does not say. It can only be answered by a human, it has to be
// asked every time, and it would otherwise be rediscovered per application.
for (const key of FAMILY_KEYS) {
  const asks = interviewNote(key).ask.join(" ");
  ok(/when does this role actually start/i.test(asks),
     `${key} asks when the role starts`);
  ok(/fall start/i.test(asks), `${key} asks whether a fall start is possible`);
}
ok(ALWAYS_ASK.length >= 2, "and there is more than one standing question");

// The defense note must state the position out loud, not merely avoid the
// forbidden phrasings.
ok(/no current or prior clearance/i.test(INTERVIEWS.defense_ops.prep.join(" ")),
   "defense_ops states the clearance position in the fixed words");

/* ------------------------------------------------------- the availability trim */

const task = (label, minutes, kind = "other") => ({ label, minutes, unit_kind: kind });

// RULE 1: no answer, no trimming, no nagging.
{
  const t = [task("a", 60), task("b", 60), task("c", 60)];
  const r = trimToFit(t, null);
  eq(r.fits.length, 3, "no answer means the whole list");
  eq(r.trimmed, false, "and nothing is reported as trimmed");
  eq(r.message, null, "and nothing is said about it");
  eq(trimToFit(t, undefined).fits.length, 3, "undefined is the same as unanswered");
  eq(trimToFit(t, "lots").fits.length, 3, "and so is a non-number");
}

// RULE 2: it says what it trimmed, by name.
{
  const r = trimToFit(
    [task("Accenture", 60), task("Deloitte", 60), task("EY-Parthenon", 60)], 2);
  eq(r.fits.map((x) => x.label), ["Accenture", "Deloitte"], "two hours takes two of three");
  eq(r.deferred.map((x) => x.label), ["EY-Parthenon"], "and defers the third");
  ok(/Accenture and Deloitte today/.test(r.message), "the message names what stayed");
  ok(/EY-Parthenon tomorrow/.test(r.message), "and what moved");
}

// ORDER IS PRESERVED. The ladder's ranking is argued — irreversibility beats
// urgency — and repacking by duration to fill the day would throw that away.
{
  const r = trimToFit([task("big", 90), task("small", 5), task("tiny", 5)], 2);
  eq(r.fits.map((x) => x.label), ["big", "small", "tiny"],
     "a long first task is not demoted to fit two short ones in front of it");
}
{
  const r = trimToFit([task("big", 200), task("small", 5)], 1);
  eq(r.fits.map((x) => x.label), ["big"],
     "THE FIRST TASK ALWAYS FITS — a budget smaller than the top item must not empty the day");
  ok(r.overruns, "and it says the day overruns");
  ok(/run past 1h/.test(r.message), "in words");
}

// Nothing is dropped; deferred plus fitted is always the whole list.
{
  const all = [task("a", 60), task("b", 60), task("c", 60), task("d", 60)];
  const r = trimToFit(all, 2);
  eq(r.fits.length + r.deferred.length, all.length, "nothing is ever lost, only deferred");
}

/* -------------------------------------------------------------- durations */

eq(minutesFor({ minutes: 45 }), 45, "a stated duration wins");
eq(minutesFor({ unit_kind: "confirm_date" }), DEFAULT_MINUTES.confirm_date,
   "and a missing one falls back by kind");
eq(minutesFor({ unit_kind: "find_names" }), 20, "twenty minutes for two names");
eq(minutesFor({}), DEFAULT_MINUTES.other, "with a last-resort default");
eq(minutesFor({ minutes: 0 }), DEFAULT_MINUTES.other, "zero is not a stated duration");
eq(minutesFor({ minutes: -5 }), DEFAULT_MINUTES.other, "nor is a negative one");

eq(HOUR_CHOICES, [1, 2, 4, 6], "four buttons, because a day is described in hours");

ok(/^\d{4}-\d{2}-\d{2}$/.test(todayIn()), "today is a plain date");
// The server runs in UTC, which flips the date at 5pm Pacific — so the day's
// question would change in the middle of the afternoon.
eq(todayIn("America/Los_Angeles", new Date("2026-09-02T04:00:00Z")), "2026-09-01",
   "and it is the user's date, not the server's");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
