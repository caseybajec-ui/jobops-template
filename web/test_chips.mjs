/**
 * The chip component: three variants, every state. Run: node test_chips.mjs
 *
 * A snapshot in the useful sense — the full grid of variant × state printed as
 * a table and asserted against, so a change to one rule shows up as a diff on
 * the row it affects rather than as a page that looks slightly different.
 *
 * WHY THE GRID AND NOT A HANDFUL OF CASES. Colour carries exactly five meanings
 * in this app and three of them live in chips; a chip that renders the wrong
 * tone is not a cosmetic bug, it is the tool saying a date is confirmed when a
 * human has never read it. The states are cheap to enumerate and the cost of
 * missing one is a wrong claim.
 *
 * It also checks that every class the rules produce has a rule behind it, which
 * is the failure that has no symptom: an unstyled chip renders as plain text,
 * nothing errors, and it reads as a label somebody forgot to finish.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  urgencyOf, verificationOf, chipClass, URGENCY_STEPS, VERIFICATION,
  URGENCY_SENTENCE,
} from "./lib/chips.js";
import { inDays } from "./lib/plural.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(here, "app/globals.css"), "utf8");

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ------------------------------------------------------ urgency × days × kind */

const DAYS = [-3, 0, 1, 3, 7, 8, 20, 30, 31, 400];
const WANT_TONE = {
  "-3": "today", 0: "today", 1: "now", 3: "now", 7: "now",
  8: "soon", 20: "soon", 30: "soon", 31: "later", 400: "later",
};

console.log("\n  urgency");
console.log("  days   kind      tone     class");
console.log("  " + "-".repeat(66));
for (const d of DAYS) {
  for (const kind of ["external", "self"]) {
    const u = urgencyOf(d, kind);
    const cls = chipClass("urgency", u.tone, u.outlined);
    eq(u.tone, WANT_TONE[d], `${d} days is ${WANT_TONE[d]}`);
    ok(u.outlined === (kind === "self"), `${kind} ${d}: outlined iff self-imposed`);
    console.log(`  ${String(d).padStart(4)}   ${kind.padEnd(9)} ${u.tone.padEnd(8)} ${cls}`);
  }
}

// OVERDUE IS LOUDER THAN TODAY, never quieter. It used to fall off the bottom
// of the scale and render grey — the wrong answer in the one case where being
// wrong cannot be undone.
eq(urgencyOf(-30).tone, "today", "thirty days overdue is not 'later'");

// Nothing in, nothing out. A window with no date must render no chip at all
// rather than a grey one, because a grey chip is a claim that it is far away.
eq(urgencyOf(null), null, "no date, no chip");
eq(urgencyOf(undefined), null, "and undefined is not zero");
eq(urgencyOf("soon"), null, "and a non-number is not a day count");

ok(URGENCY_STEPS.length === 4, "four steps, and the ranges tile without a gap");
{
  // Every integer from 0 to 400 lands in exactly one step. A gap between 7 and
  // 8, or an overlap, is invisible until the one day it renders nothing.
  let bad = [];
  for (let d = 0; d <= 400; d++) {
    const hits = URGENCY_STEPS.filter(([, lo, hi]) => d >= lo && d <= hi);
    if (hits.length !== 1) bad.push(d);
  }
  ok(bad.length === 0, `every day 0-400 in exactly one step (bad: ${bad.slice(0, 5)})`);
}

/* ---------------------------------------------------------- verification */

console.log("\n  verification");
console.log("  confidence              tone          class");
console.log("  " + "-".repeat(66));
for (const c of [...Object.keys(VERIFICATION), "nonsense", null, undefined]) {
  const v = verificationOf(c);
  const cls = chipClass("verification", v.tone, v.tone !== "confirmed");
  console.log(`  ${String(c).padEnd(23)} ${v.tone.padEnd(13)} ${cls}`);
}
eq(verificationOf("verified").tone, "confirmed", "only 'verified' is confirmed");
eq(verificationOf("secondary-source").tone, "weak", "two trackers is weak evidence");
eq(verificationOf("historical-estimate").tone, "unconfirmed", "last year is an estimate");

// FAIL SAFE, in the direction that costs nothing. An unrecognised confidence
// value reads as unconfirmed, never as confirmed: the McKinsey note said
// "typically mid/late September" for a window that had shut on 11 August, and
// the whole point of this chip is that a guess must not render like a fact.
eq(verificationOf("something-new").tone, "unconfirmed",
   "an unknown confidence is UNCONFIRMED, never confirmed");
eq(verificationOf(null).tone, "unconfirmed", "and a missing one is too");
ok(verificationOf("verified").why.includes("own site"),
   "the tooltip says what confirmed actually means");

/* --------------------------------------------------------------- status */

eq(chipClass("status", null, false), "chip chip-status", "status takes no tone");

/* ------------------------------------------- every class has a rule behind it */

const classes = new Set();
for (const d of DAYS) for (const k of ["external", "self"]) {
  const u = urgencyOf(d, k);
  chipClass("urgency", u.tone, u.outlined).split(" ").forEach((c) => classes.add(c));
}
for (const c of Object.keys(VERIFICATION)) {
  const v = verificationOf(c);
  chipClass("verification", v.tone, true).split(" ").forEach((x) => classes.add(x));
}
chipClass("status").split(" ").forEach((c) => classes.add(c));

const missing = [...classes].filter((c) => !new RegExp(`\\.${c}[\\s,{.:]`).test(css));
ok(missing.length === 0,
   `every chip class has a rule in globals.css (missing: ${missing.join(", ")})`);
console.log(`\n  ${classes.size} distinct chip classes, all styled`);

// Prove that check can fail — otherwise "all styled" is indistinguishable from
// a regex that matches nothing.
ok(!new RegExp(`\\.chip-nonexistent[\\s,{.:]`).test(css),
   "the negative control: a class that does not exist is not found");

/* ------------------------------------------------------------ the copy */

ok(URGENCY_SENTENCE.includes("week") && URGENCY_SENTENCE.includes("month")
   && URGENCY_SENTENCE.includes("outline"),
   "the one urgency sentence describes all three steps and the outline");
eq(inDays(1), "tomorrow", "one day out is a word, not 'in 1 day'");
eq(inDays(0), "today", "and zero is 'today', never 'in 0 days'");
eq(inDays(2), "in 2 days", "two is a count");
eq(inDays(-1), "1 day ago", "and behind is behind");

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log("\nFAILED:"); for (const f of fails) console.log("  " + f); }
process.exit(fails.length ? 1 : 0);
