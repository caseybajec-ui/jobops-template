/**
 * Start dates and locations. Run: node test_prefs.mjs
 *
 * Both are DISPLAY AND FILTER layers over facts the postings already carry, and
 * both had a first version that was confidently wrong in a way no test would
 * have caught by counting. So this leans on the strings the corpus actually
 * contains rather than on tidy examples.
 *
 * THE RULE THESE EXIST TO PROTECT: neither module may touch a fit score.
 * Palantir's Deployment Strategist is the highest-fit posting in the corpus
 * under every scoring regime the pipeline has run, and one of its locations is
 * Colorado Springs. Weighting location into fit would push the best role on the
 * board down the page in order to express a preference.
 */
import { parseStart, startFit, startFor } from "./lib/start.js";
import { placeFor, metrosOf, splitPlaces, whereThese, METRO_TAG } from "./lib/geo.js";
import { PREFS, OWNER } from "./lib/config.generated.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- the baked prefs */

// THE BAKED YEAR IS THE PROFILE'S YEAR -- the two sources agree by
// construction (genconfig refuses a build where they differ), so the test
// asserts the relationship rather than one owner's number.
eq(PREFS.graduationYear, OWNER.classYear, "graduation year is baked in at build time, from the profile");
ok(Number.isInteger(PREFS.graduationYear) && PREFS.graduationYear >= 2020,
   "and it is a real year");
eq(PREFS.preferredSeason, "fall", "and the preferred season");
eq(PREFS.preferredMetros, ["nyc", "sf"], "and the two metros");
eq(PREFS.homeMetro, "la", "with Los Angeles as home, which is not the same thing");
ok(PREFS.remoteAcceptable === true, "remote is acceptable");

/* --------------------------------------------------------- start parsing */
//
// Every title here is verbatim from the corpus.

const TITLES = [
  ["Associate Product Manager, New Grad (2027 Start)", { season: null, year: 2027, source: "title" }],
  ["[2027] Software Engineer, Early Career", { season: null, year: 2027, source: "title" }],
  ["Research Engineer - New Grad (2027)", { season: null, year: 2027, source: "title" }],
  ["2027 Early Career Software Engineer", { season: null, year: 2027, source: "title" }],
  ["Full Time Analyst 2027", { season: null, year: 2027, source: "title" }],
  ["Software Engineer - New Grad (December 2026)", { season: "winter", year: 2026, source: "title" }],
  ["December 2026 New Graduate Engineer, Mechanical", { season: "winter", year: 2026, source: "title" }],
  ["Deployment Strategist - US Government", { season: null, year: null, source: null }],
];
for (const [title, want] of TITLES) {
  eq(parseStart({ title }), want, `title: ${title}`);
}

// THE BUG THIS MODULE ALMOST SHIPPED WITH.
//
// The first version scanned the whole description for any month-or-season
// beside a year and took the first hit. Across the corpus that produced:
// "Summer Analyst 2027" -> summer 2028, "(2027 Start)" -> fall 2026,
// "2027 Early Career Software Engineer" -> summer 2026, and an unrelated
// operations role -> summer 2022. A description mentions dates constantly and
// the first one is almost never the start.
{
  const noisy = {
    title: "Deployment Strategist",
    description: "Founded in June 2022. Applications close Fall 2026. "
               + "We have been growing since March 2021.",
  };
  eq(parseStart(noisy), { season: null, year: null, source: null },
     "an unanchored date in the body is NOT a start date");

  const anchored = {
    title: "Full Time Analyst",
    description: "Program details. Start Date: July 13th, 2027. Two years long.",
  };
  eq(parseStart(anchored), { season: "summer", year: 2027, source: "posting" },
     "but one right beside a start phrase is");

  // The title always wins. It is short, written to be read, and when it names a
  // date that date is the start.
  eq(parseStart({ title: "Analyst 2027", description: "Start date: January 2030" }).year,
     2027, "the title beats the body");
}

// A year outside any plausible range is not a start.
eq(parseStart({ title: "Engineer 1999" }).year, null, "1999 is not a start year");

/* ----------------------------------------------------------- start fit */

// A FIXTURE PREFS, with a year that is deliberately not any owner's: startFit
// takes prefs as an argument precisely so the rules can be tested against a
// fixed year rather than against whoever built this copy.
const GY = 2031;
const P = { graduationYear: GY, preferredSeason: "fall" };
eq(startFit({ season: "fall", year: GY }, P).verdict, "match", "the fall of the graduation year is the one they want");
eq(startFit({ season: "summer", year: GY }, P).verdict, "earlier", "the summer of it is earlier than preferred");
eq(startFit({ season: null, year: GY }, P).verdict, "year_only", "the year with no month is a question");
eq(startFit({ season: "winter", year: GY - 1 }, P).verdict, "too_early", "the December before is before they graduate");
eq(startFit({ season: null, year: GY + 1 }, P).verdict, "later", "the year after is a year late");
eq(startFit({ season: null, year: null }, P).verdict, "unstated", "and no date is no claim");

// SUMMER IS NOT A DISQUALIFICATION. The owner CAN start in the summer; they would rather
// not. The note asks a question and nothing is hidden or downranked.
{
  const f = startFit({ season: "summer", year: GY }, P);
  ok(/ask/i.test(f.note), "the summer note asks whether fall is possible");
  ok(!/reject|unsuitable|skip/i.test(f.note), "and does not read as a mark against the role");
}
// Nothing in this module returns a score, a weight, or a rank.
for (const s of [{ season: "fall", year: GY }, { season: null, year: null }]) {
  const f = startFit(s, P);
  ok(!("score" in f) && !("weight" in f) && !("rank" in f),
     "startFit returns no score, weight or rank");
}

/* ------------------------------------------------------------ locations */
//
// Verbatim strings, in every spelling the boards actually use. A matcher built
// on one spelling silently reports the wrong answer for the other three.

const PLACES = [
  ["New York, NY", "NY", true],
  ["New York, New York, United States", "NY", true],
  ["New York, NY (HQ)", "NY", true],
  ["San Francisco", "SF", true],
  ["San Francisco, CA", "SF", true],
  ["San Francisco, California", "SF", true],
  ["San Francisco, California, United States", "SF", true],
  ["Palo Alto, CA", "SF", true],
  ["Mountain View, California", "SF", true],
  ["San Mateo, CA, United States", "SF", true],
  ["Remote", "remote", true],
  ["Remote U.S.", "remote", true],
  // Home is a FACT about the role, never a mark against it.
  ["El Segundo, California, United States", "LA", false],
  ["Los Angeles, CA", "LA", false],
  // Somewhere else, and NAMED rather than called "elsewhere".
  ["Costa Mesa, California, United States", "Costa Mesa", false],
  ["Colorado Springs, CO", "Colorado Springs", false],
  ["Quincy, Massachusetts, United States", "Quincy", false],
  ["Austin, TX", "Austin", false],
];
for (const [loc, label, preferred] of PLACES) {
  const p = placeFor({ location: loc }, PREFS);
  eq(p.label, label, `location: ${loc}`);
  ok(p.preferred === preferred, `${loc} preferred=${preferred}`);
}

// THREE SEPARATORS, not one. Greenhouse uses "; ", Ashby " | ", and one row is
// a bare comma list. A metro missed here is a role reporting the wrong city.
eq(placeFor({ location: "San Francisco, CA | New York City, NY | Seattle, WA" }, PREFS).label,
   "NY · SF", "a pipe-separated list finds both preferred metros");
eq(placeFor({ location: "Chicago, New York, San Francisco" }, PREFS).label,
   "NY · SF", "and so does a bare comma list of city names");
// ...but a bare comma is NOT a separator on its own.
eq(splitPlaces("Costa Mesa, California, United States"), ["Costa Mesa, California, United States"],
   "a city, state, country is ONE place, not three");
eq(splitPlaces("Atlanta, Georgia, United States; Boston, Massachusetts, United States").length, 2,
   "a semicolon list is two");

eq([...metrosOf("Colorado Springs, CO")], [], "an unlisted metro matches nothing rather than guessing");
eq(placeFor({ location: "" }, PREFS).label, null, "an empty location claims nothing");

/**
 * `kind` names WHICH of the three branches answered, because `preferred` cannot:
 * home and somewhere-else both report false and they are not the same claim.
 *
 * PlaceTag renders only the first two. The third repeats the first word of the
 * location cell it sits beside — "Atlanta, ...  Atlanta" — and once the chip
 * stopped being clipped by that cell it competed for the width, squeezing a
 * 33-character location down to a sliver so a chip could echo it.
 */
for (const [loc, kind] of [
  ["New York, NY", "preferred"],
  ["San Mateo, CA, United States", "preferred"],
  ["Remote - United States", "preferred"],
  ["El Segundo, CA", "home"],
  ["Atlanta, Georgia, United States", "other"],
  ["Colorado Springs, Colorado, United States; Reston, Virginia, United States", "other"],
]) {
  eq(placeFor({ location: loc }, PREFS).kind, kind, `kind of ${JSON.stringify(loc)}`);
}
ok(["preferred", "home", "other"].includes(placeFor({ location: "" }, PREFS).kind),
   "every return carries a kind, including the empty one — a missing kind renders as a chip by default");

/* --------------------------------------------------------- the footer */

{
  const roles = [
    { location: "New York, NY" },
    { location: "New York, NY" },
    { location: "San Francisco, CA | New York City, NY" },
    { location: "Omaha, NE" },
    { location: "Colorado Springs, CO" },
  ];
  const w = whereThese(roles, PREFS);
  eq(w.total, 5, "the footer counts the rows it was given");
  eq(w.preferred, 3, "three of them are in a preferred metro");
  // REMOTE COUNTS, because the filter counts it. The footer used to count only
  // the metro intersection, so "Preferred locations only" returned 21 rows and
  // the line underneath them said 17 — one filtered set, two definitions of the
  // same word, on the same screen.
  eq(whereThese([{ location: "Remote" }, { location: "Omaha, NE" }], PREFS).preferred, 1,
     "remote is preferred in the footer because it is preferred in the filter");
  // A role in two metros counts in BOTH, and the sentence beside it says so.
  eq(w.named.find((m) => m.key === "nyc").n, 3, "New York counts the multi-city role");
  eq(w.named.find((m) => m.key === "sf").n, 1, "and so does the Bay Area");
  eq(w.otherTotal, 2, "the rest are counted and named");
  ok(w.other.every((o) => o.label && o.label !== "elsewhere"),
     "and named rather than lumped as 'elsewhere'");
}

// An empty set is not a crash and claims nothing.
{
  const w = whereThese([], PREFS);
  eq(w.total, 0, "no roles, no claims");
  eq(w.named, [], "and no metros");
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
