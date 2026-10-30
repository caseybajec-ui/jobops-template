/**
 * The clearance predicate itself. Run: node test_clearance.mjs
 *
 * This is the test the dead assertion needed and did not have. That one was a
 * regex written inline in a browser test, fired at one page's text; when its
 * escapes collapsed into control bytes it matched nothing and reported success,
 * for weeks, on the rule that becomes a false claim on a federal form if it goes
 * wrong.
 *
 * The predicate lives in lib/clearance.js now, and this fires it at both halves
 * of the rule: every phrasing that must be caught, and every phrasing that must
 * NOT be — because a pattern tuned only against violations happily flags the
 * permitted sentence too, and then the tool cannot say the one true thing it is
 * allowed to say.
 *
 * It also proves the pattern is not inert, which is the specific failure mode
 * that started all this.
 */
import { FORBIDDEN, FORBIDDEN_SOURCES, forbiddenClaim, PERMITTED_STATEMENT }
  from "./lib/clearance.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));

/* ------------------------------------------------ the pattern is not inert */
//
// FIRST, because everything below is meaningless if the regex cannot match
// anything at all. That is not hypothetical here: it is what happened.

ok(FORBIDDEN.source.length > 40, "the pattern has real content");
ok(!/[\x00-\x08\x0b\x0c\x1b]/.test(FORBIDDEN.source),
   "and contains no control byte — the exact way the last one died");
ok(FORBIDDEN_SOURCES.every((s) => s.includes("\\b")),
   "every clause is word-bounded, and the boundaries survived as two characters");
ok(FORBIDDEN.test("is cleared"), "the simplest violation matches");

/* ------------------------------------------------------- must be caught */

const FORBIDDEN_TEXT = [
  "He is cleared for this role.",
  "You are cleared at the Secret level.",
  "Jordan holds an active clearance.",
  "Maintains a current clearance.",
  "He holds a TS/SCI clearance.",
  "A clearance-eligible candidate.",
  "You are eligible for TS/SCI.",
  "You're eligible, so lead with that.",
  "Eligible for a Top Secret clearance.",
  "Eligible for a security clearance.",
  "His eligibility has been confirmed.",
  "Eligibility is established.",
  "A clearance would be granted on request.",
  "Cleared to Top Secret.",
];
for (const t of FORBIDDEN_TEXT) {
  const hit = forbiddenClaim(t);
  ok(hit !== null, `CAUGHT: ${JSON.stringify(t)}`);
}

/* ------------------------------------------------------ must be allowed */
//
// The other half, and the one a pattern tuned only against violations gets
// wrong. If these trip, the tool cannot state the position it IS permitted to
// state, and every surface starts saying nothing at all — which reads to a
// defense recruiter as evasion.

const PERMITTED_TEXT = [
  PERMITTED_STATEMENT,
  "US citizen, no sponsorship required.",
  "No current or prior clearance.",
  "No known disqualifying factors.",
  "Willing to undergo the clearance process.",
  "The employer sponsors the clearance. That is the version open to you.",
  "The posting asks for eligibility rather than a clearance already held.",
  "The posting requires a clearance the holder already has.",
  "No clearance mentioned in the posting.",
  "Expect the citizenship and clearance question.",
  // The posting's OWN words, quoted back. A role that says "must be eligible"
  // is describing its requirement, not making a claim about the owner — and the
  // gate classifier depends on being able to repeat it.
  "Must hold or be eligible for a U.S. Secret security clearance.",
  "This role requires an active U.S. government security clearance.",
  // NEGATED POSSESSION, which is the form a cover note actually takes.
  // CLAUDE.md says he MAY state 'that he holds no current or prior
  // clearance' -- and these were all being flagged, because the pattern
  // matched the noun phrase without looking at the word in front of it.
  //
  // Found on a REAL generated draft: the top-scoring Palantir Deployment
  // Strategist cover note says 'I have no active clearance and no prior
  // government deployment experience, but I am a US citizen needing no
  // sponsorship'. That is the correct sentence, and a write-time guard
  // using this predicate would have rejected it and re-packed the role
  // forever, paying each time to regenerate text that was already right.
  "I have no active clearance and no prior government deployment experience.",
  "I hold no active clearance.",
  "He holds no current clearance.",
  "I do not have a current clearance.",
  "Jordan has never held an active clearance.",
  "Applying without an active clearance.",
  "He holds no TS/SCI clearance.",
];
for (const t of PERMITTED_TEXT) {
  const hit = forbiddenClaim(t);
  ok(hit === null, `ALLOWED: ${JSON.stringify(t)}${hit ? ` — wrongly flagged on ${JSON.stringify(hit)}` : ""}`);
}

/* --------------------------------------------------------- what it returns */

/* NEGATION IS NOT A BYPASS. Excusing a negated noun phrase must not excuse
 * an outright assertion that happens to have a stray 'no' earlier in the
 * sentence -- that would turn the fix into a hole in the rule that matters
 * most. Only possession and eligibility phrases are negatable; the flat
 * assertions ("is cleared", "cleared to TS/SCI") never are. */
// ADJACENT negator: the sentence below has three words between "no" and the
// phrase, so NEGATOR cannot reach it and the case cannot tell a working
// guard from a broken one. These two can -- one word away, excused the
// instant assertions become negatable.
ok(forbiddenClaim("No one is cleared for this programme.") === "is cleared",
   "an adjacent negator does not excuse `is cleared` either");
ok(forbiddenClaim("Not everyone is cleared.") === "is cleared",
   "nor does `Not` one word away");
ok(forbiddenClaim("There is no doubt that he is cleared.") === "is cleared",
   "a stray negator earlier in the sentence does not excuse `is cleared`");
ok(forbiddenClaim("No question, he is cleared to TS/SCI.") !== null,
   "nor `cleared to TS/SCI`");
ok(forbiddenClaim("He has an active clearance.") === "active clearance",
   "and an UNnegated possession is still caught");
ok(forbiddenClaim("She holds a current clearance.") !== null,
   "as is holding one");
ok(forbiddenClaim("He is cleared.") === "is cleared",
   "it returns the offending phrase, not just true");
ok(forbiddenClaim("") === null, "empty text claims nothing");
ok(forbiddenClaim(null) === null, "and neither does nothing at all");
ok(forbiddenClaim(undefined) === null, "or undefined");

/* ---------------------------------------- every surface that renders words */
//
// The four places the rule applies, checked through the real modules rather
// than through a copy of their text. A new surface that renders clearance
// wording belongs in this list.

const { gateFacts } = await import("./lib/why.js");
const gate = (job, key) => gateFacts(job).find((g) => g.key === key);
for (const status of ["required_active", "sponsorable", "eligibility_only",
                      "none_mentioned", undefined]) {
  const t = gate({ clearance_status: status }, "clearance").text;
  const hit = forbiddenClaim(t);
  ok(hit === null,
     `why.js, clearance_status=${status}: ${hit ? `claims ${JSON.stringify(hit)}` : "makes no claim"}`);
}

const { PREP_CHECKLISTS } = await import("./lib/lifecycle.js");
for (const [key, c] of Object.entries(PREP_CHECKLISTS)) {
  const text = [...(c.research || []), ...(c.questions || [])].join(" ");
  const hit = forbiddenClaim(text);
  ok(hit === null,
     `lifecycle.js, ${key} checklist: ${hit ? `claims ${JSON.stringify(hit)}` : "makes no claim"}`);
}

// And the one it must SAY. The defense checklist is the surface that puts these
// words in front of the owner right before an interview, so it has to state the
// position rather than merely avoid the forbidden one.
{
  const defense = PREP_CHECKLISTS.defense_ops.questions.join(" ");
  ok(/no current or prior clearance|no known disqualifying/i.test(defense),
     "the defense checklist states the permitted position out loud");
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
