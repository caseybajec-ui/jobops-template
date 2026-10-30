/**
 * The SF-86 pack's date arithmetic. Run: node test_sf86.mjs
 *
 * The gap detector is the only thing here worth real testing, and it is worth a
 * lot: a form comes back because of a month nobody accounted for between two
 * addresses, and that is invisible in a list sorted by any field — you have to
 * lay the spans end to end. If this is wrong it is wrong quietly, and it is
 * wrong on the one thing the section exists for.
 *
 * The completeness number gets the same scrutiny for a different reason: a
 * percentage that says you are finished when you are not is worse than no
 * percentage, because it is the thing that decides whether the owner goes and finds
 * a supervisor's phone number this month or next.
 */
import {
  SECTIONS, SECTION_KEYS, SEED, ADDRESS_YEARS, FIELD_KEYS, AFFIRMABLE,
  validYm, months, addMonths, ymOf, coverage, completeness, asText,
  employmentOverlaps,
} from "./lib/sf86.js";
import { forbiddenClaim } from "./lib/clearance.js";
import fs from "node:fs";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

const NOW = new Date("2026-09-16T00:00:00Z");

/* ---------------------------------------------------------------- the shape */

eq(SECTION_KEYS, ["address", "employer", "travel", "contact"], "four sections");
for (const s of SECTIONS) {
  ok(s.required.length > 0, `${s.key} says what it needs`);
  ok(s.required.every((f) => s.fields.some(([k]) => k === f)),
     `${s.key}'s required fields all exist on it`);
  ok(s.fields.every(([k]) => FIELD_KEYS.includes(k)),
     `${s.key} uses only columns the table has`);
}
// The supervisor's contact details are genuinely required by the form, and they
// are the part nobody has written down. A completeness score that ignored the
// hard fields would report "done" on a pack that is not.
ok(SECTION_BY_REQUIRED("employer").includes("contact"),
   "an employer is not complete without a way to reach the supervisor");
function SECTION_BY_REQUIRED(k) { return SECTIONS.find((s) => s.key === k).required; }

// THE TEMPLATE SEEDS NOTHING. The original pre-filled two of its owner's
// trips; a template holds no such fact, and a seeded row that is wrong about
// the next owner is worse than an empty section on a form signed under
// penalty of perjury. The list stays, as the one place an owner may pre-fill
// their own rows -- and any row they add must still carry BLANK dates.
eq(SEED.length, 0, "nothing personal is pre-seeded");
ok(SEED.every((s) => s.from_ym === null && s.to_ym === null),
   "and any seeded row has BLANK dates — an empty field asks a question, a wrong one does not");

/* ----------------------------------------------------------------- the dates */

ok(validYm("2026-09"), "YYYY-MM is a date here");
ok(!validYm("2026-13"), "month 13 is not");
ok(!validYm("2026-09-16"), "and a full day is not — the form asks for month and year");
ok(!validYm(""), "nor is nothing");
eq(months("2026-09") - months("2025-09"), 12, "a year is twelve months");
eq(addMonths("2026-01", -1), "2025-12", "subtracting across a year boundary");
eq(ymOf(NOW), "2026-09", "today as a month");

/* ---------------------------------------------------------------- the gaps */

// A clean run with no holes, covering the whole window.
{
  const c = coverage([
    { label: "A", from_ym: "2016-06", to_ym: "2020-08" },
    { label: "B", from_ym: "2020-08", to_ym: "2023-05" },
    { label: "C", from_ym: "2023-05", to_ym: null },
  ], NOW);
  eq(c.gaps.length, 0, "back-to-back addresses covering the window have no gaps");
  ok(c.complete, "and the run reads as complete");
  eq(c.coveredMonths, c.totalMonths, "every month accounted for");
}

// THE FAILURE THIS EXISTS FOR: a hole in the middle that no sort order shows.
{
  const c = coverage([
    { label: "A", from_ym: "2016-06", to_ym: "2020-08" },
    { label: "C", from_ym: "2021-02", to_ym: null },
  ], NOW);
  eq(c.gaps.length, 1, "a six-month hole between two addresses is found");
  eq(c.gaps[0].months, 6, "and measured");
  eq([c.gaps[0].fromYm, c.gaps[0].toYm], ["2020-08", "2021-02"], "and dated at both ends");
  ok(!c.complete, "so the run is not complete");
}

// A hole at the START of the window: only five years of history on a ten-year
// question. Easy to miss, because every row present is correct.
{
  const c = coverage([{ label: "C", from_ym: "2021-09", to_ym: null }], NOW);
  eq(c.gaps.length, 1, `five years of history against a ${ADDRESS_YEARS}-year window leaves a gap`);
  eq(c.gaps[0].months, 60, "sixty months of it");
}

// A hole at the END — moved out and never said where to.
{
  const c = coverage([{ label: "A", from_ym: "2016-06", to_ym: "2025-09" }], NOW);
  eq(c.gaps[c.gaps.length - 1].months, 12, "a year since the last address ended is a gap");
}

// An undated row is an unanswered QUESTION, not a span. Giving it a start would
// close a hole that is really still open.
{
  const c = coverage([
    { label: "A", from_ym: "2016-06", to_ym: "2020-08" },
    { label: "B", from_ym: null, to_ym: null },
    { label: "C", from_ym: "2021-02", to_ym: null },
  ], NOW);
  eq(c.gaps.length, 1, "an undated row does not silently fill the gap it sits next to");
  eq(c.spans.length, 2, "and is not counted as a span");
}

// Overlapping spans are fine and common — you sign a new lease before the old
// one ends — and must not be reported as anything.
{
  const c = coverage([
    { label: "A", from_ym: "2016-06", to_ym: "2021-03" },
    { label: "B", from_ym: "2020-08", to_ym: null },
  ], NOW);
  eq(c.gaps.length, 0, "overlapping addresses are normal, not a problem");
}

// A span ending before it starts is a typo. Flagged, never quietly reordered
// into something plausible.
{
  const c = coverage([{ label: "A", from_ym: "2022-06", to_ym: "2020-01" }], NOW);
  eq(c.broken.length, 1, "a backwards span is surfaced as broken");
}

eq(coverage([], NOW).gaps.length, 1, "no addresses at all is one big gap, not zero gaps");
ok(!coverage([], NOW).complete, "and is certainly not complete");

/* ------------------------------------------------------------ completeness */

// EMPTY IS ZERO, NOT A HUNDRED. "Nothing to do" and "nothing done" must not
// look the same — the same failure as an empty section reading as a quiet day.
{
  const c = completeness([], NOW);
  eq(c.pct, 0, "an empty pack is 0% complete, never 100");
  for (const k of SECTION_KEYS) eq(c.per[k].pct, 0, `${k} starts at zero`);
}

// Well-filled rows that still leave a hole are NOT a complete address history.
{
  const entries = [
    { section: "address", label: "A", from_ym: "2016-06", to_ym: "2020-08" },
    { section: "address", label: "C", from_ym: "2021-02", to_ym: null },
  ];
  const c = completeness(entries, NOW);
  ok(c.per.address.pct < 100,
     `every address row is filled in but there is a six-month hole, so it is ${c.per.address.pct}% and not 100%`);
  eq(c.per.address.complete, 2, "both rows are individually complete");
}

// A row missing a required field drags its section down even with full coverage.
{
  const entries = [
    { section: "employer", label: "Fund A", person: "A Name", contact: "a@b.co",
      from_ym: "2026-06", to_ym: "2026-08" },
    { section: "employer", label: "Fund B", person: "", contact: "",
      from_ym: "2025-06", to_ym: "2025-08" },
  ];
  eq(completeness(entries, NOW).per.employer.pct, 50,
     "one employer of two has a reachable supervisor");
}

/* ------------------------------------------------- "none" is an answer */

// A section the owner has answered "none" to is COMPLETE, not empty. But "none"
// has to be SAID — stored as its own timestamped field — never inferred from
// an empty list, because empty-means-none is the silent no-op this repo keeps
// producing: an unanswered section and an affirmed-none section must be
// different things in the database, on the page, and in the export.
eq(AFFIRMABLE, ["contact"], "foreign contacts is the section that can be answered 'none'");
{
  const unanswered = completeness([], NOW);
  eq(unanswered.per.contact.pct, 0, "no contacts and no affirmation is still 0% — unanswered");
  eq(unanswered.per.contact.affirmed, null, "and carries no affirmation");

  const affirmed = completeness([], NOW, { contact: "2026-09-03T18:00:00+00:00" });
  eq(affirmed.per.contact.pct, 100, "no contacts WITH the affirmation is 100% — answered");
  eq(affirmed.per.contact.affirmed, "2026-09-03T18:00:00+00:00", "and the timestamp travels with it");

  // With every other section complete, the affirmation is what gets the whole
  // pack to 100 — the point of the change.
  const full = [
    { section: "address", label: "A", from_ym: "2016-06", to_ym: null },
    { section: "employer", label: "Fund A", person: "A Name", contact: "a@b.co",
      from_ym: "2026-06", to_ym: "2026-08" },
    { section: "travel", country: "Australia", purpose: "exchange", from_ym: "2026-01", to_ym: "2026-06" },
  ];
  eq(completeness(full, NOW).pct, 75, "three sections done and contacts unanswered is 75");
  eq(completeness(full, NOW, { contact: "2026-09-03T18:00:00+00:00" }).pct, 100,
     "three sections done and contacts affirmed none is 100");

  // An affirmation beside listed contacts is a contradiction, not a score.
  const both = completeness([{ section: "contact", label: "X", country: "Y", purpose: "Z" }],
                            NOW, { contact: "2026-09-03T18:00:00+00:00" });
  ok(both.per.contact.conflict === true, "affirmed none AND a contact listed is flagged as a conflict");
  eq(both.per.contact.pct, 100, "the listed rows still score on their own merits");
}

// The export must tell the two apart in words.
{
  const none = asText([], NOW);
  ok(/FOREIGN CONTACTS\n\s+\(nothing recorded yet — UNANSWERED/.test(none),
     "unanswered says UNANSWERED in the export");
  const yes = asText([], NOW, { contact: "2026-09-03T18:00:00+00:00" });
  ok(/FOREIGN CONTACTS\n\s+Affirmed: no foreign contacts to report \(affirmed 2026-09-03/.test(yes),
     "affirmed none says so, with the date, in the export");
  ok(!/UNANSWERED/.test(yes.split("FOREIGN CONTACTS")[1].split("\n\n")[0]),
     "and does not also call it unanswered");
  const conflict = asText([{ id: "c1", section: "contact", label: "X", country: "Y", purpose: "Z" }],
                          NOW, { contact: "2026-09-03T18:00:00+00:00" });
  ok(/CONFLICT/.test(conflict), "affirmed none with a contact listed is called a CONFLICT in the export");
}

/* --------------------------------------------------- employment overlaps */

// An SF-86 with inconsistent employment dates comes back. Overlaps are not
// always wrong — two part-time jobs in the same spring are real — so this is
// a VISIBLE WARNING naming the pair and the shared months, never a silent fix.
{
  const rows = [
    { id: "g", section: "employer", label: "Fund A", from_ym: "2026-06", to_ym: "2026-08" },
    { id: "w", section: "employer", label: "Fund B", from_ym: "2025-06", to_ym: "2026-08" },
    { id: "d", section: "employer", label: "Duffl", from_ym: "2024-10", to_ym: "2025-05" },
    { id: "p", section: "employer", label: "Pour Les Femmes", from_ym: "2025-01", to_ym: "2025-06" },
    { id: "a", section: "address", label: "not an employer", from_ym: "2016-01", to_ym: null },
  ];
  const o = employmentOverlaps(rows);
  const pairs = o.map((x) => [x.a.label, x.b.label].sort().join("+")).sort();
  eq(pairs, ["Duffl+Pour Les Femmes", "Fund A+Fund B", "Fund B+Pour Les Femmes"],
     "every overlapping employer pair is named, and only employers");
  const gw = o.find((x) => x.a.label === "Fund A" || x.b.label === "Fund A");
  eq(gw.months, 3, "Fund A and the mis-dated Fund B share three months");
  eq([gw.fromYm, gw.toYm], ["2026-06", "2026-08"], "and the shared span is dated");
  const pw = o.find((x) => x.a.label === "Pour Les Femmes" && x.b.label === "Fund B"
                        || x.b.label === "Pour Les Femmes" && x.a.label === "Fund B");
  eq(pw.months, 1, "a same-month handover is one shared month, reported so he can judge it");
}
{
  eq(employmentOverlaps([
    { id: "d", section: "employer", label: "Duffl", from_ym: "2024-10", to_ym: "2025-05" },
    { id: "w", section: "employer", label: "Fund B", from_ym: "2025-06", to_ym: "2025-08" },
  ]), [], "back-to-back months do not overlap");
  eq(employmentOverlaps([
    { id: "x", section: "employer", label: "Undated", from_ym: null, to_ym: null },
    { id: "w", section: "employer", label: "Fund B", from_ym: "2025-06", to_ym: "2025-08" },
  ]), [], "an undated row is an unanswered question, not an overlap");
  const open = employmentOverlaps([
    { id: "b", section: "employer", label: "Startup", from_ym: "2026-01", to_ym: null },
    { id: "g", section: "employer", label: "Fund A", from_ym: "2026-06", to_ym: "2026-08" },
  ], NOW);
  eq(open.length, 1, "an open-ended job runs to now and overlaps a later one");
}
// And the export shows the warning, since the export is what gets typed in.
{
  const text = asText([
    { id: "g", section: "employer", label: "Fund A", person: "A", contact: "a@b", from_ym: "2026-06", to_ym: "2026-08" },
    { id: "w", section: "employer", label: "Fund B", person: "B", contact: "b@c", from_ym: "2025-06", to_ym: "2026-08" },
  ], NOW);
  ok(/OVERLAPPING DATES/.test(text) && /Fund A .*Fund B|Fund B .*Fund A/.test(text),
     "the export names the overlapping pair");
}

/* ---------------------------------------------------------------- the export */

{
  const entries = [
    { id: "1", section: "address", label: "A", from_ym: "2016-06", to_ym: "2020-08" },
    { id: "2", section: "address", label: "C", from_ym: "2021-02", to_ym: null },
    { id: "3", section: "employer", label: "Fund A", person: "", contact: "",
      from_ym: "2026-06", to_ym: "2026-08" },
  ];
  const text = asText(entries, NOW);
  ok(text.includes("SF-86 EVIDENCE PACK"), "the export is titled");
  ok(/not a submission|nothing here has been filed/i.test(text),
     "and says out loud that nothing has been filed");
  // MISSING is marked, not omitted. The row with no supervisor contact is the
  // most useful line in the file — it is the next thing to go and find.
  ok(text.includes("*** MISSING ***"),
     "a required field left blank is marked in the export, not quietly dropped");
  ok(/GAPS in the last 10 years/.test(text), "and the address gaps are spelled out");
  ok(text.includes("2020-08 to 2021-02"), "with both ends of each gap");
  ok(text.includes("(nothing recorded yet)"),
     "an empty section says so rather than vanishing from the export");
  // The clearance rule, on one more surface.
  // The shared predicate. The regex here was a bare cleared-or-eligible
  // match, which is BROADER than the rule: it would have flagged the export
  // for quoting a posting's own "must be eligible for a Secret clearance".
  // The rule is about claims made ABOUT THE OWNER, not about a word appearing.
  const claim = forbiddenClaim(text);
  ok(claim === null,
     `and the export never claims a clearance or an eligibility `
     + `determination${claim ? ` (found ${JSON.stringify(claim)})` : ""}`);
}

/* ------------------------------------------------------------------ report */

/* ============ AFFIRMATIONS MUST REACH completeness() AT EVERY CALL SITE ======
 *
 * completeness() has always handled affirmations correctly. The bug was a CALL
 * SITE that dropped the third argument: app/api/ask/route.js passed
 * completeness(sf86.rows) with no `now` and no affirmations, so the Ask box was
 * told foreign contacts was 0% — unfinished — on a section the owner had answered
 * "none" to. The page passed all three and was right.
 *
 * NO DATA-LAYER ASSERTION COULD SEE THIS. The function is correct; the rows are
 * correct; only the caller was wrong. So the first half proves the argument
 * CHANGES THE ANSWER, and the second half proves no caller omits it. */
{
  const rows = [{ section: "employer", label: "Startup", person: "", from_ym: "", to_ym: "" }];
  const now = new Date("2026-09-04T00:00:00Z");

  const without = completeness(rows, now);
  const withAff = completeness(rows, now, { contact: "2026-09-03T21:36:29+00:00" });
  ok(without.per.contact.pct === 0,
     `no affirmation and no rows -> contact 0% (got ${without.per.contact.pct})`);
  ok(withAff.per.contact.pct === 100,
     `"none", said out loud -> contact 100% (got ${withAff.per.contact.pct})`);
  ok(without.pct !== withAff.pct,
     "and the overall figure differs, so dropping the argument changes the answer");

  // The specific call site that was wrong. Checked by finding the line that
  // builds the ask context's sf86 field and requiring `affirmations` on it.
  //
  // The first version of this counted arguments with a regex and was WORSE THAN
  // NOTHING: it matched the word in a comment, matched the function DEFINITION
  // in lib/sf86.js, and split on the paren inside `new Date()`. Three false
  // failures — a check that fires on its own documentation is one you learn to
  // skip, which is the failure this repo keeps finding.
  const route = fs.readFileSync(new URL("app/api/ask/route.js", import.meta.url), "utf8");
  const LINES = "\n";
  const call = route.split(LINES).find((l) => l.includes("sf86:") && l.includes("completeness("));
  ok(!!call, "the ask route still builds an sf86 context field");
  ok(!!call && call.includes("affirmations"),
     `the ask route passes affirmations into completeness()
      got: ${(call || "").trim()}`);
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
