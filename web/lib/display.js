/**
 * Display rules. NO DATABASE, and that is the point.
 *
 * These decide how a role is shown and ordered, not what is in it, so they run
 * unchanged on the server and in the browser. They lived in db.js until a
 * "use client" row component imported bandOf from there and webpack tried to
 * bundle node:sqlite for the browser:
 *
 *   Module build failed: UnhandledSchemeError: Reading from "node:sqlite"
 *
 * db.js re-exports everything here, so existing imports keep working; client
 * components should import from this file directly.
 */

export const NEW_GRAD_PAY_CEILING = 200000;

/** The same predicate for a row already in hand. Keep in step with CURATED_Q. */
export function isCuratedReachable(r, { hidden = null } = {}) {
  if (!r) return false;
  if (!["program", "entry"].includes(r.entry_level)) return false;
  if ((r.class_fit || "ok") === "wrong_year") return false;
  if ((r.clearance_status || "none_mentioned") === "required_active") return false;
  if (hidden && hidden.has(r.key)) return false;
  if (r.entry_level === "program") return true;
  return r.comp_min == null || r.comp_min <= NEW_GRAD_PAY_CEILING;
}

/**
 * Fit bands. Haiku produces about twelve distinct values, so a two-digit number
 * implies a precision that is not there and twenty roles tied at 72 have no
 * meaningful order between them. The word is the display; the number is detail.
 */
export const BANDS = [
  ["Excellent", 85], ["Strong", 70], ["Good", 55], ["Fair", 35], ["Weak", 0],
];

export function bandOf(score) {
  const n = Number(score) || 0;
  for (const [name, min] of BANDS) if (n >= min) return name;
  return "Weak";
}

const BAND_RANK = Object.fromEntries(BANDS.map(([name], i) => [name, i]));

/**
 * The one ordering. Every list uses it, so two views can never disagree about
 * which of two roles comes first.
 *
 * Band first, then a deterministic tie-break — NOT the raw score. Within a band
 * the raw number is noise: 77 of the 89 roles in Strong are all exactly 72, and
 * run-to-run variance is about +/-10 points. Ordering 72 above 72 by anything
 * the scorer produced would be inventing precision.
 *
 *   1 saved by you            needs the actions table (step 3)
 *   2 new since your last visit  needs the visits table (step 3)
 *   3 new-grad programs before open-to-new-grads
 *   4 published pay before unpublished
 *   5 higher pay floor
 *   6 accessible before competitive before elite   needs companies.yaml (5c)
 *   7 title A-Z
 *   8 key, so the order is total and a refresh never reshuffles
 *
 * Criteria 1, 2 and 6 need data that does not exist yet. Each is SKIPPED
 * explicitly when its input is absent — not silently broken, not guessed — and
 * test_display.mjs asserts both the skip and the behaviour once data arrives.
 * Passing the context in is all step 3 and 5c have to do to switch them on.
 */
export const COMPETITIVENESS_RANK = { accessible: 0, competitive: 1, elite: 2 };

export function compareRoles({ saved = null, newSince = null, competitiveness = null } = {}) {
  const isNew = (r) =>
    newSince && r.first_seen && Date.parse(r.first_seen) > Date.parse(newSince);
  return (a, b) => {
    const band = BAND_RANK[bandOf(a.score)] - BAND_RANK[bandOf(b.score)];
    if (band) return band;

    if (saved) {
      const d = (saved.has(b.key) ? 1 : 0) - (saved.has(a.key) ? 1 : 0);
      if (d) return d;
    }
    if (newSince) {
      const d = (isNew(b) ? 1 : 0) - (isNew(a) ? 1 : 0);
      if (d) return d;
    }
    const prog = (b.entry_level === "program" ? 1 : 0) - (a.entry_level === "program" ? 1 : 0);
    if (prog) return prog;

    const known = (b.comp_min != null ? 1 : 0) - (a.comp_min != null ? 1 : 0);
    if (known) return known;

    const pay = (b.comp_min || 0) - (a.comp_min || 0);
    if (pay) return pay;

    if (competitiveness) {
      const rank = (r) => {
        const c = competitiveness.get ? competitiveness.get(r.company) : competitiveness[r.company];
        return COMPETITIVENESS_RANK[c] ?? 1;
      };
      const d = rank(a) - rank(b);
      if (d) return d;
    }
    const t = (a.title || "").localeCompare(b.title || "");
    if (t) return t;
    // Total, so a refresh cannot reshuffle two otherwise-identical rows.
    return (a.key || "").localeCompare(b.key || "");
  };
}

/** Human-readable, for the one line under the Inbox that explains the order. */
export function sortOrderSentence({ saved = null, newSince = null, competitiveness = null } = {}) {
  const bits = [];
  if (saved) bits.push("saved");
  if (newSince) bits.push("new since your last visit");
  bits.push("new-grad programs", "published pay", "higher pay");
  if (competitiveness) bits.push("companies that hire more broadly");
  bits.push("title");
  return `Within a band: ${bits.join(", then ")}.`;
}

export function sortRoles(rows, ctx = {}) {
  return [...rows].sort(compareRoles(ctx));
}

/**
 * Does this title read like an individual contributor role?
 *
 * DISPLAY ONLY — nothing is reclassified, and these roles stay in the Inbox.
 * Vanta "Operations Manager, Signal Systems" at $176-207K was sitting in
 * "Strong on both": a manager role at manager pay, which is the fail-open
 * entry-level classifier showing where it costs most, on the shortest and
 * highest-trust list in the tool.
 *
 * "Manager" alone is not disqualifying — Product Manager and Program Manager are
 * both tier-1 new-grad titles, and Product/Mission/Business Operations Manager
 * are real targets. A bare Operations Manager runs a function.
 */
export function looksLikeIC(title) {
  const t = (title || "").toLowerCase();
  if (!/\bmanagers?\b/.test(t)) return true;
  if (/\bproduct manager\b/.test(t)) return true;
  if (/\bprogram manager\b/.test(t)) return true;
  if (/\bassociate\b/.test(t)) return true;
  if (/\banalyst\b/.test(t)) return true;
  if (/\b(product|mission|business)\s+operations manager\b/.test(t)) return true;
  return false;
}

/**
 * Would this role's loop include a live coding interview the owner would fail?
 *
 * THE OWNER'S CALL, NOT AN INFERENCE. The original owner stated plainly that a
 * straight Software Engineer / SWE / Full Stack role screens with a live coding
 * interview they would not pass. Building and shipping real software end to end
 * is a different skill from performing algorithms on a whiteboard under a
 * clock. The tool's job is to stop pointing the owner at a loop they have told
 * it they fail, not to argue with them about it.
 *
 * DETERMINISTIC AND TITLE-ONLY. No model, no description reading. A title is a
 * short string the board controls, and "if code can decide it, code decides it".
 *
 * THE QUALIFIERS ARE THE WHOLE RULE. A qualified engineering title is a
 * different job with a different loop: Palantir's Forward Deployed Software
 * Engineer is the single most on-target posting in this corpus, and killing it
 * would be the exact mistake the first triage prompt made. So `product`,
 * `forward deployed` and `strateg*` exempt.
 *
 * "forward deployed", NOT bare "deployment". Read against the real corpus:
 * `Software Engineer, Autonomy Integration and Deployment` is a straight coding
 * role that happens to deploy autonomy software, and a bare `deployment`
 * qualifier would have exempted it. The FDSE family always carries the full
 * phrase.
 *
 * Word boundaries throughout, because this repo has paid for bare substrings
 * four times: `intern` killed every International role, `iv` killed Activity.
 * Here `\bswe\b` deliberately does not fire on "GenSWE".
 */
export const CODING_TERMS = [
  /\bsoftware engineers?\b/,
  /\bswe\b/,
  /\bfull[- ]?stack\b/,
];

export const CODING_QUALIFIERS = [
  /\bproducts?\b/,
  /\bforward[- ]deployed\b/,
  /\bstrateg(y|ic|ist|ists)\b/,
];

export function isCodingInterviewRole(title) {
  const t = String(title || "").toLowerCase();
  if (!CODING_TERMS.some((re) => re.test(t))) return false;
  if (CODING_QUALIFIERS.some((re) => re.test(t))) return false;
  return true;
}

/** The gray note the row shows when the rule fires. One string, one place. */
export const CODING_NOTE = "coding interview — not a fit as applied";

/**
 * Collapse the same role posted many times into one row. DISPLAY ONLY — every
 * underlying job row is kept, and `all` on the returned row is the full list.
 *
 * Two passes, because there are two distinct kinds of repetition on screen:
 *
 *  1. One role, many cities. Palantir posts "Deployment Strategist, Build to
 *     Apply - US Government" separately for Colorado Springs and New York.
 *     Same title, different location.
 *  2. One role, many variants. Anduril lists four "Mission Software Engineer, X"
 *     rows at an identical band and identical pay. Different title, same job as
 *     far as a reader scanning a page is concerned.
 *
 * A trailing segment is only treated as a location when it actually appears in
 * the row's own location field, so "Software Engineer - Growth" is never
 * mistaken for a city.
 */
const _PAREN_LOCATION = /\s*\((?:[^)]*,\s*[A-Z]{2}|remote|hybrid|onsite|on-site|us|usa)[^)]*\)\s*$/i;

export function normalizeTitle(title, location = "") {
  let t = (title || "").trim();
  t = t.replace(_PAREN_LOCATION, "");
  const loc = (location || "").toLowerCase();
  const tail = t.match(/^(.*?)\s+[-–—]\s+([^-–—]+)$/);
  if (tail && loc) {
    const seg = tail[2].trim().toLowerCase();
    if (seg && (loc.includes(seg) || seg.includes(loc.split(",")[0].trim()))) {
      t = tail[1].trim();
    }
  }
  return t.replace(/\s+/g, " ").trim();
}

/**
 * The first clause of a scorer angle.
 *
 * The angles are the best thing on Daily and they were also three lines of grey
 * text under every row — 254 to 473 characters each, eight of them, a wall. The
 * top three get the whole thing because that is where the fit numbers are tied
 * and the angle is the only thing that separates them; the rest get the opening
 * clause, which is where the scorer puts the claim.
 *
 * Cuts at a real boundary — em dash, semicolon, sentence end — and only inside a
 * sensible window, so it never severs a sentence mid-phrase. If no boundary
 * exists in range the whole thing is kept: a hard character cut mid-word reads
 * as a bug, and there is no ellipsis budget for pretending otherwise.
 */
export function angleLead(angle, max = 110) {
  const a = (angle || "").trim();
  if (a.length <= max) return a;
  const window = a.slice(0, max);
  // Boundaries in order of how cleanly they end a thought. The comma is on the
  // list deliberately: without it almost nothing was cut, because these angles
  // are long comma-spliced sentences and most carry no dash in the first 110
  // characters — the first version shortened one row out of eight.
  const cut = Math.max(
    window.lastIndexOf(" — "),
    window.lastIndexOf("; "),
    window.search(/\.\s/) >= 40 ? window.search(/\.\s/) + 1 : -1,
    window.lastIndexOf(", "),
  );
  if (cut >= 40) return a.slice(0, cut).trim() + "…";
  // No boundary at all. Break at a word rather than mid-word: a hard character
  // cut reads as a bug, and the full text is on the row's title attribute.
  const space = window.lastIndexOf(" ");
  return space >= 40 ? a.slice(0, space).trim() + "…" : a;
}

/**
 * Why a role was hidden. A FIXED list, deliberately, not free text.
 *
 * Hiding is the only judgement the owner makes on a role that the tool does not
 * already know, and there is no other record of it anywhere — six weeks from now
 * he will not remember why he passed on four hundred roles. That makes it the
 * only training data this system will ever produce about his own preferences.
 *
 * Fixed because a closed list can be counted and a free-text box cannot: "wrong
 * level" appearing 80 times is a filter that needs tuning, whereas eighty
 * differently-worded sentences are eighty sentences. `other` exists so the list
 * never forces a wrong answer — an unusable escape hatch produces bad data, not
 * no data.
 */
export const HIDE_REASONS = [
  ["wrong_level", "Wrong level"],
  ["wrong_location", "Wrong location"],
  ["wrong_function", "Wrong function"],
  ["not_the_company", "Not interested in the company"],
  ["other", "Other"],
];

export const HIDE_REASON_KEYS = HIDE_REASONS.map(([k]) => k);

/**
 * At most `n` roles per company, applied AFTER grouping.
 *
 * The order matters and the two pages disagreed about it. Daily capped postings
 * inside the SQL and then grouped, so Palantir's one role in six cities could
 * eat two of its two slots; Inbox grouped first and then capped, so the same
 * role took one. The counts came out 26 and 27, and Daily's "See all 26" landed
 * on a page of 27 — a link that states a count has to deliver it.
 *
 * After grouping is the correct order: the cap exists to stop one company
 * dominating the list, and a company dominates with roles, not with cities.
 */
export function capPerCompany(rows, n) {
  if (!n) return rows;
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const c = seen.get(r.company) || 0;
    if (c >= n) continue;
    seen.set(r.company, c + 1);
    out.push(r);
  }
  return out;
}

/**
 * How much THIS ROLE matters, as a weight for the row.
 *
 * Two wrong answers came before this one and both are worth keeping written down.
 *
 *   TIER does not discriminate. companies.yaml marks 21 of the 22 companies that
 *   hire this profile as tier 1, so weighting by it puts nearly every row in ink
 *   and differentiates nothing — the original complaint with extra steps.
 *
 *   COMPANY DEPTH discriminates, and measures the wrong thing. It rendered
 *   Databricks' "Associate Product Manager, New Grad (2027 Start)" as secondary
 *   because Databricks has one reachable role, while an open-now req at a
 *   fifty-role company read as primary. Depth of board is a fact about a
 *   company's hiring VOLUME; it says nothing about whether this role is worth a
 *   Tuesday, and on Daily that is the only question being asked.
 *
 * So: a class-year programme role, or a role in the top two bands. A programme
 * dated for the owner's class is something they can actually get on graduating; an open-now req
 * will be filled by Christmas. The first outranks the second even when the
 * second's company has fifty more roles.
 *
 * Depth keeps its place on Companies, where the question is "where are there many
 * shots" and it is the right primary sort.
 */
export const PRIMARY_BANDS = new Set(["Excellent", "Strong"]);

export function roleWeight(role) {
  if (!role) return "secondary";
  if (role.entry_level === "program") return "primary";
  return PRIMARY_BANDS.has(bandOf(role.score)) ? "primary" : "secondary";
}

/** Everything before the first comma or dash — the part a reader actually scans. */
export function titlePrefix(title) {
  return (title || "").split(/\s*[,–—]\s*|\s+-\s+/)[0].trim();
}

/**
 * The stable identity of a role, independent of which posting row it came from.
 *
 * Actions are stored against THIS, not against a job key. Palantir reposts and
 * re-ids "Deployment Strategist, Build to Apply - US Government" constantly and
 * lists it in six cities; saving it means saving the role, not one requisition
 * that will churn out of the board next week.
 */
export function groupKeyOf(row) {
  return `${row.company}|${normalizeTitle(row.title, row.location).toLowerCase()}`;
}

/**
 * Collapse the same role posted in several cities into one row. DISPLAY plus
 * IDENTITY: the returned `groupKey` is what Save, Hide and Applied write against.
 *
 * LOCATION ONLY. An earlier version also collapsed same-company, same-band,
 * same-pay titles sharing a prefix, so Anduril's four "Mission Software
 * Engineer, X" rows became one. Those are genuinely different jobs that happen
 * to share a prefix, and one action on that row would have meant something the
 * row could not express. Four honest rows beat one wrong one.
 *
 * Every underlying posting stays on `all`, and the full location list travels
 * with the group, so nothing is lost — only the repetition.
 */
/**
 * The cities in ONE row's location field.
 *
 * A board can answer either way. Greenhouse gives Anduril's "2027 Early Career
 * Software Engineer" as one posting listing nine cities, and fetch_jobs.py joins
 * a Rippling role's thirteen remote states the same way (fetch_jobs.py:538) —
 * always with "; ". So a single row can carry 331 characters of location, and
 * treating that as one place printed the whole string inline.
 *
 * The separator is the semicolon and nothing else. A comma is NOT one:
 * "Costa Mesa, California, United States" is a single place.
 */
export function splitLocations(location) {
  return String(location || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function groupRoles(rows) {
  const by = new Map();
  for (const r of rows) {
    const norm = normalizeTitle(r.title, r.location);
    const k = groupKeyOf(r);
    if (!by.has(k)) {
      by.set(k, { ...r, title: norm, groupKey: k, locations: [], all: [] });
    }
    const g = by.get(k);
    // Split for DISPLAY only. groupKeyOf still reads the raw field, because it
    // is the identity every Save, Hide and Applied is stored against — changing
    // what it hashes would orphan the lot.
    for (const loc of splitLocations(r.location)) {
      if (!g.locations.includes(loc)) g.locations.push(loc);
    }
    g.all.push(r);
  }
  const out = [...by.values()];
  for (const g of out) {
    g.displayTitle = g.title;
    g.locationLabel = g.locations.length > 1
      ? `${g.locations[0]} +${g.locations.length - 1} location${g.locations.length > 2 ? "s" : ""}`
      : (g.locations[0] || "");
  }
  return out;
}

/**
 * How long is left, and whether that earns the accent.
 *
 * --alert is the only colour in the design and it means "this is time-critical".
 * Four oranges on one screen is not a signal, it is decoration. So the horizons
 * differ by what kind of thing is running out:
 *
 *   on-you items   7 days.  These are yours to move. A thing due in twelve days
 *                  is not on fire, and colouring it says it is.
 *   deadlines     45 days.  External and unmovable — you cannot ask McKinsey to
 *                  reopen, so a longer runway genuinely is time-critical. This
 *                  was 21, which put the horizon INSIDE the task: the nearest
 *                  open window closes in 33 days and the page said nothing was
 *                  closing, while the owner's own item said to apply now. See
 *                  WINDOW_HORIZON_DAYS in lib/deadlines.js — same number, and
 *                  they must not drift.
 *
 * Everything else stays graphite WITH the day count still shown, so nothing is
 * hidden — only un-shouted. If the accent goes unused on most days, that is the
 * correct outcome: it means nothing is on fire.
 */
/**
 * How far ahead a window counts as "closing soon". 45 days, not 21.
 *
 * At 21 the page rendered "Nothing closing inside 21 days" while, three sections
 * above, the owner's own on-you item read "Apply to Accenture, Deloitte Consulting,
 * EY-Parthenon — the Aug-Sep window is open NOW". Both came out of the same
 * repository and they contradicted each other, because the nearest open window
 * closes in 33 days.
 *
 * 45 is chosen from the task, not from taste: a consulting application is a week
 * of work, and a warning horizon shorter than the thing it warns about cannot do
 * its job.
 *
 * It lives HERE rather than in lib/deadlines.js because that file imports
 * node:fs, and display.js is pulled into client components — the dependency has
 * to run deadlines -> display, never the reverse.
 */
export const WINDOW_HORIZON_DAYS = 45;

/**
 * How long a checked window stays checked.
 *
 * Load-bearing, and it fixes a permanent failure state rather than a preference.
 * A window checked with no date found returns to the queue with its recency
 * reset, so the undated queue NEVER EMPTIES — and while it outranked everything
 * below it, that meant the top of Daily read "check a careers page" every day
 * from October onwards while four overdue commitments sat below it, unreachable.
 * Simulated against the real data on 1 October and 1 December: tier 3 and tier 4
 * were never once selected.
 *
 * A cooldown makes the queue finite. Sixteen windows and a fortnight means
 * roughly one a day, and once all sixteen are fresh the tier goes quiet and the
 * work below it surfaces. Same number as the staleness mark, because "recently
 * enough that looking again is not worth ten minutes" and "recently enough to
 * trust" are the same judgement.
 */
export const STALE_DAYS = 14;

/**
 * The networking cadence: five new tier-1 contacts a week.
 *
 * From CLAUDE.md, and it is the tier that decides whether this tool is still
 * useful in December. Networking used to surface only when nothing else did,
 * which after the consulting windows close means never — so it competes on being
 * BEHIND THIS TARGET instead, which is a fact about the week rather than a fact
 * about how empty the page happens to be.
 */
export const CONTACTS_PER_WEEK = 5;

export const URGENT_DAYS = { item: 7, deadline: WINDOW_HORIZON_DAYS, followup: 0 };

/**
 * The identity a window check is recorded against.
 *
 * Lives here rather than in lib/deadlines.js for the same reason
 * WINDOW_HORIZON_DAYS does: deadlines.js imports node:fs, and both the browser
 * control that posts a check and the pure ladder need this string.
 */
export function windowKey(d) {
  return `window:${d.firm}|${d.program}`;
}

/**
 * The ONE order application windows are listed in: soonest close, then firm.
 *
 * Three surfaces were showing the same three firms three ways — the Today card
 * and Forecast alphabetically, Daily's "Closing soon" in whatever order
 * companies.yaml happened to list them. One fact should not have three
 * orderings, and a reader comparing two screens has no way to tell whether the
 * difference means something.
 *
 * Total, ending on program, so two windows at the same firm cannot swap between
 * loads.
 */
/**
 * What the date column of a window row says, and what kind of date it is.
 *
 * Four kinds, and they are not interchangeable:
 *   closes   the firm's own cutoff — the only one that is a deadline
 *   rolling  the firm has said there is no cutoff (open until filled)
 *   target   a date THE OWNER set for himself, for a firm that has published none
 *   none     nothing is known
 *
 * A target never uses the word "closes" and always says whose it is. It used
 * to be impossible to say this at all — the only date field was `closes` —
 * and a planning date put there rendered as the firm's deadline on every page.
 */
export function windowDateCell(d) {
  if (d.confidence === "planning-target") {
    return d.target
      ? { kind: "target", text: `your target ${d.target}` }
      : { kind: "none", text: "no target set" };
  }
  if (d.closes) return { kind: "closes", text: d.closes };
  if (d.rolling) return { kind: "rolling", text: "rolling — no cutoff" };
  return { kind: "none", text: "not confirmed" };
}

export function compareWindows(a, b) {
  return (a.closeIn ?? 9999) - (b.closeIn ?? 9999)
      || String(a.firm).localeCompare(String(b.firm))
      || String(a.program).localeCompare(String(b.program));
}

/**
 * An item nobody has touched in three weeks past its due date.
 *
 * It is not work any more, it is furniture, and leaving it in the list teaches
 * you to read past the list. It is HIDDEN, never deleted — the row stays, in a
 * collapsed group, saying exactly what it is: "three weeks on the list. Rewrite
 * it or drop it."
 *
 * Any answer at all — done, stuck, or a new due date — takes it out of this
 * state, which is the point: the escape hatch is one click and it is offered on
 * the row.
 */
export const STALL_DAYS = 21;

/**
 * Three deferrals is an answer.
 *
 * Same principle as "two follow-ups, then stop": pushing something away
 * repeatedly IS a decision, and a tool that keeps asking has stopped listening.
 * After the third "not this week" the item stalls permanently and says why,
 * rather than coming back every seven days forever.
 */
export const MAX_DEFERRALS = 3;

export function stalled(item) {
  if (item.done || item.split) return false;
  if ((item.deferrals || 0) >= MAX_DEFERRALS) return true;
  if (item.stuck) return false;
  return item.dueIn !== null && item.dueIn !== undefined
    && item.dueIn < -STALL_DAYS;
}

/**
 * The items actually on the open list — the ONE definition of it.
 *
 * Not done, not stalled, and a child only on the day it was surfaced. That is
 * three conditions and they lived inside the Items component, which was fine
 * until the section header needed to say "4 hidden" while folded: a header
 * counting `items.filter(i => !i.done)` and a list rendering these three rules
 * are two numbers from two populations sitting on the same section, which is
 * the failure the Companies row already taught this codebase once.
 *
 * `today` is the owner's date — see lib/day.js. Passing it in rather than reading
 * it here keeps this pure and keeps the timezone decision in one place, which
 * is the whole reason lib/day.js exists.
 */
export function openItems(items = [], today = null) {
  const parentIds = new Set(items.map((i) => i.parent_id).filter(Boolean));
  return items.filter((i) => !i.done)
              .filter((i) => !stalled(i))
              .filter((i) => !i.parent_id || i.surfaced_on === today)
              // A parent is a running total, not a job: it has no checkbox and
              // cannot be completed, so it is not one of the things on you.
              .filter((i) => !parentIds.has(i.id));
}

/** Why it is in the stalled group, in the words the row should use. */
export function stallReason(item) {
  if ((item.deferrals || 0) >= MAX_DEFERRALS) {
    return `deferred ${item.deferrals} times; rewrite it or drop it`;
  }
  return `more than ${STALL_DAYS} days past due; rewrite it or drop it`;
}

/**
 * How long this has been sitting, in words. Counts UP.
 *
 * A countdown implies progress. For something twelve days old that nobody has
 * opened, age is the honest number, and it is the one that says what is actually
 * happening.
 */
export function itemAge(item) {
  const bits = [];
  if (item.ageDays !== null && item.ageDays !== undefined && item.ageDays >= 1) {
    bits.push(`added ${item.ageDays} day${item.ageDays === 1 ? "" : "s"} ago`);
  }
  if (item.stuck) {
    bits.push(item.stuckDays >= 1 ? `stuck for ${item.stuckDays} days` : "marked stuck");
  } else if (item.dueIn !== null && item.dueIn < 0) {
    bits.push("never touched");
  }
  return bits.join(" · ");
}

export function horizon(days, kind = "item") {
  const limit = URGENT_DAYS[kind] ?? 7;
  if (days === null || days === undefined) return { label: "no date", urgent: false };
  if (days < 0) return { label: `${-days}d overdue`, urgent: true };
  if (days === 0) return { label: "today", urgent: true };
  return {
    label: `${days} day${days === 1 ? "" : "s"}`,
    urgent: days <= limit,
  };
}

/**
 * Which deadlines get the accent: ONE per close date, the soonest first.
 *
 * Deloitte, Accenture and EY-Parthenon all close 2026-09-30. From 8 September
 * all three sit inside the 21-day window, so the page went orange three times
 * for one fact — and the accent stops meaning anything long before that.
 *
 * The others keep their day count, in graphite. Nothing is hidden; the same
 * date is simply not shouted three times.
 *
 * Returns a Set of the keys that earn it.
 */
export function accentedDeadlines(list = []) {
  const bySoonest = [...list]
    .filter((d) => d.closeIn !== null && d.closeIn !== undefined
                   && d.closeIn <= URGENT_DAYS.deadline)
    .sort(compareWindows);
  const seenDate = new Set();
  const out = new Set();
  for (const d of bySoonest) {
    const date = d.closes || `no-date:${d.firm}`;
    if (seenDate.has(date)) continue;
    seenDate.add(date);
    out.add(`${d.firm}|${d.program}`);
  }
  return out;
}
