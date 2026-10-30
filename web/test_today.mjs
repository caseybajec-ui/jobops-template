/**
 * Tests for the Daily ladder. Run: node test_today.mjs
 *
 * These rules decide the one sentence the owner reads before deciding whether to
 * keep using this thing, so a mistake here is not cosmetic. Same shape as
 * test_display.mjs: prints a count, exits non-zero on failure.
 *
 * chooseToday does no I/O on purpose, so every case below is a fixed date and a
 * literal — no database, no clock, no flake.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chooseToday, cycleFrame, frameSentences, datePhrase, SHORT_SITTING,
} from "./lib/today.js";
import { WINDOW_HORIZON_DAYS } from "./lib/display.js";
import { STALE_RUN_HOURS } from "./lib/notify.js";
import { OWNER, CLASS_YEAR } from "./lib/config.generated.js";

const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
const is = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? pass++
    : fails.push(`${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
const ok = (cond, what) => is(!!cond, true, what);

// ------------------------------------------------------------------ fixtures
// The three consulting windows as they actually are in companies.yaml: open,
// dated, and the date is a historical-estimate.
const CONSULTING = ["Deloitte", "Accenture", "EY-Parthenon"].map((firm) => ({
  firm, program: "Consulting, undergraduate", status: "open",
  opens: "2026-08-01", closes: "2026-09-30", closeIn: 33,
  confidence: "historical-estimate", verified: "2026-08-24", verifiedAgo: 3, minutes: 60,
}));
const PRIMES = {
  firm: "Defense primes", program: "LDP", status: "open",
  opens: "2026-09-01", closes: "2027-01-31", closeIn: 156,
  confidence: "historical-estimate", verifiedAgo: 3, minutes: 60,
};
const UNDATED = [
  { firm: "Oliver Wyman", program: "Consultant", status: "unconfirmed", closes: null,
    closeIn: null, confidence: "historical-estimate", verifiedAgo: 30, source: "https://x" },
  { firm: "Kearney", program: "Business Analyst", status: "unconfirmed", closes: null,
    closeIn: null, confidence: "historical-estimate", verifiedAgo: 3 },
];
const CLOSED = { firm: "McKinsey", program: "BA", status: "closed", closes: "2026-08-11",
                 closeIn: -17, confidence: "secondary-source", verifiedAgo: 3 };
const ITEM = {
  id: "seed:abc", title: "Confirm MBB dates with the business school career office",
  note: "Campus dates differ.", due_at: "2026-08-31", dueIn: 4,
  created_at: "2026-08-25T18:24:18+00:00", minutes: 15, done: false,
};
const BIG_ITEM = {
  id: "seed:sf86", title: "Assemble the SF-86 evidence pack", dueIn: 2,
  created_at: "2026-08-20T00:00:00+00:00", minutes: 240, done: false,
};
const COMPANIES = [
  { name: "palantir", display_name: "Palantir", reachable40: 54, n2027: 24, contacts: 0,
    bestTitle: "Deployment Strategist - US Government" },
  { name: "andurilindustries", display_name: "Anduril", reachable40: 14, n2027: 15, contacts: 0 },
  { name: "saronic", display_name: "Saronic", reachable40: 7, n2027: 1, contacts: 0 },
];
const FRESH = { hoursAgo: 2 };

// ------------------------------------------------------- tier order: the point
// The whole audit finding in one assertion: with the real data, the top of the
// page is the consulting window, not a checklist item and not a role.
{
  const r = chooseToday({
    windows: [...CONSULTING, PRIMES, CLOSED], undated: UNDATED,
    items: [ITEM], companies: COMPANIES, contactCount: 0, updated: FRESH,
  });
  is(r.today.tier, 1, "an open dated window inside the horizon wins the top slot");
  is(r.today.title, "Apply to Accenture, Deloitte and EY-Parthenon",
     "three firms closing the same day are ONE item, not three");
  is(r.today.minutes, 180, "minutes come from the yaml (60) times the number of firms");
  ok(r.today.why.includes("only application window open to you right now"),
     "the reason says why this one");
  // Caught in the browser: datePhrase is written to stand alone and is also
  // embedded after a full stop, where it read "right now. closes ~30 Sept".
  ok(r.today.why.includes(". Closes ~30 Sept"),
     "the embedded date phrase starts a sentence properly");
  // Also caught in the browser: the detail line showed Accenture's programme as
  // the caption for a three-firm item.
  is(r.today.detail, "3 separate applications, one window.",
     "one firm's programme line is not a caption for three firms");
  is(r.nothingDue, false, "something is due");
}

// The same task existed twice — as a tracked window and as an on-you item the owner
// wrote himself — and both rendered, 600px apart, in different words. Linking
// them by a fact (the title names every firm) lets the page show it once.
{
  const item = { id: "seed:apply", title: "Apply to Accenture, Deloitte and EY-Parthenon — 2027 undergrad",
                 dueIn: 34, created_at: "2026-08-25T18:24:18+00:00", minutes: 180, done: false };
  const r = chooseToday({ windows: CONSULTING, undated: UNDATED, items: [item],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.tier, 1, "the window still leads");
  is(r.today.itemId, "seed:apply", "and it carries the item it duplicates, so the list can drop it");
}
{
  // A title naming only SOME of the firms is a different task. Both are shown —
  // the safe direction to be wrong in is showing one thing twice, not hiding one.
  const partial = { id: "seed:partial", title: "Apply to Accenture", dueIn: 34,
                    created_at: "2026-08-25T00:00:00+00:00", done: false };
  const r = chooseToday({ windows: CONSULTING, undated: UNDATED, items: [partial],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.itemId, null, "a partial title is not treated as the same task");
}
{
  // A ticked item is not the thing to point at.
  const ticked = { id: "seed:apply", title: "Apply to Accenture, Deloitte and EY-Parthenon",
                   dueIn: 34, created_at: "2026-08-25T00:00:00+00:00", done: true };
  const r = chooseToday({ windows: CONSULTING, undated: UNDATED, items: [ticked],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.itemId, null, "a finished item is not linked");
}

// A guess must not render as a countdown. This is the McKinsey failure: a note
// reading "typically mid/late September" for a window that shut on 11 August.
is(datePhrase(CONSULTING[0]), "closes ~30 Sept, estimated — confirm it",
   "an estimated date is never rendered as a hard day count");
is(datePhrase({ ...CONSULTING[0], confidence: "verified" }),
   "closes 30 Sept — 33 days", "a verified date may state the days");
is(datePhrase({ ...CONSULTING[0], confidence: "secondary-source" }),
   "closes 30 Sept (two sources) — 33 days", "two sources may state the days, and say so");
is(datePhrase({ closes: null }), "no published date", "no date says no date");

// Confidence gates the WORDING, not the eligibility. If it gated eligibility,
// nothing would ever reach tier 1 — all four dated open windows are estimates —
// and the ladder would put admin above the only live application path.
{
  const r = chooseToday({
    windows: CONSULTING, undated: UNDATED, items: [ITEM],
    companies: COMPANIES, updated: FRESH,
  });
  is(r.today.tier, 1, "an ESTIMATED date still reaches tier 1");
  ok(r.today.why.includes("confirm it"), "and the wording says the date is a guess");
}

// ------------------------------------------------------------- the horizon
{
  // 46 days out: outside the horizon, so the ladder falls through to tier 2.
  const far = CONSULTING.map((d) => ({ ...d, closeIn: 46 }));
  const r = chooseToday({ windows: far, undated: UNDATED, items: [ITEM],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.tier, 2, "a window outside 45 days does not claim the top slot (the item does)");
  // 33 days is what the real data holds, and it is exactly what 21 days hid.
  const near = chooseToday({ windows: CONSULTING, undated: UNDATED, items: [ITEM],
                             companies: COMPANIES, updated: FRESH, horizonDays: 21 });
  is(near.today.tier, 2, "at the OLD 21-day horizon the same window is invisible");
}

// -------------------------------------------------------------- tier 0 first
{
  const r = chooseToday({
    windows: CONSULTING, undated: UNDATED, items: [ITEM], companies: COMPANIES,
    updated: { hoursAgo: 72 },
  });
  is(r.today.tier, 0, "stale data outranks everything — the rest is about yesterday");
  ok(r.today.why.includes("3 days ago"), "and it says how stale");
}

// --------------------------------------------------- irreversibility ordering
// The item is due in 4 days; the window is 33 days out. Urgency says the item,
// irreversibility says the window. A missed window costs a cycle; a late phone
// call does not.
{
  const r = chooseToday({ windows: CONSULTING, undated: [], items: [ITEM],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.tier, 1, "a distant window beats a sooner self-imposed item");
}
{
  const r = chooseToday({ windows: [CLOSED], undated: [], items: [ITEM],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.tier, 2, "with no live window, the on-you item is the top");
  ok(r.today.why.includes("Due in 4 days"), "and it says how long is left");
}
// Oldest CREATED, not soonest due: the thing that has sat longest is the stuck one.
{
  const r = chooseToday({ windows: [], undated: [], items: [ITEM, BIG_ITEM],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.title, "Assemble the SF-86 evidence pack",
     "among due items the oldest-created wins, not the soonest-due");
}

// ------------------------------------------------------------------- tier 4
{
  const r = chooseToday({ windows: [], undated: [], items: [], companies: COMPANIES,
                          contactCount: 0, updated: FRESH });
  is(r.today.tier, 4, "with nothing else live, networking is the action");
  // THE SCHOOL IS THE BAKED ONE, never a literal here: the title names
  // whatever profile.json says, so the fixture reads it from the same place.
  is(r.today.title, `Find 2 names at Palantir in the ${OWNER.schoolShort} directory`,
     "the company is named and the count is bounded");
  // reachable40 x (1 + n2027): Palantir 54x25=1350 beats Anduril 14x16=224.
  const flipped = chooseToday({
    windows: [], undated: [], items: [],
    companies: COMPANIES.map((c) => c.name === "palantir" ? { ...c, contacts: 2 } : c),
    updated: FRESH,
  });
  is(flipped.today.title, `Find 2 names at Anduril in the ${OWNER.schoolShort} directory`,
     "a company you already know somebody at drops out of the running");
}

// ------------------------------------------------------- the time constraint
// The four-minute Tuesday. When the top item is 180 minutes, the page must also
// offer something that actually fits, and tier 2 is that thing.
{
  const r = chooseToday({ windows: CONSULTING, undated: UNDATED, items: [ITEM],
                          companies: COMPANIES, updated: FRESH });
  ok(r.today.minutes > SHORT_SITTING, "the top item does not fit a short sitting");
  is(r.alsoIfShort.tier, 3, "so a short alternative is offered");
  is(r.alsoIfShort.minutes, 10, "and it is genuinely short");
  ok(r.alsoIfShort.title.startsWith("Check Oliver Wyman"),
     "least-recently-checked window first — 30 days beats 3");
}
{
  // A short top item must NOT drag an alternative along with it.
  const r = chooseToday({ windows: [CLOSED], undated: [], items: [ITEM],
                          companies: [], updated: FRESH });
  is(r.today.minutes, 15, "a 15-minute item is a short sitting");
  is(r.alsoIfShort, null, "and needs no alternative");
}

// --------------------------------------------------------- never a blank top
{
  const r = chooseToday({ windows: [CLOSED], undated: [], items: [],
                          companies: [], contactCount: 0, newRoles: [], updated: FRESH });
  is(r.today, null, "with genuinely nothing to do, today is null");
  is(r.nothingDue, true, "and the page is told to say so in those words");
}
// A done item is not work.
{
  const r = chooseToday({ windows: [], undated: [], items: [{ ...ITEM, done: true }],
                          companies: [], updated: FRESH });
  is(r.nothingDue, true, "a ticked item does not come back as today's task");
}

// --------------------------------------------------------------- cycleFrame
{
  const now = new Date("2026-08-27T12:00:00Z");
  const bits = cycleFrame({
    windows: [...CONSULTING, PRIMES, CLOSED, ...UNDATED],
    graduation: "2027-05", now,
  });
  // The SENTENCES, which is what the narrow layout still renders.
  is(frameSentences(bits), [
    "9 months to graduation",
    "3 windows close in 33 days",
    "next opens in 5 days",
    // ONE denominator. This was "2 have no date at all", and the section below
    // it said "2 of 6" — two counts of one thing against two different totals,
    // each looking correct beside the other.
    "2 of 6 live windows",
  ], "the frame is four computed facts and no invented score");

  // And the LABEL/VALUE shape the wide rail draws, from the same call. Two
  // renderings of one computation, so the rail and the line cannot disagree.
  is(bits.map((f) => [f.label, f.value]), [
    ["Months to graduation", "9"],
    ["Windows closing next", "in 33 days"],
    ["Next window opens", "in 5 days"],
    ["Windows with no date", "2 of 6"],
  ], "and the same four as label and value, for the rail");
  is(bits[3].aside, "7 tracked",
     "the wider tracked total is an aside, not a second denominator");
}
{
  // Nothing may be asserted that the data does not carry.
  is(cycleFrame({ windows: [], graduation: null, now: new Date("2026-08-27T12:00:00Z") }),
     [], "no data, no claims");
}

// ------------------------------------------- no hardcoded horizon in the UI
// The horizon is one constant so the section, the accent rule and the nav badge
// cannot disagree. They disagreed anyway: Nav.js carried
// title="application windows closing inside 21 days" as a string literal, so
// after the move to 45 the badge COUNTED one thing and DESCRIBED another. No
// test caught it and the build was green — only reading the deployed HTML did.
//
// Comments are stripped first, because several files legitimately explain the
// old 21-day behaviour and that history is worth keeping.
{
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.jsx?$/.test(e.name)) files.push(full);
    }
  };
  walk(path.join(here, "app"));
  walk(path.join(here, "lib"));

  const offenders = [];
  for (const f of files) {
    const body = stripComments(fs.readFileSync(f, "utf8"));
    for (const m of body.matchAll(/inside\s+(\d+)\s+days/g)) {
      if (Number(m[1]) !== WINDOW_HORIZON_DAYS) {
        offenders.push(`${path.relative(here, f)}: "inside ${m[1]} days"`);
      }
    }
  }
  // The positive half: prove the scan looked at something, or "no offenders"
  // means "found no files" just as convincingly.
  ok(files.length >= 10, `the scan read ${files.length} source files`);
  is(offenders, [], "no rendered text hardcodes a horizon other than the constant");

  // THE SAME RULE FOR THE STALENESS THRESHOLD. The digest says "past the
  // 30-hour mark" and that 30 is STALE_RUN_HOURS interpolated, not typed. The
  // number is chosen from how late this cron actually runs, so it will move
  // the day the schedule does — and a sentence carrying the old one is the
  // Nav.js failure again, in a different file.
  const hourOffenders = [];
  for (const f of files) {
    const body = stripComments(fs.readFileSync(f, "utf8"));
    for (const m of body.matchAll(/(\d+)[-\s]hour mark/g)) {
      if (Number(m[1]) !== STALE_RUN_HOURS) {
        hourOffenders.push(`${path.relative(here, f)}: "${m[0]}"`);
      }
    }
  }
  is(hourOffenders, [],
     "no rendered text hardcodes a staleness threshold other than the constant");

  // THE SAME RULE FOR THE OWNER'S CLASS YEAR, which is the one personal fact
  // most likely to be typed into a sentence: "dated 2027", "the 2027 req",
  // "You start May 2027". Every one of those must interpolate CLASS_YEAR (or
  // OWNER.graduation), because the original carried its owner's year in
  // eleven files and a copy for the next owner would have counted the wrong
  // class under the right header. Comments are stripped, as above; the
  // regex-example comments in lib/start.js are history worth keeping. A bare
  // four-digit year inside a regex or a date string ("2026-09-01") is not a
  // class-year claim, so the scan looks for the baked year as a WORD next to
  // the words a sentence about the class would use.
  const yearRe = new RegExp(
    String.raw`\b${CLASS_YEAR}\b[^\n]{0,24}\b(program|programme|class|roles?|date|req|intake|start|hiring|posting|graduat|undergrad|for you)`
    + "|" + String.raw`\b(dated|start|graduate in|class of|summer|fall|spring|May)\s+${CLASS_YEAR}\b`, "gi");
  // The *.generated.js modules are WHERE the values live -- config.generated.js
  // bakes profile.json, resumes.generated.js bakes the owner's resume text --
  // so they are the files allowed to hold them. Everything else must import.
  const sources = files.filter((f) => !/\.generated\.js$/.test(path.basename(f)));
  const yearOffenders = [];
  for (const f of sources) {
    const body = stripComments(fs.readFileSync(f, "utf8"));
    for (const m of body.matchAll(yearRe)) {
      yearOffenders.push(`${path.relative(here, f)}: "${m[0]}"`);
    }
  }
  is(yearOffenders, [],
     "no rendered text or code carries the owner's class year as a literal");

  // AND NOT THE OWNER'S NAME OR SCHOOL. The baked values are the only source;
  // a literal that happens to equal one of them is a literal that stops being
  // right the day profile.json changes.
  const nameOffenders = [];
  const personal = [OWNER.firstName, OWNER.name, ...OWNER.schoolSearchTerms, OWNER.schoolShort]
    .filter((t) => t && t.length >= 4);
  for (const f of sources) {
    const body = stripComments(fs.readFileSync(f, "utf8"));
    for (const t of personal) {
      if (body.includes(t)) nameOffenders.push(`${path.relative(here, f)}: "${t}"`);
    }
  }
  is(nameOffenders, [],
     "no source file carries the owner's name or school as a literal");
}

// ------------------------------------------- the cooldown, and the starvation
// THE BUG THIS CLOSES. A window checked with no date found returns to the queue
// with its recency reset, so the undated queue never empties. While it outranked
// the on-you items it therefore owned the top of the page permanently: simulated
// against the real data, from 1 October it was selected every single day and the
// tiers below it were never reached once.
{
  const justChecked = UNDATED.map((d) => ({ ...d, verifiedAgo: 1 }));
  const item = { id: "seed:x", title: "Confirm MBB dates", dueIn: 2,
                 created_at: "2026-08-20T00:00:00+00:00", minutes: 15, done: false };
  const r = chooseToday({ windows: [CLOSED], undated: justChecked, items: [item],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.tier, 2, "a freshly checked queue does not claim the slot");
  is(r.candidates.some((c) => c.kind === "confirm_window"), false,
     "and offers no window at all — the queue is finite now");
}
{
  // One stale window among fresh ones is the only one offered.
  const mixed = [{ ...UNDATED[0], verifiedAgo: 20 }, { ...UNDATED[1], verifiedAgo: 2 }];
  const r = chooseToday({ windows: [CLOSED], undated: mixed, items: [],
                          companies: [], updated: FRESH });
  is(r.today.kind, "confirm_window", "a window past the cooldown is offered");
  ok(r.today.title.includes("Oliver Wyman"), "and it is the stale one");
  is(r.today.batchHref, null, "one window due is not a batch");
}
{
  // Never checked always counts as due.
  const r = chooseToday({ windows: [CLOSED],
                          undated: UNDATED.map((d) => ({ ...d, verifiedAgo: null })),
                          items: [], companies: [], updated: FRESH });
  is(r.today.kind, "confirm_window", "never checked is always due a look");
  is(r.today.batchHref, "/forecast#confirm", "two or more due offers the batch view");
  is(r.today.batchCount, 2, "and says how many");
}

// IRREVERSIBILITY, CORRECTED. A window that is CLOSING outranks a commitment.
// An UNDATED one does not: it is not closing, it is unknown, and it was putting
// admin above a promise the owner made to themselves.
{
  const item = { id: "seed:y", title: "Assemble the SF-86 pack", dueIn: -3,
                 created_at: "2026-08-20T00:00:00+00:00", minutes: 240, done: false };
  const r = chooseToday({ windows: [CLOSED], undated: UNDATED, items: [item],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.kind, "item", "an overdue commitment beats an undated window");
  is(r.alsoIfShort.kind, "confirm_window",
     "and the ten-minute option is still offered underneath");
}
{
  // But a DATED window still wins, which is the original rule intact.
  const item = { id: "seed:z", title: "Assemble the SF-86 pack", dueIn: -3,
                 created_at: "2026-08-20T00:00:00+00:00", minutes: 240, done: false };
  const r = chooseToday({ windows: CONSULTING, undated: UNDATED, items: [item],
                          companies: COMPANIES, updated: FRESH });
  is(r.today.tier, 1, "a closing window still outranks an overdue item");
}

// ------------------------------------------------------- networking cadence
// It used to fire only when nothing else did, which after the consulting windows
// close means never — and it is the tier that decides whether the tool is still
// worth opening in December. It competes on being BEHIND the weekly target now.
{
  const r = chooseToday({ windows: [], undated: [], items: [], companies: COMPANIES,
                          contactsThisWeek: 0, updated: FRESH });
  is(r.today.kind, "find_names", "nobody added this week, so networking is the action");
  ok(r.today.why.startsWith("None added this week against a target of 5"),
     "and it says what the target is");
}
{
  const r = chooseToday({ windows: [], undated: [], items: [], companies: COMPANIES,
                          contactsThisWeek: 5, updated: FRESH });
  is(r.nothingDue, true, "hitting the cadence takes it off the page");
}
{
  const r = chooseToday({ windows: [], undated: [], items: [], companies: COMPANIES,
                          contactsThisWeek: 3, updated: FRESH });
  is(r.today.kind, "find_names", "three of five is still behind");
  ok(r.today.why.startsWith("3 of 5 added this week"), "and it counts what is done");
}

// THE DEGRADATION THIS ROUND EXISTS TO FIX. December, with the windows closed,
// the undated queue freshly checked, and four overdue items: the page must be
// asking for one of the items, not for a careers page.
{
  const december = {
    windows: [CLOSED],
    undated: UNDATED.map((d) => ({ ...d, verifiedAgo: 2 })),
    items: [
      { id: "a", title: "Assemble the SF-86 pack", dueIn: -60, created_at: "2026-08-20T00:00:00+00:00", minutes: 240, done: false },
      { id: "b", title: "Pull 15 alumni names", dueIn: -80, created_at: "2026-08-19T00:00:00+00:00", minutes: 45, done: false },
    ],
    companies: COMPANIES, contactsThisWeek: 0, updated: FRESH,
  };
  const r = chooseToday(december);
  is(r.today.kind, "item", "in December the page asks for real work");
  ok(r.today.title.includes("alumni"), "the oldest-created one");
  is(r.candidates.map((c) => c.kind).includes("confirm_window"), false,
     "and not for a careers page it has just looked at");
}

// ----------------------------------------------------------------------------
if (fails.length) {
  console.log(`\n${fails.length} FAILED of ${pass + fails.length}\n`);
  for (const f of fails) console.log(`  ${f}\n`);
  process.exit(1);
}
console.log(`${pass}/${pass} passed`);
