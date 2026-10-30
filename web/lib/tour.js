/**
 * The tours, as DATA.
 *
 * Adding a step is one entry in the array below — an id, the page it lives on,
 * a CSS selector for the thing it points at, a title and a body. Never new JSX.
 * That is the whole reason this file is separate from app/Tour.js: a tour whose
 * steps are components is a tour nobody extends, because extending it means
 * reading a renderer.
 *
 * EVERY STEP HAS A NAME, not just a number. "3 of 12" tells you how much is
 * left and nothing about where you are; "What's on you today" is the thing you
 * came to learn. The number is present and quiet.
 *
 * A `cta` is optional and is a plain link — the tour never performs an action
 * on the app's behalf. Walking a tour must not change any data.
 */

// The owner's class year and graduation, baked from profile.json. Two steps
// below say the year out loud; a literal would have toured the next owner
// through someone else's calendar.
import { CLASS_YEAR, OWNER } from "./config.generated.js";

/**
 * Interface tour. Ordered by the day: what you do first, then who you need,
 * then what to read when Daily is wrong, then the surfaces you visit weekly.
 *
 * The selectors are real classes from the pages, and they are the fragile part
 * of this file — a renamed class turns a step into a silent skip. That is right
 * at runtime and wrong forever, so test_tour_targets.mjs loads every page and
 * fails if a selector matches nothing. Skip live; fail in the test.
 */
export const INTERFACE_TOUR = [
  {
    id: "daily-today",
    page: "/",
    selector: ".today",
    title: "The one thing to do right now",
    body: "Daily answers a single question. One task, chosen by rules you can read, "
        + "with the reason under it and an honest time cost. Everything below this "
        + "card is reference — this is the part that is asking something of you.",
  },
  {
    id: "daily-today-parts",
    page: "/",
    selector: ".comprow",
    // NOT ON THE PAGE EVERY DAY, and correctly so: the checklist exists only
    // when two or more windows share the soonest close date. On a day when one
    // firm closes alone there is nothing for this step to point at, the tour
    // skips it, and that is the right behaviour. test_tour_targets.mjs reads
    // this field and checks the class exists in the SOURCE rather than on
    // whatever today's data happens to render — a test that demanded the
    // checklist be present would be asserting the calendar, not the code.
    conditional: "only when two or more windows share the soonest close date",
    title: "A task with three parts has three boxes",
    body: "“Apply to Accenture, Deloitte and EY-Parthenon” is three applications "
        + "sharing one deadline. One checkbox could only ever say all or nothing, so "
        + "each firm gets its own and the card counts them.",
  },
  {
    id: "daily-onyou",
    page: "/",
    selector: "#onyou",
    title: "What's on you",
    body: "Things the tool cannot do for itself. Numbered rows are tasks you can "
        + "finish; the count beside the heading and the list underneath are drawn "
        + "from the same query, so they cannot disagree.",
  },
  {
    id: "daily-parent",
    page: "/",
    selector: ".parentrow",
    title: "A project, not a task",
    body: "“Pull 16 alumni names” is sixteen jobs. Rendering all of them would be "
        + "a wall you scroll past, so it stays one line with a running total, and the "
        + "scheduler surfaces exactly one a day directly beneath it.",
  },
  {
    id: "daily-closing",
    page: "/",
    selector: "#closing",
    title: "Closing soon, and what “estimated” costs",
    body: "An “estimated” chip means nobody has read that date off the firm's own "
        + "site. One was wrong by seven weeks — a window that had already shut. "
        + "Confidence changes the wording here, never whether you are told.",
  },
  {
    id: "daily-rail",
    page: "/",
    selector: ".rail",
    title: "Where the search stands",
    body: "The same numbers as the page, computed by the same functions, in the space "
        + "that was already empty. Months to graduation, what closes next, how many "
        + "dates nobody is watching, and what this has cost.",
  },
  {
    id: "companies-queue",
    page: "/companies",
    selector: ".queue",
    title: "Start here",
    body: "The companies worth knowing someone at, best first, ranked by how many "
        + `roles you could actually take weighted by ${CLASS_YEAR} depth. This is the queue `
        + "the daily “find two names” task draws from.",
  },
  {
    id: "companies-hires",
    page: "/companies",
    selector: ".crow",
    title: "Who hires your profile",
    body: "One row per company: best fit, how many roles you could get, the best one "
        + `by name, and what they pay. You graduate in ${OWNER.graduation} — today's postings `
        + "are intelligence about who hires people like you, not things to apply to.",
  },
  {
    id: "companies-target",
    page: "/companies",
    selector: ".star",
    title: "Star a company to make it a target",
    body: "A target sorts to the top and gets a derived next step — follow up, say "
        + "thank you, find a name — worked out from what has actually happened rather "
        + "than from a field anyone has to maintain.",
  },
  {
    id: "people-add",
    page: "/people",
    // Either state of the same control: `.addopen` is the collapsed "Add
    // someone" line, `.addperson` the open form. The form opens itself only
    // while nobody is listed, so pointing at the form alone matched nothing
    // the day the first eighteen names went in.
    selector: ".addopen, .addperson",
    title: "The page that decides whether this is worth opening in December",
    body: "Your own gap data says a referral is what gets past a CS-degree screen and "
        + "a clearance requirement. Names go in by hand from the alumni directory — "
        + "nothing here looks anybody up, and nothing here sends anything.",
  },
  {
    id: "people-pulse",
    page: "/people",
    selector: ".pulse",
    title: "Five a week, and it stops asking",
    body: "The cadence is two follow-ups and then done. Two unanswered messages is an "
        + "answer, and keeping the relationship intact for a warm intro later is worth "
        + "more than a third.",
  },
  {
    id: "inbox-band",
    page: "/inbox",
    selector: ".row:not(.head) .band",
    title: "Fit is a word, not a score",
    body: "The scorer repeats itself within about ten points between runs, so a "
        + "two-digit number claims a precision that is not there. Click any row for "
        + "exactly why it landed where it did.",
  },
  {
    id: "inbox-actions",
    page: "/inbox",
    selector: ".row:not(.head) .rowend",
    title: "Three verbs on every row",
    body: "Save, mark applied, hide. Hiding asks why, once, and the reason is kept — "
        + "so “wrong cycle” can hide a whole company and you can still find out "
        + "later what you told it.",
  },
  {
    id: "inbox-filters",
    page: "/inbox",
    selector: ".filterbtn",
    title: "Filters, folded",
    body: "The inbox shows everything a new grad can get. These add back what it "
        + "normally hides — roles wanting more experience, other class years, "
        + "clearance. The button carries the count so a short list is never a mystery.",
  },
  {
    id: "inbox-where",
    page: "/inbox",
    selector: ".wherethese",
    title: "Where these actually are",
    body: "Location never touches a fit score. The highest-fit role in the whole "
        + "corpus is partly in Colorado Springs, and weighting a preference into the "
        + "ranking would push the best role down the page to express it.",
  },
  {
    id: "forecast-confirm",
    page: "/forecast",
    selector: "#confirm",
    title: "The dates nobody is watching",
    body: "Sixteen tracked windows have no close date at all. Open the firm's own "
        + "page, then answer here — a date if you found one, or just “checked it”, "
        + "which moves it to the back of the queue without pretending you learned more.",
  },
  {
    id: "forecast-open",
    page: "/forecast",
    selector: ".drow:not(.head)",
    title: "Open now, and how much to trust it",
    body: "Consulting, VC and big-tech APM never appear in the inbox — they run "
        + "systems this tool cannot read, so you apply directly. “Confirmed” means a "
        + "human read it off the firm's site; everything else is a prompt to check.",
  },
  {
    id: "profile-card",
    page: "/profile",
    selector: ".cardrow",
    title: "The answers you retype into every form",
    body: "GPA, graduation date, citizenship, the clearance wording. Copy any field, "
        + "or all of it. The clearance line is fixed language on purpose — eligibility "
        + "is decided by an adjudicator, never claimed on an application.",
  },
  {
    id: "resumes-both",
    page: "/resumes",
    selector: ".rescol",
    title: "Two resumes, and which goes where",
    body: "The PDFs as they are actually sent, side by side, with the date each one "
        + "last changed. Defense and product take the tech resume; consulting and VC "
        + "take the finance one — decided by the company's category in code, which is "
        + "the same rule behind the tag on every Apply button. The expander under each "
        + "shows the text the scorer reads, so you can see it matches what you send.",
  },
  {
    id: "pulse-grid",
    page: "/pulse",
    selector: ".pgrid",
    title: "Whether the search is actually running",
    body: "Messages, replies, applications, and what came of them. No streaks and no "
        + "badges: a streak turns a missed week into a reason to stop opening the page.",
  },
  {
    id: "sf86-progress",
    page: "/sf86",
    selector: "#sf86-progress",
    title: "The evidence pack",
    body: "Every address, school and trip a defense form will ask for, gathered once "
        + "instead of five times under deadline. It is also a real answer to “how "
        + "quickly could you start the clearance process”.",
  },
];

export const TOURS = { interface: INTERFACE_TOUR };

/** localStorage keys. Progress and dismissal only — never data. */
export const TOUR_KEY = "jobops.tour.progress";

/**
 * Which steps of a tour live on a given page, in order.
 *
 * Used to decide whether the engine has to navigate before it can show a step.
 */
export function stepsOnPage(steps, page) {
  return steps.filter((s) => s.page === page);
}

/**
 * The next index whose step is not skipped, walking in `dir`.
 *
 * `skipped` is a Set of ids the engine could not find on the page. Returns null
 * when there is nothing left in that direction, which the caller reads as "the
 * tour is over" rather than clamping to the last step — clamping would leave
 * the final card up with a Next button that does nothing.
 */
export function nextIndex(steps, from, dir, skipped = new Set()) {
  let i = from + dir;
  while (i >= 0 && i < steps.length) {
    if (!skipped.has(steps[i].id)) return i;
    i += dir;
  }
  return null;
}

/**
 * What the progress line says: position among the steps that are ACTUALLY
 * being shown, not among all of them.
 *
 * If four steps were skipped because their targets are not on the page, "3 of
 * 20" is a lie about a tour that will end at 16 — and the count drifting from
 * the thing it counts is the failure this codebase keeps finding on other rows.
 */
export function progress(steps, index, skipped = new Set()) {
  const live = steps.filter((s) => !skipped.has(s.id));
  const at = live.findIndex((s) => s === steps[index]);
  return { at: at < 0 ? 0 : at + 1, total: live.length };
}

/**
 * Where to resume. Reads the stored id rather than an index, because an index
 * points at a different step the moment a step is added in the middle — and
 * steps get added; that is the point of the data file.
 */
export function resumeIndex(steps, storedId) {
  if (!storedId) return 0;
  const i = steps.findIndex((s) => s.id === storedId);
  return i < 0 ? 0 : i;
}
