/**
 * Tests for the display rules in lib/display.js. Run: node test_display.mjs
 *
 * These are the rules that decide what reaches the shortest, highest-trust lists
 * in the tool, so a mistake here is a mistake the owner acts on. Same shape as
 * test_filters.py: prints a count, exits non-zero on failure.
 */
import {
  looksLikeIC, bandOf, normalizeTitle, titlePrefix, groupRoles,
  isCuratedReachable, compareRoles, sortRoles, sortOrderSentence, groupKeyOf,
  splitLocations,
  horizon, accentedDeadlines, WINDOW_HORIZON_DAYS, URGENT_DAYS,
  itemAge, stalled, stallReason, STALL_DAYS, MAX_DEFERRALS, windowKey,
  angleLead, roleWeight, HIDE_REASONS, HIDE_REASON_KEYS, openItems,
} from "./lib/display.js";

let pass = 0;
const fails = [];

const ok = (cond, what) => is(!!cond, true, what);

function is(got, want, what) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------- looksLikeIC
// The role that prompted this: a manager role at manager pay, on Strong on both.
is(looksLikeIC("Operations Manager, Signal Systems"), false, "bare Operations Manager is not IC");
is(looksLikeIC("Engineering Manager"), false, "Engineering Manager is not IC");
is(looksLikeIC("Manager, Forward Deployed Engineering"), false, "Manager, X is not IC");
is(looksLikeIC("Field Marketing Manager"), false, "Field Marketing Manager is not IC");
is(looksLikeIC("Manager I, Customer Success"), false, "Manager I is not IC");

// "Manager" alone must never disqualify — these are tier-1 new-grad titles.
is(looksLikeIC("Product Manager"), true, "Product Manager is IC");
is(looksLikeIC("Associate Product Manager, New Grad"), true, "APM is IC");
is(looksLikeIC("Technical Program Manager"), true, "Program Manager is IC");
is(looksLikeIC("Product Operations Manager"), true, "Product Operations Manager is IC");
is(looksLikeIC("Mission Operations Manager"), true, "Mission Operations Manager is IC");
is(looksLikeIC("Business Operations Manager"), true, "Business Operations Manager is IC");
is(looksLikeIC("Operations Manager, Associate"), true, "Associate anywhere is IC");
is(looksLikeIC("Manager, Data Analyst Team"), true, "Analyst anywhere is IC");

// No "manager" at all — every ordinary IC title passes untouched.
is(looksLikeIC("Software Engineer, New Grad"), true, "SWE is IC");
is(looksLikeIC("Deployment Strategist"), true, "Deployment Strategist is IC");
is(looksLikeIC("Forward Deployed Engineer"), true, "FDE is IC");
is(looksLikeIC(""), true, "empty title fails open to IC");
is(looksLikeIC(null), true, "null title fails open to IC");
// "Management" is not "Manager" — word boundaries, same lesson as the title filter.
is(looksLikeIC("Analyst, Management Consulting"), true, "Management is not Manager");

// -------------------------------------------------------------------- bandOf
is(bandOf(92), "Excellent", "92 is Excellent");
is(bandOf(85), "Excellent", "85 is the Excellent floor");
is(bandOf(84), "Strong", "84 is Strong");
is(bandOf(70), "Strong", "70 is the Strong floor");
is(bandOf(69), "Good", "69 is Good");
is(bandOf(55), "Good", "55 is the Good floor");
is(bandOf(54), "Fair", "54 is Fair");
is(bandOf(35), "Fair", "35 is the Fair floor");
is(bandOf(34), "Weak", "34 is Weak");
is(bandOf(0), "Weak", "0 is Weak");
is(bandOf(null), "Weak", "no score is Weak");

// ------------------------------------------------------------- normalizeTitle
is(normalizeTitle("Software Engineer - Austin, TX", "Austin, TX"), "Software Engineer",
   "trailing location segment stripped when it matches the row's location");
is(normalizeTitle("Software Engineer - Growth", "Austin, TX"), "Software Engineer - Growth",
   "a trailing segment that is NOT the location is kept");
is(normalizeTitle("Field Engineer (Austin, TX)", "Austin, TX"), "Field Engineer",
   "parenthetical location stripped");
is(normalizeTitle("Engineer (Remote)", "Remote - US"), "Engineer",
   "parenthetical Remote stripped");
is(normalizeTitle("Product Manager, Payments", "New York, NY"), "Product Manager, Payments",
   "an ordinary title is untouched");

is(titlePrefix("Mission Software Engineer, Vehicle Software"), "Mission Software Engineer",
   "prefix is everything before the first comma");
is(titlePrefix("Deployment Strategist - US Government"), "Deployment Strategist",
   "prefix is everything before a spaced dash");

// ----------------------------------------------------------------- groupRoles
const rows = [
  { key: "a", company: "palantir", display_name: "Palantir", title: "Deployment Strategist, Build to Apply", location: "New York, NY", score: 72, comp_min: null, comp_max: null, entry_level: "entry" },
  { key: "b", company: "palantir", display_name: "Palantir", title: "Deployment Strategist, Build to Apply", location: "Honolulu, HI", score: 72, comp_min: null, comp_max: null, entry_level: "entry" },
  { key: "c", company: "anduril", display_name: "Anduril", title: "Mission Software Engineer, Vehicle", location: "Costa Mesa, CA", score: 72, comp_min: 166000, comp_max: 220000, entry_level: "entry" },
  { key: "d", company: "anduril", display_name: "Anduril", title: "Mission Software Engineer, Air Defense", location: "Costa Mesa, CA", score: 72, comp_min: 166000, comp_max: 220000, entry_level: "entry" },
];
const g = groupRoles(rows);
// Location grouping only. The two Anduril rows share a PREFIX but are different
// jobs, so they stay separate: an action on a merged row could not say which
// job it meant.
is(g.length, 3, "the two-city role collapses; the two variants stay apart");
is(g[0].all.length, 2, "the multi-city role keeps both underlying rows");
is(g[0].locationLabel, "New York, NY +1 location", "location label counts the rest");
is(g[1].title, "Mission Software Engineer, Vehicle", "a variant keeps its own title");
is(g[2].title, "Mission Software Engineer, Air Defense", "and so does the other");
// Nothing may be lost: every input key survives somewhere.
is(g.flatMap((r) => r.all.map((x) => x.key)).sort(), ["a", "b", "c", "d"],
   "grouping loses no rows");

// The group key is what actions are stored against, so it must be stable across
// a re-fetch: derived from company and title, never from the churning job key.
is(groupKeyOf(rows[0]), groupKeyOf(rows[1]),
   "two cities of one role share a group key");
is(groupKeyOf(rows[2]) === groupKeyOf(rows[3]), false,
   "two variants do NOT share a group key");
is(groupKeyOf({ company: "palantir", title: "Deployment Strategist - New York, NY", location: "New York, NY" }),
   groupKeyOf({ company: "palantir", title: "Deployment Strategist", location: "Honolulu, HI" }),
   "a title carrying its own location normalises to the same key");

// ------------------------------------------- one row that lists many cities
// Grouping collapsed several ROWS into one. It never handled the other shape:
// ONE row whose location field already holds every city, joined with "; " by
// fetch_jobs.py (see the Rippling merge at fetch_jobs.py:538). Greenhouse gives
// Anduril's "2027 Early Career Software Engineer" nine of them in a single
// 331-character string, and it went through as ONE location — so the label was
// the whole string, `.loc` is `white-space: nowrap`, and the row pushed Daily's
// grid past the viewport and put a horizontal scrollbar on the page.
const NINE = [
  "Atlanta, Georgia, United States",
  "Boston, Massachusetts, United States",
  "Broomfield, Colorado, United States",
  "Colorado Springs, Colorado, United States",
  "Costa Mesa, California, United States",
  "Fort Collins, Colorado, United States",
  "Irvine, California, United States",
  "Reston, Virginia, United States",
  "Seattle, Washington, United States",
];
const wide = groupRoles([{
  key: "w", company: "andurilindustries", display_name: "Anduril",
  title: "2027 Early Career Software Engineer", location: NINE.join("; "),
  score: 70, comp_min: null, comp_max: null, entry_level: "program",
}]);
is(wide[0].locations, NINE, "a single row's semicolon list becomes nine locations");
is(wide[0].locationLabel, "Atlanta, Georgia, United States +8 locations",
   "the label names one city and counts the rest");
// The bug was a LENGTH problem, so assert the length, not only the text.
is(wide[0].locationLabel.length < 60, true,
   `the label fits a row (was ${NINE.join("; ").length} chars)`);
is(wide[0].all.length, 1, "and it is still one posting, not nine");

// Two rows that each carry a list must merge into one deduplicated list.
const twoLists = groupRoles([
  { key: "p", company: "anduril", display_name: "Anduril", title: "Ops",
    location: "Costa Mesa, CA; Seattle, WA" },
  { key: "q", company: "anduril", display_name: "Anduril", title: "Ops",
    location: "Seattle, WA; Reston, VA" },
]);
is(twoLists[0].locations, ["Costa Mesa, CA", "Seattle, WA", "Reston, VA"],
   "lists from two rows merge without repeating a city");

// splitLocations itself: the separator is "; " but the data is not guaranteed
// tidy, and an empty segment must not become a phantom location.
is(splitLocations("Costa Mesa, CA"), ["Costa Mesa, CA"], "one city stays one");
is(splitLocations("A;B ; C"), ["A", "B", "C"], "split trims around the separator");
is(splitLocations("A;;B;"), ["A", "B"], "empty segments are dropped");
is(splitLocations(""), [], "no location is no locations");
is(splitLocations(null), [], "null is no locations");
// A comma is NOT a separator: "Costa Mesa, CA" is one place, not two.
is(splitLocations("Costa Mesa, California, United States"),
   ["Costa Mesa, California, United States"], "commas inside a city are left alone");

// The group key is the identity actions are stored against, so splitting the
// display list must not move it — a changed key orphans every save and hide.
is(groupKeyOf({ company: "andurilindustries", title: "2027 Early Career Software Engineer", location: NINE.join("; ") }),
   "andurilindustries|2027 early career software engineer",
   "splitting locations does not disturb the group key");

// ------------------------------------------------------------- item rot
// The four seeded items sat untouched from the day they were created and the
// page's only response was the number turning orange. A countdown implies
// progress; for something nobody has opened, AGE is the honest number.
const fresh = { dueIn: 3, ageDays: 2, done: false, stuck: false, split: false };
is(itemAge(fresh), "added 2 days ago", "a live item reports its age and nothing more");
is(itemAge({ ...fresh, dueIn: -2 }), "added 2 days ago · never touched",
   "an overdue item says plainly that nobody has touched it");
is(itemAge({ ...fresh, ageDays: 1, dueIn: -1 }), "added 1 day ago · never touched",
   "one day is singular");
is(itemAge({ ...fresh, dueIn: -2, stuck: true, stuckDays: 5 }),
   "added 2 days ago · stuck for 5 days",
   "once you have answered 'stuck', it stops saying never touched");
is(itemAge({ ...fresh, ageDays: 0 }), "", "something added today has no age worth stating");

// Three weeks past due with no answer is furniture, not work. Hidden, never
// deleted — and ANY answer takes it back out of that state, which is the point.
is(stalled({ dueIn: -22, done: false, stuck: false, split: false }), true,
   "22 days past due with no answer is stalled");
is(stalled({ dueIn: -21, done: false, stuck: false, split: false }), false,
   "21 days is the boundary and is not");
is(stalled({ dueIn: -60, done: true, stuck: false, split: false }), false,
   "a finished item is not stalled, it is finished");
is(stalled({ dueIn: -60, done: false, stuck: true, split: false }), false,
   "answering 'stuck' takes it out of the stalled group");
is(stalled({ dueIn: -60, done: false, stuck: false, split: true }), false,
   "and so does splitting it into steps");
is(stalled({ dueIn: null, done: false, stuck: false, split: false }), false,
   "an item with no due date can never stall");
is(STALL_DAYS, 21, "three weeks");

// Three deferrals is an answer — the same shape as "two follow-ups, then stop".
// Pushing a thing away repeatedly IS a decision, and a tool that keeps asking
// has stopped listening.
const live = { dueIn: 3, done: false, stuck: false, split: false };
is(stalled({ ...live, deferrals: 2 }), false, "two deferrals is not an answer yet");
is(stalled({ ...live, deferrals: 3 }), true,
   "the third deferral stalls it permanently, even though it is not overdue");
is(stallReason({ ...live, deferrals: 3 }),
   "deferred 3 times; rewrite it or drop it", "and the row says which rule caught it");
is(stallReason({ dueIn: -30, deferrals: 0 }),
   "more than 21 days past due; rewrite it or drop it", "the other rule names itself too");
is(stalled({ ...live, deferrals: 3, done: true }), false,
   "finishing it beats every stall rule");
is(MAX_DEFERRALS, 3, "three");

// The key a window check is stored against. It must not move when a note is
// reworded in companies.yaml, or every recorded check would be orphaned.
is(windowKey({ firm: "Oliver Wyman", program: "Consultant, undergraduate" }),
   "window:Oliver Wyman|Consultant, undergraduate", "window key is firm and programme");

// ------------------------------------------------------------------ angleLead
// The angles are the best thing on Daily and were also 254-473 characters each,
// eight of them, a wall of grey. The top three keep the whole thing; the rest
// get the opening clause.
is(angleLead("Short enough already."), "Short enough already.", "a short angle is untouched");
is(angleLead("A".repeat(50) + " — the rest of it goes on and on and on and on and on and on and on"),
   "A".repeat(50) + "…", "an em dash is the cleanest break");
is(angleLead("First part here that is long enough to matter; second part here that runs well past the limit of one hundred and ten characters"),
   "First part here that is long enough to matter…", "a semicolon works too");
// The case the first version got wrong: these angles are comma-spliced and most
// carry no dash at all in the first 110 characters, so nothing was being cut.
{
  const real = "I've shipped a profitable full-stack product solo, optimized unit "
    + "economics via technical judgment (LLM Batch API), and built internal tools "
    + "and GTM strategy across cross-functional teams.";
  const lead = angleLead(real);
  ok(lead.length < real.length, `a comma-spliced angle IS shortened (${lead.length} of ${real.length})`);
  ok(lead.endsWith("…"), "and says it was cut");
  ok(real.startsWith(lead.slice(0, -1)), "the lead is a genuine prefix of the angle");
}
// Never mid-word, even with no punctuation anywhere.
{
  const nopunct = "word ".repeat(40).trim();
  const lead = angleLead(nopunct);
  ok(lead.length < nopunct.length, "a run of words with no punctuation is still cut");
  ok(/(word|…)$/.test(lead), "at a word boundary, not mid-word");
}
is(angleLead(""), "", "no angle is no text");
is(angleLead(null), "", "and null is not a crash");

// Row weight is a fact about the ROLE. Two mechanisms were tried and rejected:
// tier does not discriminate (21 of 22 companies are tier 1), and company depth
// discriminates on hiring volume, which is not the question Daily asks.
//
// The row that proved depth wrong, and the row it was losing to:
is(roleWeight({ entry_level: "program", score: 72,
                title: "Associate Product Manager, New Grad (2027 Start)" }), "primary",
   "a class-year programme is primary even at a company with ONE reachable role");
is(roleWeight({ entry_level: "entry", score: 40 }), "secondary",
   "an open-now Fair role is secondary however big its employer");
// A programme role is primary on its class year alone — the band does not veto it.
is(roleWeight({ entry_level: "program", score: 20 }), "primary",
   "a programme role dated for his class outranks its own weak score");
// And a genuinely strong open-now role still earns the weight.
is(roleWeight({ entry_level: "entry", score: 92 }), "primary", "Excellent is primary");
is(roleWeight({ entry_level: "entry", score: 70 }), "primary", "Strong is the boundary");
is(roleWeight({ entry_level: "entry", score: 69 }), "secondary", "Good is not");
is(roleWeight({ entry_level: "entry", score: null }), "secondary", "no score is not");
is(roleWeight(null), "secondary", "and a missing role never promotes a row");

// The hide reasons are a CLOSED list so they can be counted later.
is(HIDE_REASON_KEYS.length, 5, "five reasons");
ok(HIDE_REASON_KEYS.includes("other"), "including an escape hatch, so the list never forces a lie");
is(HIDE_REASONS.every(([k, l]) => k && l), true, "each has a key and a label");

// ---------------------------------------------------------- isCuratedReachable
const base = { key: "x", entry_level: "entry", class_fit: "ok", clearance_status: "none_mentioned", comp_min: 150000 };
is(isCuratedReachable(base), true, "an ordinary entry role is curated-reachable");
is(isCuratedReachable({ ...base, comp_min: 240000 }), false, "pay floor over the ceiling is not");
is(isCuratedReachable({ ...base, comp_min: 200000 }), true, "exactly at the ceiling still is");
is(isCuratedReachable({ ...base, comp_min: null }), true, "unknown pay is not high pay");
is(isCuratedReachable({ ...base, entry_level: "program", comp_min: 240000 }), true,
   "a stated programme role is never filtered on pay");
is(isCuratedReachable({ ...base, entry_level: "experienced" }), false, "experienced is not");
is(isCuratedReachable({ ...base, class_fit: "wrong_year" }), false, "another class year is not");
is(isCuratedReachable({ ...base, clearance_status: "required_active" }), false,
   "an active clearance requirement is not");
is(isCuratedReachable({ ...base, clearance_status: "eligibility_only" }), true,
   "eligibility only still is");
is(isCuratedReachable(base, { hidden: new Set(["x"]) }), false, "a hidden role is not");

// ---------------------------------------------------------------- sortRoles
const R = (over) => ({
  key: "k", title: "T", company: "c", score: 72, entry_level: "entry",
  comp_min: null, first_seen: "2026-08-01T00:00:00+00:00", ...over,
});

// Band beats everything, including a criterion that would otherwise win.
is(sortRoles([R({ key: "lo", score: 40 }), R({ key: "hi", score: 90 })]).map((r) => r.key),
   ["hi", "lo"], "a higher band sorts first");
is(sortRoles([R({ key: "prog", score: 40, entry_level: "program" }),
              R({ key: "strong", score: 90 })]).map((r) => r.key),
   ["strong", "prog"], "band outranks the programme tie-break");

// Within one band, the documented order.
is(sortRoles([R({ key: "entry" }), R({ key: "prog", entry_level: "program" })]).map((r) => r.key),
   ["prog", "entry"], "3: programmes before open-to-new-grads");
is(sortRoles([R({ key: "nopay" }), R({ key: "pay", comp_min: 100000 })]).map((r) => r.key),
   ["pay", "nopay"], "4: published pay before unpublished");
is(sortRoles([R({ key: "low", comp_min: 100000 }), R({ key: "high", comp_min: 180000 })]).map((r) => r.key),
   ["high", "low"], "5: higher pay floor first");
is(sortRoles([R({ key: "b", title: "Zeta" }), R({ key: "a", title: "Alpha" })]).map((r) => r.key),
   ["a", "b"], "7: title A-Z");

// Criteria 1, 2 and 6 are SKIPPED, not broken, when their data is absent.
is(sortRoles([R({ key: "x" }), R({ key: "y" })]).map((r) => r.key), ["x", "y"],
   "with no context the sort still runs and is stable by key");
is(sortRoles([R({ key: "x" }), R({ key: "y" })], { saved: new Set(["y"]) }).map((r) => r.key),
   ["y", "x"], "1: saved first, once a saved set is supplied");
is(sortRoles(
     [R({ key: "old", first_seen: "2026-08-01T00:00:00+00:00" }),
      R({ key: "new", first_seen: "2026-08-24T00:00:00+00:00" })],
     { newSince: "2026-08-20T00:00:00+00:00" }
   ).map((r) => r.key), ["new", "old"], "2: new since last visit, once a timestamp is supplied");
is(sortRoles(
     [R({ key: "elite", company: "palantir" }), R({ key: "easy", company: "leidos" })],
     { competitiveness: new Map([["palantir", "elite"], ["leidos", "accessible"]]) }
   ).map((r) => r.key), ["easy", "elite"], "6: accessible before elite, once labels exist");
// Saved outranks new, which outranks programme — the stated priority order.
is(sortRoles(
     [R({ key: "newprog", entry_level: "program", first_seen: "2026-08-24T00:00:00+00:00" }),
      R({ key: "savedentry" })],
     { saved: new Set(["savedentry"]), newSince: "2026-08-20T00:00:00+00:00" }
   ).map((r) => r.key), ["savedentry", "newprog"], "saved outranks both new and programme");

// TOTAL and STABLE. Zero only for the same key; antisymmetric; a re-sort of an
// already-sorted list is a no-op, so a refresh never reshuffles the page.
{
  const cmp = compareRoles({});
  const rows = [
    R({ key: "a", score: 92, title: "A" }), R({ key: "b", score: 72, title: "B" }),
    R({ key: "c", score: 72, title: "B" }), R({ key: "d", score: 72, comp_min: 150000 }),
    R({ key: "e", score: 28, entry_level: "program" }), R({ key: "f", score: 72, title: "A" }),
    R({ key: "g", score: 72, entry_level: "program" }), R({ key: "h", score: 55 }),
  ];
  let zeros = 0, asym = 0;
  for (const x of rows) for (const y of rows) {
    const v = cmp(x, y);
    if (v === 0 && x.key !== y.key) zeros++;
    if (Math.sign(v) !== -Math.sign(cmp(y, x))) asym++;
  }
  is(zeros, 0, "sort is total: no two distinct rows compare equal");
  is(asym, 0, "sort is antisymmetric");

  let trans = 0;
  for (const x of rows) for (const y of rows) for (const z of rows) {
    if (cmp(x, y) < 0 && cmp(y, z) < 0 && !(cmp(x, z) < 0)) trans++;
  }
  is(trans, 0, "sort is transitive");

  const once = sortRoles(rows).map((r) => r.key);
  const twice = sortRoles(sortRoles(rows)).map((r) => r.key);
  is(twice, once, "sorting an already-sorted list changes nothing");
  const shuffled = [...rows].reverse();
  is(sortRoles(shuffled).map((r) => r.key), once, "input order does not affect the result");
}

is(sortOrderSentence({}),
   "Within a band: new-grad programs, then published pay, then higher pay, then title.",
   "the sentence names only the criteria that are actually live");
is(sortOrderSentence({ saved: new Set(), newSince: "x", competitiveness: new Map() }),
   "Within a band: saved, then new since your last visit, then new-grad programs, "
   + "then published pay, then higher pay, then companies that hire more broadly, then title.",
   "the sentence grows as data arrives");

// ------------------------------------------------------- horizon thresholds
// An on-you item goes orange inside 7 days; a window gets 45, because it is
// external and unmovable. Four oranges on one screen is not a signal.
//
// 21 -> 45 is a deliberate change, not a loosened test. At 21 the page rendered
// "Nothing closing inside 21 days" while the owner's own on-you item three sections
// above said the Aug-Sep consulting window was open NOW — the nearest open
// window closes in 33 days. The horizon was shorter than the task it warned
// about, so it could not do its job. See WINDOW_HORIZON_DAYS in lib/display.js.
is(horizon(5, "item").urgent, true, "an item due in 5 days is urgent");
is(horizon(7, "item").urgent, true, "7 days is the item boundary");
is(horizon(8, "item").urgent, false, "8 days is not urgent");
is(horizon(12, "item").urgent, false, "12 days is graphite now, was orange before");
is(horizon(12, "item").label, "12 days", "...but the day count is still shown");
is(horizon(20, "deadline").urgent, true, "a deadline at 20 days IS urgent");
is(horizon(33, "deadline").urgent, true,
   "33 days IS urgent — this is the real window the old horizon hid");
is(horizon(45, "deadline").urgent, true, "45 days is the window boundary");
is(horizon(46, "deadline").urgent, false, "46 days is not");
is(WINDOW_HORIZON_DAYS, 45, "the horizon is one constant, and this is it");
is(URGENT_DAYS.deadline, WINDOW_HORIZON_DAYS,
   "the accent horizon and the window horizon are the same number, not two");
is(horizon(-3, "item").urgent, true, "overdue is always urgent");
is(horizon(null).urgent, false, "no date is not urgent");

// ---------------------------------------------------- one accent per date
// Deloitte, Accenture and EY-Parthenon all close 2026-09-30. From 8 September
// all three are inside the window and the page went orange three times for one
// fact.
{
  const three = [
    { firm: "Deloitte", program: "S&O", closes: "2026-09-30", closeIn: 20 },
    { firm: "Accenture", program: "S&C", closes: "2026-09-30", closeIn: 20 },
    { firm: "EY-Parthenon", program: "Associate", closes: "2026-09-30", closeIn: 20 },
  ];
  const a = accentedDeadlines(three);
  is(a.size, 1, "three firms sharing a close date produce ONE accent");
  is(a.has("Accenture|S&C"), true, "and it is the alphabetically first of the tie");

  const mixed = accentedDeadlines([
    ...three,
    { firm: "Bain", program: "AC", closes: "2026-09-10", closeIn: 3 },
    { firm: "Later", program: "X", closes: "2027-01-31", closeIn: 158 },
  ]);
  is(mixed.size, 2, "two distinct close dates inside the window, two accents");
  is(mixed.has("Bain|AC"), true, "the soonest date is accented");
  is(mixed.has("Later|X"), false, "one outside the 21-day window is not");
  is(accentedDeadlines([]).size, 0, "no deadlines, no accents");
}

/* ------------------------------------------------- what is actually on you
 *
 * ONE DEFINITION, because there were two and they disagreed.
 *
 * Daily's header counted `!done` and adjusted for the promoted item; the list
 * in Items also excluded stalled ones. So the header said "4 things on you"
 * over three visible rows, with the fourth sitting inside a collapsed "1
 * stalled" group — two populations, one sentence about them, which is the
 * failure the Companies row already taught this codebase once.
 */
{
  const TODAY = "2026-09-02";
  const items = [
    { id: "a", done: false, dueIn: 2 },
    { id: "b", done: true, dueIn: 1 },
    // Stalled: more than STALL_DAYS past due. In the list's collapsed group,
    // and it was in the header's count.
    { id: "c", done: false, dueIn: -(STALL_DAYS + 5) },
    // Deferred to the limit is the other way to stall.
    { id: "d", done: false, dueIn: 1, deferrals: MAX_DEFERRALS },
    { id: "p", done: false, dueIn: null },
    { id: "k1", done: false, dueIn: null, parent_id: "p", surfaced_on: TODAY },
    { id: "k2", done: false, dueIn: null, parent_id: "p", surfaced_on: "2026-08-20" },
    { id: "k3", done: false, dueIn: null, parent_id: "p" },
  ];
  const got = openItems(items, TODAY).map((i) => i.id);
  is(got.join(","), "a,k1", "on-you is: not done, not stalled, parents excluded, children only when surfaced today");

  ok(!got.includes("c"), "a stalled item is NOT on you — the list already moved it to its own group");
  ok(!got.includes("d"), "nor one deferred to the limit");
  ok(!got.includes("p"), "a parent is a running total, not a job: no checkbox, so not a thing to do");
  ok(!got.includes("k2"), "yesterday's date is not today's surfacing");
  ok(!got.includes("k3"), "and an unsurfaced child is explicitly not on you — that is the whole point of one a day");

  is(openItems([], TODAY).length, 0, "no items is zero, not a crash");
  // The bug, stated as an assertion: the naive count and the real one differ.
  const naive = items.filter((i) => !i.done).length;
  ok(naive !== openItems(items, TODAY).length,
     "the naive `!done` count still disagrees with the real list — which is why there is one function and not two");
}

console.log(`${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFAILURES:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
