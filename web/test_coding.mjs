/**
 * The coding-interview rule. Run: node test_coding.mjs
 *
 * The owner fails a live coding interview, so a straight Software Engineer / SWE /
 * Full Stack role is never the day's application. The rule is deterministic and
 * reads the TITLE only — no model, no description.
 *
 * THE CANARY IS PALANTIR'S FORWARD DEPLOYED SOFTWARE ENGINEER. It is close to
 * the single most on-target posting in this corpus, it contains the exact string
 * "Software Engineer", and killing it is the precise mistake the first triage
 * prompt made — a headline number that looked fine while the best role in the
 * set was gone. Every FDSE variant is asserted by name.
 *
 * BOTH DIRECTIONS, every time. A rule that only ever demotes is easy to write
 * and impossible to trust; the exemptions matter more than the hits.
 */
import {
  isCodingInterviewRole, CODING_NOTE, CODING_TERMS, CODING_QUALIFIERS,
} from "./lib/display.js";
import { computePrimaryAction, codingBlocked, primaryActionFor } from "./lib/actions.js";
import { CLASS_YEAR } from "./lib/config.generated.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));

/* ------------------------------------------------- 1. caught: bare engineering */
const CAUGHT = [
  "Software Engineer, New Grad",
  "Software Engineer, New Grad - Defense",
  "Software Engineer, New Grad - Infrastructure",
  "Software Engineer, Early Career",
  "Software Engineer, Early Career (AI)",
  "[2027] Software Engineer, Early Career",
  "2027 Early Career Software Engineer",
  "Embedded Software Engineer - New Grad (2027)",
  "Flight Software Engineer I (New Grad)",
  "Software Engineer I, Full Stack (New Grad)",
  "Software Engineer I, Data Science (New Grad)",
  "Software Engineer I, QA (New Grad)",
  "Software Engineer I, Spacecraft Simulation (New Grad)",
  "Mission Software Engineer, EW",
  "Software Engineer, Public Sector",
  "Full-Stack Software Engineer, Mission Autonomy",
  "SWE, New Grad",
  "Full Stack Engineer",
  "Fullstack Engineer",
  // Reads as deployment, is not the FDSE family. A bare `deployment` qualifier
  // would have exempted this straight coding role — found by diffing the real
  // corpus, not by imagining cases.
  "Software Engineer, Autonomy Integration and Deployment",
];
for (const t of CAUGHT) ok(isCodingInterviewRole(t), `caught: ${t}`);

/* --------------------------------------------- 2. exempt: a qualified title */
const EXEMPT = [
  // The canary, and every shape Palantir and OpenAI actually post it in.
  "Forward Deployed Software Engineer, New Grad - US Government",
  "Forward Deployed Software Engineer, New Grad - Intel, US Government",
  "Forward Deployed Software Engineer",
  "Forward Deployed Software Engineer - US Government",
  "Forward Deployed Software Engineer - Tactical Edge",
  "Forward Deployed Software Engineer - Warp Speed",
  "Forward Deployed Software Engineer - Japan Forward Deployed",
  "Forward Deployed Software Engineer  - Edge Autonomous Systems",
  "Software Engineer, Forward Deployed AI",
  "Software Engineer, Forward Deployed Agent Builder",
  // product / strategy
  "Product Engineer",
  "Software Engineer, Product",
  "Product Software Engineer",
  "Full Stack Product Engineer",
  "Software Engineer, Strategy",
  "Deployment Strategist",
  "Strategic Software Engineer",
];
for (const t of EXEMPT) ok(!isCodingInterviewRole(t), `EXEMPT: ${t}`);

/* ------------------------------------ 3. not an engineering title at all */
for (const t of [
  "Associate Product Manager, New Grad (2027 Start)",
  "Deployment Strategist, New Grad",
  "Business Analyst",
  "Chief of Staff",
  "Mission Operations Specialist",
  "Investment Analyst",
]) ok(!isCodingInterviewRole(t), `untouched: ${t}`);

/* --------------------------------------------------- 4. word boundaries */
// Bare substrings have cost this repo four separate bugs: `intern` killed every
// International role, `iv` killed Activity and Drive, `lead` killed Leadership.
// "GenSWE" must not make \bswe\b fire. Tested on a title that contains it and
// NOTHING else the rule looks for — asserting it on Anduril's real
// "Mission Software Engineer, …, GenSWE" would prove nothing, because that one
// is caught by "software engineer" whatever \bswe\b does.
ok(!isCodingInterviewRole("Autonomy GenSWE Lead"), "'swe' inside 'GenSWE' does not fire");
ok(isCodingInterviewRole("Mission Software Engineer, Air Vehicle Autonomy, GenSWE"),
   "and that real Anduril title is still caught, on 'software engineer'");
ok(!isCodingInterviewRole("Answer Engineer"), "'swe' inside 'Answer' does not fire");
ok(!isCodingInterviewRole("Sweden Operations Lead"), "'swe' inside 'Sweden' does not fire");
ok(!isCodingInterviewRole(""), "an empty title is not a coding role");
ok(!isCodingInterviewRole(null), "a null title is not a coding role");
ok(!isCodingInterviewRole(undefined), "an undefined title is not a coding role");

/* ------------------------------------------------ 5. the verb it produces */
// "Dated for the owner's class" is the BAKED class, never a literal year.
const dated = (title) => ({ title, entry_level: "entry", class_year: CLASS_YEAR, company: "x" });

ok(computePrimaryAction(dated("Software Engineer, New Grad"), 0) === "watch",
   "a dated coding role that WOULD have been apply becomes watch");
ok(codingBlocked(dated("Software Engineer, New Grad"), 0) === true,
   "and reports itself as blocked, so the row can say why");
ok(primaryActionFor(dated("Software Engineer, New Grad"), {}).note === CODING_NOTE,
   `and carries the note "${CODING_NOTE}"`);

ok(computePrimaryAction(dated("Forward Deployed Software Engineer, New Grad - US Government"), 0)
   === "apply",
   "THE CANARY: Palantir's FDSE New Grad is still APPLY");
ok(primaryActionFor(dated("Forward Deployed Software Engineer, New Grad - US Government"), {}).note
   === null,
   "and carries no note");

// ONLY FROM apply. An open-now coding role keeps find_person: getting a name at
// the company is worth doing whether or not this req is his loop, and 22 roles
// sit in exactly that state today.
const openNow = { title: "Software Engineer, Public Sector", entry_level: "entry", company: "y" };
ok(computePrimaryAction(openNow, 0) === "find_person",
   "an open-now coding role keeps find_person — the rule only demotes from apply");
ok(codingBlocked(openNow, 0) === false, "and is not reported as blocked");

// A non-coding dated role is untouched in both respects.
const apm = dated("Associate Product Manager, New Grad (2027 Start)");
ok(computePrimaryAction(apm, 0) === "apply", "a dated APM is still apply");
ok(primaryActionFor(apm, {}).note === null, "and has no note");

/* ------------------------------------------- 6. the patterns are not inert */
// Proof the rule can fail rather than being vacuously true: every term must
// match something, and every qualifier must exempt something.
for (const re of CODING_TERMS) {
  ok(CAUGHT.some((t) => re.test(t.toLowerCase())), `term ${re} matches a real title`);
}
for (const re of CODING_QUALIFIERS) {
  ok(EXEMPT.some((t) => re.test(t.toLowerCase())), `qualifier ${re} exempts a real title`);
}
ok(CAUGHT.length >= 20 && EXEMPT.length >= 15,
   `both directions are actually populated (${CAUGHT.length} caught, ${EXEMPT.length} exempt)`);

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
