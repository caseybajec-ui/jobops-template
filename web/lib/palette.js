/**
 * What each colour MEANS. No DOM, no database, no I/O — same reason display.js
 * has none: these run on the server and inside client components, and a client
 * component importing anything with `node:` in it breaks the webpack build.
 *
 * tokens.css holds the values. This holds the rules that pick one. Keeping them
 * apart is what lets a token be retuned in one place without touching a
 * component, and lets the mapping be tested without a browser.
 *
 * Five meanings, and nothing on screen may be coloured for a sixth:
 *
 *   bandClass       fit          how well a role matches
 *   urgencyClass    urgency      how long until a window shuts
 *   evidenceClass   verification how much to trust a date
 *   categoryClass   category     what kind of company
 *   progressOf      progress     how much of a job is done
 */

import { bandOf } from "./display.js";
import { COMPANY_CATEGORY, FIRM_CATEGORY } from "./config.generated.js";

/* ------------------------------------------------------------------ 1. fit */

const BAND_CLASS = {
  Excellent: "b-excellent",
  Strong: "b-strong",
  Good: "b-good",
  Fair: "b-fair",
  Weak: "b-weak",
};

/** The class carrying this score's band colour. Never call it with a band name. */
export function bandClass(score) {
  return BAND_CLASS[bandOf(score)] || "b-weak";
}

/* -------------------------------------------------------------- 2. urgency */

/**
 * Three levels, replacing one orange.
 *
 * The previous rule was binary — inside 45 days got --alert, everything else was
 * grey — with `accentedDeadlines()` suppressing all but one accent per close
 * date, because Deloitte, Accenture and EY-Parthenon share 2026-09-30 and three
 * oranges for one fact is decoration.
 *
 * Three levels make the suppression unnecessary rather than wrong: three firms
 * at the same level now READ as one fact, because they look identical, which is
 * what "they close on the same day" actually means. accentedDeadlines is still
 * exported and still used to decide which single row gets extra WEIGHT.
 */
export const URGENCY_NOW_DAYS = 7;
export const URGENCY_SOON_DAYS = 30;

/** "now" | "soon" | "later" | null when there is no date to be urgent about. */
export function urgencyLevel(days) {
  if (days === null || days === undefined || !Number.isFinite(Number(days))) return null;
  const d = Number(days);
  if (d <= URGENCY_NOW_DAYS) return "now";      // includes overdue, which is past now
  if (d <= URGENCY_SOON_DAYS) return "soon";
  return "later";
}

/** "" when there is no date, so a row with no deadline gets no colour at all. */
export function urgencyClass(days) {
  const l = urgencyLevel(days);
  return l ? `u-${l}` : "";
}

/* --------------------------------------------------------- 3. verification */

/**
 * How much a date is worth, in the vocabulary companies.yaml already uses.
 *
 *   verified          read off the firm's own site by a human      strong
 *   secondary-source  two independent trackers agree               weak
 *   historical-estimate / anything else                            weak
 *
 * `unconfirmed` is a STATUS, not a confidence, and it is the amber case: the
 * window is real and nobody knows when it shuts.
 */
export function evidenceClass(confidence) {
  return confidence === "verified" ? "v-strong" : "v-weak";
}

/** Forecast's posting-provenance column: a real publish date, or an artifact. */
export function provenanceClass(quality) {
  return quality === "good" ? "v-strong" : "v-none";
}

/* -------------------------------------------------------------- 4. category */

/**
 * What kind of company. Four values, closed set, and the ONLY four.
 *
 * Not to be confused with `jobs.category`, which is a per-ROLE label the fetcher
 * writes ("product", "defense", "consulting", "vc") and leaves NULL on 8,362 of
 * 9,919 rows. listCompanies took MAX() of it, which is lexicographic, so Stripe
 * — a payments company with four roles tagged vc — would have read as a venture
 * firm. A company's category is a fact about the company and belongs to
 * companies.yaml, which is where this is baked from.
 */
export const CATEGORIES = [
  ["defense", "Defense"],
  ["product", "Product & tech"],
  ["consulting", "Consulting"],
  ["vc", "VC & growth"],
];

export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);

/** The dot class for a category, or "" for an unknown one — never a wrong dot. */
export function categoryClass(category) {
  return CATEGORY_LABEL[category] ? `cat-${category}` : "";
}

/** A board company, by its companies.yaml slug. Defaults to product. */
export function categoryOfCompany(slug) {
  return COMPANY_CATEGORY[slug] || "product";
}

/**
 * A deadline firm, by the `firm:` string in companies.yaml.
 *
 * Separate from the slug lookup because these companies have no board at all —
 * that is why they are in `deadlines:` — so they share no key with the other
 * map and merging the two would invite a lookup that silently misses.
 */
export function categoryOfFirm(firm) {
  return FIRM_CATEGORY[firm] || null;
}

/* -------------------------------------------------------------- 5. progress */

/**
 * A count rendered as a bar. `done` of `total`, plus the percentage.
 *
 * Returns 0% rather than NaN on an empty population, and clamps, so a caller
 * that passes done > total gets a full bar instead of a rule running off the
 * page.
 */
export function progressOf(done, total) {
  const t = Math.max(0, Number(total) || 0);
  const d = Math.min(Math.max(0, Number(done) || 0), t);
  return { done: d, total: t, pct: t ? Math.round((d / t) * 100) : 0 };
}

/**
 * How many tracked windows actually have a close date.
 *
 * ONE POPULATION, deliberately. Daily's warning read "{undated} of {total}
 * tracked windows have no date at all", where `undated` excluded closed windows
 * and windows for another class year and `total` counted them — so the two
 * halves of one sentence were drawn from different sets. The bar makes that
 * visible in a way the sentence did not, which is the whole argument for drawing
 * it: 16 of 25 is a claim, and a bar is a claim you can see is wrong.
 *
 * Trackable = still ahead of him. A window that has closed, or that is for
 * another graduating class, is not a date anyone is waiting on.
 */
export function trackableWindows(windows = []) {
  return windows.filter(
    (d) => d.status !== "closed" && d.status !== "wrong_class_year");
}

export function windowProgress(windows = []) {
  const live = trackableWindows(windows);
  return progressOf(live.filter((d) => d.closes).length, live.length);
}
