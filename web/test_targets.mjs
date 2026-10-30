/**
 * Planning targets are not deadlines. Run: node test_targets.mjs
 *
 * A PLANNING TARGET is a date the owner set for themselves — "have ZS materials ready
 * by 15 Sept" — for a firm that has published no date at all. An OFFICIAL
 * deadline is one the employer stated. Rendering the first as the second is the
 * McKinsey failure in a new costume: a date nobody at the firm ever set,
 * dressed as a countdown, acted on as if missing it lost the cycle — or worse,
 * treated as the cutoff when the real one lands earlier.
 *
 * So the two have to be different KINDS of thing all the way down, not one
 * field with a label beside it:
 *
 *   - the date lives in `target`, never in `closes`, and the shaper REFUSES a
 *     row that puts a planning date in `closes` rather than quietly rendering
 *     it as a company deadline;
 *   - the date cell every table draws from says "your target", never "closes";
 *   - the confidence chip has its own tone, so it cannot fall back to
 *     "estimated" — which would claim the FIRM's date was being estimated.
 *
 * The first block is the red-first proof: fed a planning target through the
 * shaper as `closes`, it used to come out with the same closeIn and the same
 * urgent flag as the official deadline beside it. Indistinguishable.
 */
import { parseDeadlines, shapeWindow, getDeadlines } from "./lib/deadlines.js";
import { windowDateCell } from "./lib/display.js";
import { verificationOf, VERIFICATION_LABEL } from "./lib/chips.js";
import { daysUntil, daysFromToday } from "./lib/day.js";

let pass = 0;
const fails = [];
const is = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? pass++
    : fails.push(`${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
const ok = (cond, what) => is(!!cond, true, what);

// BOTH FROM day.js. The local `daysUntil` here was a copy of the
// implementation's own arithmetic, so it agreed with the code by reproducing
// its off-by-one -- and a fixture date built from a UTC instant made the two
// wrong in the same direction, which is how a mirrored helper passes.
const day = (days) => daysFromToday(days);

const D = day(12);

// The same flat shape companies.yaml uses, so the parser is on the path too.
const YAML = `
companies: []

deadlines:
  - firm: Analysis Group
    program: Analyst, undergraduate
    class_year: 2027
    opens: null
    closes: ${D}
    status: open
    confidence: verified
    verified: ${day(0)}
    note: Employer-stated.

  - firm: Bad Row
    program: A planning date stored where a deadline goes
    class_year: 2027
    opens: null
    closes: ${D}
    status: unconfirmed
    confidence: planning-target
    verified: ${day(0)}
    note: This row is the failure being guarded against.

  - firm: ZS Associates
    program: Business Technology / Strategy Associate
    class_year: 2027
    opens: null
    closes: null
    target: ${D}
    status: unconfirmed
    confidence: planning-target
    verified: ${day(0)}
    note: No national date. My own readiness date.

  - firm: Microsoft PM
    program: Product Manager, university / new grad
    class_year: 2027
    opens: null
    closes: null
    rolling: true
    status: open
    confidence: verified
    verified: ${day(0)}
    note: No cutoff. Reqs open at least five days, then until filled.
`;

const rows = parseDeadlines(YAML);
is(rows.map((r) => r.firm), ["Analysis Group", "Bad Row", "ZS Associates", "Microsoft PM"],
   "the parser reads all four rows, including the new keys");

const [official, bad, target, rolling] = rows;

// ------------------------------------------- 1. the refusal (red-first proof)
{
  let threw = null;
  let shaped = null;
  try { shaped = shapeWindow(bad); } catch (e) { threw = e; }
  const o = shapeWindow(official);
  ok(threw,
     "a planning target stored in `closes` is REFUSED, not rendered"
     + (shaped
        ? ` — today it shapes to closeIn=${shaped.closeIn} urgent=${shaped.urgent},`
          + ` identical to the official deadline (closeIn=${o.closeIn} urgent=${o.urgent})`
        : ""));
  ok(threw && /planning-target/.test(threw.message) && /closes/.test(threw.message),
     "and the refusal names both the confidence and the field");
}

// ------------------------------------------------ 2. the shape of a target
{
  const t = shapeWindow(target);
  is(t.closes, null, "a planning target has no close date");
  is(t.closeIn, null, "so it has no countdown to a close");
  is(t.urgent, false, "and can never be urgent — urgency is the world's, not his");
  is(t.targetIn, daysUntil(D), "the target has its own day count");
  is(t.target, D, "and the date itself survives the shaper");

  const o = shapeWindow(official);
  is(o.targetIn, null, "an official deadline has no target day count");
  is(o.closeIn, daysUntil(D), "and its countdown is unchanged");
}

// ------------------------------------------------- 3. the cell every table draws
{
  const o = windowDateCell(shapeWindow(official));
  const t = windowDateCell(shapeWindow(target));
  const r = windowDateCell(shapeWindow(rolling));

  is(o.kind, "closes", "an official date is a close");
  is(o.text, D, "and renders as the bare date, as it always has");

  is(t.kind, "target", "a planning target is its own kind");
  ok(t.text !== o.text, "the two cells cannot read the same for the same day");
  ok(/your target/i.test(t.text), "a target says whose date it is");
  ok(!/close/i.test(t.text), "and never uses the word the firm's date uses");

  is(r.kind, "rolling", "a rolling window with no cutoff is its own kind too");
  ok(/rolling/i.test(r.text), "and says so — 'not confirmed' beside a confirmed chip was a contradiction");

  const none = windowDateCell(shapeWindow({ ...official, closes: null, confidence: "historical-estimate" }));
  is(none.kind, "none", "no date of any kind is still a state");
}

// ------------------------------------------------------------- 4. the chip
{
  is(verificationOf("planning-target").tone, "self",
     "a planning target has its own tone — falling back to 'estimated' would claim the firm's date was being guessed");
  is(VERIFICATION_LABEL["planning-target"], "your target", "and its own word");
  ok(verificationOf("planning-target").why.toLowerCase().includes("you"),
     "the hover says it is his date");
}

// ------------------------------------------- 5. the real file obeys the rule
//
// THE SHIPPED companies.yaml CARRIES NO PLANNING TARGET. A planning target is
// a date the owner set for themselves, which is exactly the kind of fact a
// template cannot hold -- so the count is not asserted. The INVARIANTS are:
// every row the file does carry obeys the target/closes rule, and the parser
// read a real number of windows rather than matching nothing.
{
  const real = getDeadlines();
  ok(real.length >= 10, `companies.yaml parsed (${real.length} windows)`);
  const targets = real.filter((d) => d.confidence === "planning-target");
  for (const d of targets) {
    is(d.closes, null, `${d.firm}: a planning target row has closes: null`);
    ok(d.target, `${d.firm}: and carries a target date`);
  }
  for (const d of real.filter((d) => d.target)) {
    is(d.confidence, "planning-target",
       `${d.firm}: a row with a target is labelled planning-target — a target on an official row would hide which date is whose`);
  }
}

console.log(`${pass} passed`);
if (fails.length) {
  console.log(`${fails.length} FAILED`);
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
