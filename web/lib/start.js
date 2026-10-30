/**
 * When a role actually starts, where the posting says so.
 *
 * Pure, and DERIVED AT READ TIME rather than stored. Two reasons, and the
 * second is the one that decides it:
 *
 *   `jobs` is created by fetch_jobs.py, which this pass may not modify, and
 *   test_schema_parity fails on any column a migration adds there that
 *   fetch_jobs.db() does not also create.
 *
 *   Deriving costs nothing and applies retroactively to all 9,919 rows the
 *   moment the rule improves. A stored column would need a backfill every time
 *   the parser learned a new phrasing, and would silently keep the old answer
 *   for anything already written.
 *
 * WHAT THE CORPUS ACTUALLY SAYS — measured, not assumed:
 *
 *   Titles state a YEAR: "(2027 Start)", "[2027]", "New Grad (2027)",
 *   "2027 Early Career …", "Full Time Analyst 2027".
 *   Titles state a SEASON in ZERO cases out of 9,919.
 *   Descriptions state a start date in ONE case — Bessemer's "Start Date: July
 *   13th, 2027" — and that role is flagged wrong-cycle anyway.
 *
 * So the season branch below is real code that will match nothing today. That
 * is deliberate and it is reported rather than hidden: boards do publish "Fall
 * 2027" once the cycle opens, and the parser is ready for it. Until then the
 * honest answer for almost every role is "start not stated", which is itself
 * useful — it is the question to ask on a call.
 */

// The owner's graduation, baked from profile.json / config.yaml. startFit takes
// prefs as an argument so tests can pass a fixture; when a caller passes none,
// the fallback is the BAKED year, never a literal — a literal here is the one
// number in this file a copy for another owner would silently get wrong.
import { PREFS as BAKED_PREFS, OWNER } from "./config.generated.js";

export const SEASONS = ["winter", "spring", "summer", "fall"];

// "May", from "May 2027". The month the owner graduates, for the notes below.
const GRAD_MONTH = String(OWNER.graduation || "").split(/\s+/)[0];

// "Fall 2027", "Fall '27", "starting fall 2027", "Autumn 2027".
const SEASON_YEAR = /\b(winter|spring|summer|fall|autumn)\s*(?:of\s*)?(20\d{2})\b/i;
// "2027 Fall", less common but real.
const YEAR_SEASON = /\b(20\d{2})\s+(winter|spring|summer|fall|autumn)\b/i;
// A month named beside a year: "Start Date: July 13th, 2027", "starts January 2027".
// The ORDINAL SUFFIX is load-bearing. Bessemer writes "Start Date: July 13th,
// 2027" — the only posting in the corpus that states a start date at all — and
// without `(?:st|nd|rd|th)?` the day swallows the "13" and then fails on the
// "th", so the one real start date in 9,919 rows parsed as nothing.
const MONTH_YEAR =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{0,2}(?:st|nd|rd|th)?,?\s*(20\d{2})\b/i;

/**
 * A start phrase and the ~60 characters after it.
 *
 * The window is short on purpose. "Start date: July 13th, 2027" is one clause;
 * anything further away is a different sentence about a different date, and
 * this is the exact place a generous window would start inventing starts.
 */
const START_PHRASE =
  /\b(?:start(?:ing)?\s*date|start(?:s|ing)?\s+(?:in|on)|cohort\s+begins?|begins?\s+(?:in|on)|expected\s+start)[^.]{0,60}/i;

const MONTH_SEASON = {
  january: "winter", february: "winter", december: "winter",
  march: "spring", april: "spring", may: "spring",
  june: "summer", july: "summer", august: "summer",
  september: "fall", october: "fall", november: "fall",
};

/** A bare year in the shapes titles actually use. */
const TITLE_YEAR = [
  /\((20\d{2})\s*start\)/i,            // Associate Product Manager, New Grad (2027 Start)
  /\[(20\d{2})\]/,                     // [2027] Software Engineer, Early Career
  /new\s*grad\s*\((20\d{2})\)/i,       // Research Engineer - New Grad (2027)
  /\b(20\d{2})\s+early\s+career/i,     // 2027 Early Career Software Engineer
  /\b(analyst|associate|engineer|manager)\s+(20\d{2})\b/i, // Full Time Analyst 2027
];

const norm = (s) => (String(s || "").toLowerCase() === "autumn" ? "fall" : String(s || "").toLowerCase());

/**
 * Read a start out of a posting.
 *
 * Returns `{ season, year, source }`, any of which may be null. `source` says
 * WHERE it was read from, because "the title says 2027" and "a sentence in the
 * body says July 2027" are different strengths of claim and the row should not
 * present them identically.
 *
 * Never guesses. A role with no stated start returns nulls, and the UI says
 * "start not stated" rather than inferring one from the class year — inferring
 * it would turn a question worth asking on a call into a fact on a screen.
 */
export function parseStart(role = {}) {
  const title = String(role.title || "");

  // THE TITLE FIRST, AND ALONE FOR SEASONS.
  //
  // The first version also scanned the description for any month-or-season
  // beside a year, and it was confidently, quietly wrong across the corpus:
  // "Summer Analyst 2027" came out as summer 2028, "(2027 Start)" as fall 2026,
  // "2027 Early Career Software Engineer" as summer 2026, and an unrelated
  // operations role as summer 2022. A job description mentions dates constantly
  // — application deadlines, company history, "on the team since June 2022" —
  // and the FIRST one is almost never the start date.
  //
  // A visibly weak answer beats a confident wrong one. The title is short,
  // written to be read, and when it names a date that date is the start.
  for (const [re, kind] of [[SEASON_YEAR, "sy"], [YEAR_SEASON, "ys"], [MONTH_YEAR, "my"]]) {
    const m = title.match(re);
    if (!m) continue;
    if (kind === "sy") return { season: norm(m[1]), year: Number(m[2]), source: "title" };
    if (kind === "ys") return { season: norm(m[2]), year: Number(m[1]), source: "title" };
    return { season: MONTH_SEASON[m[1].toLowerCase()], year: Number(m[2]), source: "title" };
  }

  for (const re of TITLE_YEAR) {
    const m = title.match(re);
    if (m) {
      const year = Number(m[2] || m[1]);
      if (year >= 2024 && year <= 2035) return { season: null, year, source: "title" };
    }
  }

  // The description ONLY when a start phrase is right beside the date. Bessemer
  // writes "Start Date: July 13th, 2027", which is unambiguous; anything not
  // anchored to a phrase like that is a date about something else.
  const anchored = String(role.description || "").match(START_PHRASE);
  if (anchored) {
    const near = anchored[0];
    let m = near.match(SEASON_YEAR);
    if (m) return { season: norm(m[1]), year: Number(m[2]), source: "posting" };
    m = near.match(MONTH_YEAR);
    if (m) return { season: MONTH_SEASON[m[1].toLowerCase()], year: Number(m[2]), source: "posting" };
  }

  // The pipeline's own classification, which is a year and never a season.
  const w = String(role.start_window || "").match(/(20\d{2})/);
  if (w) return { season: null, year: Number(w[1]), source: "classifier" };
  if (role.start_year) return { season: null, year: Number(role.start_year), source: "classifier" };

  return { season: null, year: null, source: null };
}

/**
 * How a stated start sits against what the owner wants.
 *
 * They graduate in the spring, can start the summer after, and slightly prefer
 * fall (config.yaml preferences). "Slightly" is doing real work in that
 * sentence: a summer start is a PREFERENCE MISS, not a disqualification, and
 * the difference is the whole design here. Nothing is hidden, nothing is
 * downranked, and the scores are untouched — a start date is a question to
 * raise in a conversation, and the row's job is to make sure they raise it.
 */
export function startFit(start, prefs) {
  const { season, year } = start || {};
  const grad = prefs?.graduationYear ?? BAKED_PREFS.graduationYear;

  if (!year) return { verdict: "unstated", label: "start not stated", note: null };

  if (year < grad) {
    return {
      verdict: "too_early",
      label: `starts ${year}`,
      note: `Starts before you graduate in ${GRAD_MONTH} ${grad}.`,
    };
  }
  if (year > grad) {
    return {
      verdict: "later",
      label: `starts ${year}`,
      note: `A year later than you graduate — worth asking whether ${grad} intake exists.`,
    };
  }

  // Right year. The season is what is left, and it is almost never stated.
  if (!season) {
    return {
      verdict: "year_only",
      label: `${year}`,
      note: "Start month not stated — ask whether a fall start is possible.",
    };
  }
  if (season === (prefs?.preferredSeason || "fall")) {
    return {
      verdict: "match",
      label: `${cap(season)} ${year}`,
      note: "Matches the start you'd prefer.",
    };
  }
  if (season === "summer") {
    return {
      verdict: "earlier",
      label: `${cap(season)} ${year}`,
      // NOT a downrank. The owner CAN start in the summer; they would rather not.
      note: "Earlier than you'd prefer — ask if fall is possible.",
    };
  }
  return {
    verdict: "other",
    label: `${cap(season)} ${year}`,
    note: `A ${season} start — check that works against graduating in ${GRAD_MONTH} ${grad}.`,
  };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Everything a row needs about the start, in one call. */
export function startFor(role, prefs) {
  const start = parseStart(role);
  return { ...start, ...startFit(start, prefs) };
}
