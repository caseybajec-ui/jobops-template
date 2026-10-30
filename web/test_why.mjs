/**
 * The fit explainer. Run: node test_why.mjs
 *
 * Two things worth asserting, and they are both about honesty rather than about
 * logic:
 *
 *   IT INVENTS NOTHING. Every sentence is a translation of a column the
 *   pipeline already wrote. A role with no scorer output must produce an
 *   explanation that says so, not a plausible-sounding one — an explainer that
 *   fills in blanks is worse than no explainer, because it is believed.
 *
 *   THE CLEARANCE WORDING HOLDS. This is one more surface where the tool writes
 *   sentences about clearance, and CLAUDE.md's rule is absolute: it may say what
 *   the POSTING requires and what the employer sponsors. It may never say the owner
 *   is cleared or eligible, because that is an adjudicator's determination.
 */
import {
  gateFacts, confidenceText, bandText, whyThisFit,
} from "./lib/why.js";
import { NEW_GRAD_PAY_CEILING } from "./lib/display.js";
import { forbiddenClaim } from "./lib/clearance.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

const gate = (job, key) => gateFacts(job).find((g) => g.key === key);

/* ----------------------------------------------------------------- the gates */

eq(gate({ entry_level: "program" }, "level").pass, true, "a named programme passes the level gate");
eq(gate({ entry_level: "entry" }, "level").pass, true, "open-to-new-grads passes");
eq(gate({ entry_level: "experienced" }, "level").pass, false, "wants-experience does not");
// FAIL OPEN. An unclassified role is let through, and the explanation says so
// rather than implying the tool knows something it does not.
eq(gate({}, "level").pass, false, "an unlabelled role does not claim to pass");
ok(/let through rather than dropped/.test(gate({}, "level").text),
   "and says it was let through rather than judged");

eq(gate({ class_fit: "wrong_year" }, "class").pass, false, "the wrong class year fails");
eq(gate({ class_fit: "ok" }, "class").pass, true, "the right one passes");
ok(gate({ class_fit: "wrong_year", class_year: "2026" }, "class").text.includes("2026"),
   "and names the year it is actually for");

eq(gate({ clearance_status: "required_active" }, "clearance").pass, false,
   "a clearance the holder must already have is a blocker");
eq(gate({ clearance_status: "sponsorable" }, "clearance").pass, true,
   "a sponsored one is not");
eq(gate({ clearance_status: "eligibility_only" }, "clearance").pass, true,
   "and neither is one that asks only for eligibility");

// THE HARD RULE, checked across every clearance state this can render.
for (const status of ["required_active", "sponsorable", "eligibility_only",
                      "none_mentioned", undefined]) {
  const t = gate({ clearance_status: status }, "clearance").text;
  // ONE predicate, from lib/clearance.js. This was a private regex here, a
  // different one in test_lifecycle, a third in test_sf86 and a fourth in
  // test_writes — and the fourth died silently for weeks. A rule enforced in
  // four places has four chances to rot.
  const claim = forbiddenClaim(t);
  ok(claim === null,
     `the clearance text for ${status} claims no determination about the owner`
     + `${claim ? ` — it says ${JSON.stringify(claim)}` : ""} ("${t.slice(0, 60)}…")`);
}

// Years of experience: extracted by a regex and compared IN CODE. A model asked
// to compare two integers gets it wrong often enough to have killed real roles.
eq(gate({ yoe: 2 }, "yoe").pass, true, "two years is within reach");
eq(gate({ yoe: 5 }, "yoe").pass, false, "five is not");
eq(gate({}, "yoe"), undefined, "and a posting that states no number gets no line at all");

eq(gate({ comp_min: NEW_GRAD_PAY_CEILING + 50000, entry_level: "entry" }, "pay").pass, false,
   "a floor above the new-grad ceiling on a non-programme role fails the pay gate");
eq(gate({ comp_min: NEW_GRAD_PAY_CEILING + 50000, entry_level: "program" }, "pay").pass, true,
   "but a named programme is exempt — the ceiling is a heuristic about seats, not about programmes");
eq(gate({}, "pay"), undefined, "unpublished pay gets no line, rather than a guess");

/* ------------------------------------------------------------- the number */

ok(/Scored once/.test(confidenceText({ n_samples: 1, score_spread: 0 })),
   'a single run reads "Scored once", not "Scored 1 times"');
ok(/stable/.test(confidenceText({ n_samples: 3, score_spread: 2, score_lo: 71, score_hi: 73 })),
   "a tight spread says so");
ok(/disagreed with ITSELF/.test(
     confidenceText({ n_samples: 3, score_spread: 30, score_lo: 55, score_hi: 85 })),
   "and a wide one says to ignore the number — that is the caveat everything else on the page hides");

ok(bandText(92).includes("92 of 100"), "the band text states the raw number");
ok(bandText(72).includes("85"), "and what it would have taken to reach the band above");
ok(!/would have made it/.test(bandText(92)), "the top band has nothing above it to name");

/* -------------------------------------------------------------- assembled */

{
  const w = whyThisFit({ score: 40, entry_level: "experienced",
                         clearance_status: "required_active", reasons: [], gaps: [] });
  eq(w.blocked.length, 2, "two blockers are separated out from the passes");
  ok(w.blocked.every((b) => b.pass === false), "and every one of them is a failure");
}

// NOTHING INVENTED. A role the scorer never wrote reasons for produces an
// explanation that says so; an explainer that fills in blanks is worse than
// none, because it gets believed.
{
  const w = whyThisFit({ score: 0 });
  eq(w.reasons, [], "no reasons means no reasons");
  eq(w.gaps, [], "and no gaps means no gaps");
  eq(w.model, null, "and an unrecorded model is null rather than a plausible name");
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
