/**
 * Deadlines come from companies.yaml, not from code.
 *
 * A hardcoded date in a component is what caused the near-miss: the note said
 * MBB closed "mid/late September" when McKinsey actually closed 2026-08-11.
 * Parsed here with a minimal reader so the app has no YAML dependency — the
 * `deadlines:` block is a flat list of scalar key/value pairs by design.
 */
import fs from "node:fs";
import path from "node:path";
import { WINDOW_HORIZON_DAYS, windowKey, compareWindows, STALE_DAYS } from "./display.js";
import { daysUntil, daysSince } from "./day.js";

export { WINDOW_HORIZON_DAYS, windowKey, STALE_DAYS };

const YAML_PATH = path.join(process.cwd(), "..", "companies.yaml");

export function parseDeadlines(text) {
  const start = text.search(/\r?\ndeadlines:/);
  if (start === -1) return [];
  // Split on /\r?\n/, not "\n". Any edit that saves this file with Windows line
  // endings — a text editor, or a script writing it in text mode — leaves a \r
  // on the end of every line, and every regex below then quietly matches
  // nothing. The page showed ZERO deadlines and looked like a data problem.
  const body = text.slice(start + 1).split(/\r?\n/);
  const items = [];
  let cur = null;
  let key = null;

  for (let i = 1; i < body.length; i++) {
    const line = body[i];
    if (/^\S/.test(line) && !line.startsWith(" ") && line.trim() && i > 0) break; // next top-level key
    const item = line.match(/^\s{2}-\s+(\w+):\s*(.*)$/);
    const pair = line.match(/^\s{4}(\w+):\s*(.*)$/);
    const cont = line.match(/^\s{6,}(\S.*)$/);

    if (item) {
      if (cur) items.push(cur);
      cur = {};
      key = item[1];
      cur[key] = clean(item[2]);
    } else if (pair && cur) {
      key = pair[1];
      cur[key] = clean(pair[2]);
    } else if (cont && cur && key) {
      cur[key] = ((cur[key] ? cur[key] + " " : "") + cont[1].trim()).trim();
    }
  }
  if (cur) items.push(cur);
  return items;
}

function clean(v) {
  const s = (v || "").trim();
  if (s === "" || s === ">" || s === "|") return "";
  if (s === "null" || s === "~") return null;
  return s.replace(/^["']|["']$/g, "");
}

// CALENDAR DAYS IN THE OWNER'S TIMEZONE, from day.js. This used to subtract an
// INSTANT from midnight UTC on the close date, which is a duration and not a
// count of days: it came out a day short for nineteen hours out of every
// twenty-four, because Los Angeles is seven hours behind UTC and the fraction
// always rounded down. Every countdown in the tool read one day less than the
// calendar, and the 7/3/1 warning emails fired a day early. See daysUntil().
const days = (iso) => daysUntil(iso);

/**
 * One parsed row into the shape every surface reads. Pure.
 *
 * A PLANNING TARGET IS NOT A DEADLINE. `closes` is the firm's date and nothing
 * else; a date the owner set for himself — "materials ready by 15 Sept" for a firm
 * that has published nothing — goes in `target`, and the row is labelled
 * `confidence: planning-target`. The two are refused in either mixed form,
 * because fed through as `closes` a planning date came out with the same
 * countdown and the same urgent flag as a verified deadline beside it, and
 * every table downstream would have rendered it as the firm's cutoff. That is
 * the McKinsey failure in a new form: a date nobody at the firm set, dressed
 * as a fact, and acted on as if missing it lost the cycle.
 */
export function shapeWindow(d) {
  const who = `${d.firm} — ${d.program}`;
  if (d.confidence === "planning-target" && d.closes) {
    throw new Error(
      `${who}: a planning-target row may not carry closes: ${d.closes}. `
      + "A date you set for yourself goes in `target:`; `closes:` is the firm's date.");
  }
  if (d.target && d.confidence !== "planning-target") {
    throw new Error(
      `${who}: a row with target: ${d.target} must be confidence: planning-target, `
      + "or nobody reading the row can tell whose date it is.");
  }
  const closeIn = days(d.closes);
  const targetIn = days(d.target);
  const verifiedAgo = d.verified ? -days(d.verified) : null;
  return {
    ...d,
    closeIn,
    target: d.target || null,
    targetIn,
    // "No cutoff, open until filled" is a stated fact about the window, not an
    // absence of data — and it has to render as one, or a verified rolling
    // window reads "not confirmed" beside a chip saying "confirmed".
    rolling: d.rolling === true || d.rolling === "true",
    verifiedAgo,
    // Every value out of the parser is a string. `minutes` is arithmetic —
    // the ladder compares it against the time available — so it is coerced
    // here rather than at each call site.
    minutes: d.minutes ? Number(d.minutes) || null : null,
    stale: verifiedAgo !== null && verifiedAgo > STALE_DAYS,
    urgent: d.status === "open" && closeIn !== null && closeIn <= WINDOW_HORIZON_DAYS,
  };
}

export function getDeadlines() {
  let raw;
  try {
    raw = fs.readFileSync(YAML_PATH, "utf8");
  } catch {
    return [];
  }
  return parseDeadlines(raw).map(shapeWindow);
}

/**
 * Fold recorded checks over the yaml.
 *
 * companies.yaml is the seed; the `actions` table records what has happened
 * since, because a deployed app cannot write to the repo. Two effects:
 *
 *   - a check refreshes `verified`, which is what tier 2 orders by, so pressing
 *     "checked it" moves that window to the back of the queue and the ladder
 *     stops asking about it. That is the whole point: an answer the page accepts.
 *   - a check that CARRIED A DATE sets `closes` and marks the window `verified`,
 *     in the sense companies.yaml means — read from the firm's own site by a
 *     human. It is the only route by which a window here ever becomes verified,
 *     and 1 of 25 is today.
 *
 * Pure, so the rules can be tested without a database.
 */
export function applyChecks(windows, checks = new Map()) {
  return windows.map((d) => {
    const c = checks.get(windowKey(d));
    if (!c) return d;
    const closes = c.closes || d.closes;
    // THE SAME HELPER THE UNCHECKED PATH USES. It was a second copy of the
    // instant-minus-UTC-midnight formula, so a window the owner had checked by hand
    // and one he had not were counted by two different pieces of arithmetic
    // that happened to agree on their shared bug — and would have diverged the
    // moment either was fixed alone.
    const closeIn = daysUntil(closes);
    // `c.at` is a full timestamp rather than a date, so it is sliced to its
    // date before being counted. Measuring it as an instant made `verifiedAgo`
    // mean one thing for a checked window and another for a seeded one, while
    // both are compared against the same STALE_DAYS.
    const verifiedAgo = daysSince(c.at);
    return {
      ...d,
      closes,
      closeIn,
      // A date the owner read off the firm's own site is exactly what `verified`
      // means here. Without a date, the check refreshes recency and nothing else
      // — "I looked, there is still no date" must not become "confirmed".
      confidence: c.closes ? "verified" : d.confidence,
      status: c.closes && d.status === "unconfirmed" ? "open" : d.status,
      verified: c.at.slice(0, 10),
      verifiedAgo,
      checkedByHand: true,
      stale: verifiedAgo > STALE_DAYS,
      urgent: (c.closes ? true : d.status === "open")
        && closeIn !== null && closeIn <= WINDOW_HORIZON_DAYS,
    };
  });
}

/**
 * Windows with no close date at all — the actual risk in this data.
 *
 * 16 of 25. Not closed, not the wrong class year, just unknown: nobody is
 * watching them and a missed one costs a cycle. The four that DO have a date are
 * the reassuring half, and a page that shows only those is telling the owner the
 * opposite of the truth.
 *
 * Least-recently-checked first, because that is the honest order and it needs no
 * data nobody has entered. There is no `season` field, and inventing one from
 * the free-text notes would be a guess wearing a schema.
 */
export function undatedWindows(windows = getDeadlines()) {
  return windows
    .filter((d) => !d.closes && d.status !== "closed" && d.status !== "wrong_class_year")
    .sort((a, b) => (b.verifiedAgo ?? -1) - (a.verifiedAgo ?? -1)
                 || String(a.firm).localeCompare(String(b.firm))
                 || String(a.program).localeCompare(String(b.program)));
}

/** Everything with a live window, soonest close first. The landing element. */
export function openNow() {
  return getDeadlines()
    .filter((d) => d.status === "open")
    .sort(compareWindows);
}
