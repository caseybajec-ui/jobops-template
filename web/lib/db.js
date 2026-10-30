/**
 * The ONLY file that talks to the database.
 *
 * Everything else imports the functions below and never sees SQL or a driver.
 * The hosted phase swaps SQLite for Neon Postgres by rewriting this file alone —
 * keep it that way. No SQL, no `db` handle, and no table names leak out of here.
 *
 * Uses node:sqlite, built into Node 22+, so there is no native module to compile
 * on Windows ARM64. The Python CLI is the writer of record for job data; this
 * app writes application stage and notes only, and never calls the Anthropic API.
 */
import { all, one, run, USING_PG } from "./driver.js";
import { once } from "./once.js";
import { contactsByCompany } from "./contacts.js";
import { LIFECYCLE_KEYS, currentStatus } from "./lifecycle.js";
import {
  foldFlags, isWrongCycle, wrongCycleNote, FLAG_WRONG_CYCLE,
} from "./actions.js";
import { foldBlocked, isBlocked, NO_BLOCKS } from "./blocked.js";
import { daysUntil } from "./day.js";
import { labelEvidence } from "./profile.js";
// The start_window label the gate writes for a role dated for the owner's
// class ("<year> program"). Baked from profile.json, never a literal here: the
// original carried the year in three queries and a comparison, and a copy for
// another owner would have counted the wrong class under the right header.
import { PROGRAM_WINDOW } from "./config.generated.js";
import {
  BANDS, bandOf, compareRoles, sortRoles, sortOrderSentence, groupRoles,
  normalizeTitle, titlePrefix, looksLikeIC, isCuratedReachable, groupKeyOf,
  NEW_GRAD_PAY_CEILING, COMPETITIVENESS_RANK, capPerCompany,
} from "./display.js";

// Re-exported so callers can keep importing from one place.
export {
  BANDS, bandOf, compareRoles, sortRoles, sortOrderSentence, groupRoles,
  normalizeTitle, titlePrefix, looksLikeIC, isCuratedReachable, groupKeyOf,
  NEW_GRAD_PAY_CEILING, COMPETITIVENESS_RANK, capPerCompany,
};


export const STAGES = [
  "found", "researching", "reached_out", "applied",
  "phone_screen", "interviewing", "offer", "rejected", "withdrawn",
];

const JOB_FIELDS = `
  j.key, j.source, j.company, COALESCE(j.display_name, j.company) AS display_name,
  j.title, j.location, j.url, j.category, j.start_window,
  j.yoe, j.posted_at, j.first_seen, j.entry_level,
  j.comp_min, j.comp_max, j.comp_source,
  j.class_fit, j.class_reason, j.class_text, j.start_year, j.class_year,
  j.clearance_status,
  s.score, s.tier, s.reasons, s.gaps, s.evidence_ids, s.angle,
  s.score_lo, s.score_hi, s.score_spread, s.n_samples, s.effort, s.model,
  a.stage, a.notes, a.updated_at, a.next_action, a.next_action_at
`;
const JOB_FROM = `
  FROM jobs j
  JOIN scores s ON s.key = j.key
  LEFT JOIN applications a ON a.key = j.key
`;

/**
 * "Reachable" — a role someone graduating with the owner's class could actually take.
 *
 * Three conditions. The level has to hire out of college; the posting has to be
 * for his graduating class; and it must not demand a clearance he does not hold.
 *
 * A December 2026 new-grad role passes every other rule in the pipeline — right
 * seniority, right phrase in the title, right pay band — and is still not his.
 * A role requiring an ACTIVE clearance is not a stretch, it is a closed door:
 * clearances are sponsored by an employer, so he cannot obtain one in order to
 * apply. Roles that merely require eligibility stay in; those he can do.
 *
 * Anything with no evidence either way stays in. Absent evidence never deletes.
 *
 * Defined once, in the two forms the queries need, so a view cannot drift.
 */
const RIGHT_CLASS = `COALESCE(class_fit,'ok') <> 'wrong_year'`;
const NO_CLEARANCE = `COALESCE(clearance_status,'none_mentioned') <> 'required_active'`;
const REACHABLE_Q = `j.entry_level IN ('program','entry')
  AND COALESCE(j.class_fit,'ok') <> 'wrong_year'
  AND COALESCE(j.clearance_status,'none_mentioned') <> 'required_active'`;

/**
 * The roles a contact at this company can actually be asked about.
 *
 * WHY IT IS NOT JUST 'every open role'. Palantir has 310 open. A cold note
 * asking about a staff hardware req nobody could take reads as someone who
 * did not look, which is worse than a generic note -- it spends the one
 * message on a role that was never his. REACHABLE_Q is reused rather than
 * respelled, so this list and the Companies count can never mean two
 * different things by 'reachable'.
 *
 * ORDERED BY SCORE, tie-broken on key. A comparator that can return 0 for
 * two distinct rows reshuffles the picker between renders, and this one
 * ties constantly -- Palantir has eight roles at exactly 78.
 *
 * The clearance filter matters more here than anywhere else in the app: a
 * note asking a stranger about a req that demands a clearance he does not
 * hold invites the one question the whole outreach strategy exists to route
 * around.
 */
/**
 * What THE OWNER did, for the on-track meter. Counts, not rows.
 *
 * Each figure comes back as null when its query throws, never as 0 -- a
 * failed read rendering as "0 of 3" is indistinguishable from a real month
 * with nothing in it, and only one of those is worth an afternoon. Three
 * separate try blocks for the same reason: one unreadable table must not
 * blank the other two.
 *
 * APPLICATIONS come from the same union every other application count in
 * the app reads, so the meter and the dashboard cannot disagree about how
 * many went in.
 *
 * MESSAGES are outreach_sent interactions THIS WEEK, from Monday. Not
 * contacts.first_touch: that is when the first message went out, so a
 * contact messaged twice counts once and a contact added but not messaged
 * counts as activity. The weekly cadence already made that exact mistake
 * once and read permanently zero.
 */
export async function onTrackCounts(now = new Date()) {
  const monthStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const d = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
  const dow = d.getUTCDay();
  const weekStart = new Date(
    d.getTime() - (dow === 0 ? 6 : dow - 1) * 86400000)
    .toISOString().slice(0, 10);

  let applications = null;
  try {
    const { listActiveApplications } = await import("./applications.js");
    const rows = await listActiveApplications(now);
    applications = rows.filter(
      (a) => a.submittedAt && String(a.submittedAt).slice(0, 10) >= monthStart
    ).length;
  } catch { applications = null; }

  let messages = null;
  try {
    const r = await one(
      `SELECT count(*) AS n FROM interactions
        WHERE type = 'outreach_sent' AND substr(occurred_at, 1, 10) >= ?`,
      [weekStart]);
    messages = r ? Number(r.n) : null;
  } catch { messages = null; }

  let replies = null;
  try {
    const r = await one(
      `SELECT count(*) AS n FROM interactions
        WHERE type = 'reply_received' AND substr(occurred_at, 1, 10) >= ?`,
      [monthStart]);
    replies = r ? Number(r.n) : null;
  } catch { replies = null; }

  return { applications, messages, replies };
}

/**
 * Pages that changed since the last digest, and windows that opened.
 *
 * A page whose watcher is BROKEN is neither -- it is a health line. Reading
 * a 403 as "no change" is the always-empty-source failure, and this project
 * has hit it three times on three different surfaces.
 */
export async function watchedPageNews(sinceHours = 26) {
  const cutoff = new Date(Date.now() - sinceHours * 3600000).toISOString();
  const changed = await all(
    `SELECT url, label, category, last_changed_at, last_diff, last_status_hit
       FROM watched_pages
      WHERE last_changed_at IS NOT NULL AND last_changed_at >= ?
      ORDER BY last_changed_at DESC, url`, [cutoff]).catch(() => null);
  const broken = await all(
    `SELECT url, label, last_error, fail_streak FROM watched_pages
      WHERE last_error IS NOT NULL ORDER BY fail_streak DESC, url`)
    .catch(() => null);
  const total = await one(
    "SELECT count(*) AS n FROM watched_pages").catch(() => null);
  return {
    changed, broken,
    total: total ? Number(total.n) : null,
    // NULL means the read failed. The digest renders that differently from
    // an empty list, because "nothing changed" and "we could not look" are
    // not the same night.
    ok: changed !== null && broken !== null,
  };
}


/**
 * TODAY'S FIVE: the people to write to today, best-ranked first.
 *
 * NEVER RANK 7. The team-page run produced 47 rank-5-and-7 rows against 3
 * useful ones, and a queue that shows everything is a queue nobody reads.
 *
 * SKIPPED PEOPLE STAY AWAY FOR 30 DAYS. A skip is a decision about TODAY --
 * deleting the row would let tomorrow's run suggest them again, and keeping it
 * forever would lose someone whose company later opens the right role.
 */
export async function todaysFive(limit = 5, now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  return all(
    `SELECT s.*, COALESCE(j.display_name, s.company) AS company_label,
            (SELECT count(*) FROM jobs j2 JOIN scores sc ON sc.key = j2.key
              WHERE j2.company = s.company_slug AND j2.closed_at IS NULL
                AND sc.score >= 60) AS open_roles
       FROM suggested_contacts s
       LEFT JOIN jobs j ON j.company = s.company_slug AND j.closed_at IS NULL
      WHERE s.promoted_at IS NULL
        AND s.rank <= 6
        AND (s.skipped_at IS NULL OR s.skipped_at < ?)
      GROUP BY s.id, company_label
      -- Best rank, then newest, then id so the five do not reshuffle between
      -- two loads of the same page.
      ORDER BY s.rank ASC, s.created_at DESC, s.id
      LIMIT ?`, [cutoff, limit]);
}

/**
 * What the local reader did last night, for the digest's health line.
 *
 * NULL WHEN IT NEVER RAN, which is different from a run that found nothing and
 * different again from a halt. Three states, three sentences.
 */
export async function lastReaderRun() {
  return one("SELECT * FROM reader_runs ORDER BY ran_at DESC LIMIT 1")
    .catch(() => null);
}


export async function rolesForOutreach(company, { limit = 12 } = {}) {
  if (!company) return [];
  return all(
    `SELECT j.key, j.title, j.location, j.url, s.score
       FROM jobs j LEFT JOIN scores s ON s.key = j.key
      WHERE j.company = ? AND j.closed_at IS NULL
        AND ${REACHABLE_Q}
      ORDER BY s.score DESC NULLS LAST, j.key
      LIMIT ?`,
    [company, limit]);
}

/**
 * The curated list — what Daily is allowed to show.
 *
 * Reachable, and additionally under the new-grad pay ceiling. Confirmed new-grad
 * programme roles in this corpus top out at $203K with a p90 of $140K, so a role
 * whose FLOOR is above $200K is a mid-level role the entry-level classifier let
 * through. Those flip-backs — Anthropic Product Operations Manager at $240-260K,
 * OpenAI Research Program Manager at $239-328K, Anthropic AI Operations Engineer
 * at $215-300K — were hidden from one Daily list and showing in the next.
 *
 * An explicit programme role is never filtered on pay: if a company says it hires
 * new grads, its number is right and the classifier's inference is not.
 * Unknown pay always passes — unknown is not high.
 *
 * ONE definition, in SQL and in JS, so a list and a count can never disagree.
 */
const UNDER_CEILING = `(entry_level = 'program' OR comp_min IS NULL OR comp_min <= 200000)`;
const CURATED_Q = `${REACHABLE_Q}
  AND (j.entry_level = 'program' OR j.comp_min IS NULL OR j.comp_min <= 200000)`;

// ONE MODEL, ONE SCALE. Every score comes from claude-haiku-4-5-20251001.
//
// Do NOT reintroduce percentile ranking. It was tried and it was wrong:
// percentile-within-model is only valid when both models scored the same
// population, and two models never should. A raw 72 landed at Haiku's 74th
// percentile while a Sonnet 54 landed at Sonnet's 98th, so 54 outranked 82.
// The scores are directly comparable now; rank on the number.

function shape(r) {
  const parse = (v) => {
    try {
      return v ? JSON.parse(v) : [];
    } catch {
      return [];
    }
  };
  const touched = r.updated_at || r.first_seen;
  const days = touched
    ? Math.floor((Date.now() - Date.parse(touched)) / 86400000)
    : null;
  // Wide spread means the scorer disagreed with itself across samples, which
  // is a signal in its own right: read the reasons rather than trust the number.
  const spread = r.score_spread ?? 0;
  return {
    ...r,
    // The identity every app-owned fact about a role is keyed by — Save, Hide,
    // Applied, and now the wrong-cycle flag. Attached HERE, in the one function
    // every row passes through, so no list can forget it and silently fail to
    // filter.
    groupKey: groupKeyOf(r),
    confidence: spread <= 6 ? "tight" : spread <= 14 ? "mid" : "wide",

    reasons: parse(r.reasons),
    gaps: parse(r.gaps),
    evidence_ids: parse(r.evidence_ids),
    // "briefd_batch" means nothing on screen. Resolve to what it refers to, so
    // "Lead with" reads as an instruction rather than a lookup key.
    evidence: labelEvidence(parse(r.evidence_ids)),
    stage: r.stage || "found",
    comp: r.comp_min
      ? (r.comp_min === r.comp_max
          ? `$${Math.round(r.comp_min / 1000)}K`
          : `$${Math.round(r.comp_min / 1000)}–${Math.round(r.comp_max / 1000)}K`)
      : null,
    daysSinceTouch: days,
    stale: days !== null && days >= 7,
  };
}

/**
 * Ranked roles. `cap` limits rows per company — without it Palantir alone was
 * 17 of the top 25, which measures board size rather than fit.
 */
export async function listJobs({
  minScore = 0, category = null, company = null, stage = null,
  startWindow = null, cap = 3, limit = 100, showExperienced = false,
  sort = "fit", payKnown = false, minPay = 0, maxPay = 0, showOtherYears = false,
  showClearance = false, sortCtx = {}, curatedOnly = false,
} = {}) {
  const where = ["score >= ?"];
  const params = [minScore];
  if (category) { where.push("category = ?"); params.push(category); }
  if (company) { where.push("company = ?"); params.push(company); }
  if (startWindow) { where.push("start_window = ?"); params.push(startWindow); }
  // Default to roles a new grad can actually get. Experienced roles are
  // networking intelligence, not applications, and mixing them was the single
  // biggest reason the list read as noise.
  if (!showExperienced) where.push("entry_level IN ('program','entry')");
  // Roles for another graduating class. Off by default; the toggle brings them
  // back rather than hiding them for good.
  if (!showOtherYears) where.push(RIGHT_CLASS);
  // A clearance he cannot obtain without an employer to sponsor it.
  if (!showClearance) where.push(NO_CLEARANCE);
  // The same set Daily's "Worth a look today" draws from, so the link from
  // that section lands on exactly the roles it was choosing between.
  if (curatedOnly) where.push(UNDER_CEILING);
  if (payKnown) where.push("comp_min IS NOT NULL");
  // A low band is a PREFERENCE, not a disqualifier — nothing is reclassified on
  // pay here, and unknown pay always survives the filter.
  if (minPay > 0) { where.push("(comp_min IS NULL OR comp_min >= ?)"); params.push(minPay); }
  // A CEILING, and it is NOT the mirror of the floor. `minPay` lets unknown pay
  // through, because unknown is not low and hiding it would drop most of the
  // corpus for a preference. This one exists solely to answer "show me the
  // roles in that count", and that count is `comp_min IS NOT NULL AND comp_min
  // < 90000` — so an unpublished figure is not one of them and must not appear.
  // Two numbers on one row have to come from one population; this is the same
  // rule applied to a number and the list it links to.
  if (maxPay > 0) { where.push("(comp_min IS NOT NULL AND comp_min < ?)"); params.push(maxPay); }
  if (stage) {
    where.push(stage === "found" ? "COALESCE(stage,'found') = ?" : "stage = ?");
    params.push(stage);
  }
  // One scale, so a raw min score is directly meaningful.
  // SQL pulls a superset in a stable order; the ORDERING is compareRoles, so
  // every list in the app agrees. Only the pay view overrides it, because
  // "highest pay" is a different question from "best fit".
  const all_ = (await all(
    `SELECT * FROM (
       SELECT ${JOB_FIELDS} ${JOB_FROM}
       WHERE j.closed_at IS NULL AND s.score IS NOT NULL
     ) WHERE ${where.join(" AND ")}
     ORDER BY score DESC, key LIMIT ?`,
    [...params, Math.max(limit * 8, 800)]
  )).map(shape);
  // Before the sort and before the per-company cap: a hidden role must not
  // consume one of the two slots its company is allowed, or hiding one row
  // would silently delete a different one.
  const raw = await visibleRoles(all_);

  const rows = sort === "new"
    // Newest by when WE first saw it. posted_at is not comparable across ATSs —
    // Greenhouse reports the last edit and Lever the requisition creation.
    ? [...raw].sort((a, b) =>
        String(b.first_seen || "").localeCompare(String(a.first_seen || ""))
        || (a.key || "").localeCompare(b.key || ""))
    : sort === "pay"
    // Unknown pay is NOT low pay. Sort it to the END of the pay view rather
    // than to the bottom as though it were zero.
    ? [...raw].sort((a, b) =>
        (a.comp_min == null ? 1 : 0) - (b.comp_min == null ? 1 : 0)
        || (b.comp_min || 0) - (a.comp_min || 0)
        || (a.key || "").localeCompare(b.key || ""))
    : sortRoles(raw, sortCtx);

  if (!cap) return rows.slice(0, limit);
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const n = seen.get(r.company) || 0;
    if (n >= cap) continue;
    seen.set(r.company, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Company view — the primary view.
 *
 * The owner graduates with the baked class year, so a role open today will be
 * filled long before they can start. What matters is which companies hire this
 * profile into roles they want; that is intelligence for relationship-building,
 * not an application queue. Hence: counts at 40+/60+, the best role, and when
 * class-year-dated roles first appeared, which is the signal for when to
 * expect them again this year.
 */
export async function listCompanies({ sort = "best" } = {}) {
  // PROGRAM_WINDOW goes in as a parameter, three times, rather than being
  // interpolated into the SQL: a string from config inside a template literal
  // is one quote away from a broken query, and a parameter cannot be.
  const rows = await all(`
    SELECT
      j.company                                            AS name,
      COALESCE(MAX(j.display_name), j.company)             AS display_name,
      COUNT(*)                                             AS roles,
      SUM(CASE WHEN s.score >= 40 THEN 1 ELSE 0 END)       AS at40,
      SUM(CASE WHEN s.score >= 60 THEN 1 ELSE 0 END)       AS at60,
      -- BEST REACHABLE, not best overall. This was MAX(score) across every
      -- scored role, and it sits on the row next to bestTitle, which has always
      -- been filtered to reachable roles — so the band and the title beside it
      -- could describe different jobs. ICONIQ showed "Strong" against a role
      -- the owner cannot take; its best reachable is Weak. Stripe showed "Good"
      -- against a Weak one.
      --
      -- Two numbers on one row must come from one population, or the row is
      -- comparing different things and inviting a wrong conclusion. Same shape
      -- as the cost meter showing lifetime against a since-reset cap, and as
      -- n2027 counting prior-December roles under a header reading the class year.
      MAX(CASE WHEN ${REACHABLE_Q} THEN s.score END)        AS best,
      MAX(s.score)                                          AS bestAny,
      SUM(CASE WHEN s.score >= 40 AND ${REACHABLE_Q}
               THEN 1 ELSE 0 END)                          AS reachable40,
      SUM(CASE WHEN ${REACHABLE_Q} THEN 1 ELSE 0 END) AS reachable,

      -- CLASS-YEAR ROLES THE OWNER COULD TAKE. This used to count every scored
      -- role with the class-year start window, no score floor and no
      -- reachability check, under a column header reading the year — so Applied Intuition showed 9 next to
      -- "1 role here fit you". Five of those nine are titled "New Grad
      -- (December 2026)" and carry class_fit = wrong_year: not his class at all.
      -- Anduril read 15 against 1 reachable, Palantir 24 against 17.
      --
      -- It is the same defect the at40 column had, in the next column along: a
      -- count drawn from a wider population than its own header describes. Both
      -- numbers on a row have to mean the same thing or the row cannot be read.
      -- (No backticks in here: this comment lives inside a template literal.)
      SUM(CASE WHEN j.start_window = ? AND s.score >= 40
               AND ${REACHABLE_Q} THEN 1 ELSE 0 END)                  AS n2027,
      -- The unfiltered figure, kept for the tooltip: how many class-year-dated
      -- roles this company posts at all is real information about its hiring
      -- calendar, it is just not a count of the owner's shots.
      SUM(CASE WHEN j.start_window = ? THEN 1 ELSE 0 END) AS n2027All,
      MIN(CASE WHEN j.start_window = ?
               THEN COALESCE(j.posted_at, j.first_seen) END)           AS first2027,
      MAX(j.category)                                      AS category
    ${JOB_FROM}
    WHERE j.closed_at IS NULL AND s.score IS NOT NULL
    GROUP BY j.company
  `, [PROGRAM_WINDOW, PROGRAM_WINDOW, PROGRAM_WINDOW]);

  // Best role title + the furthest-along stage, per company.
  // Best REACHABLE role per company, chosen by an explicit window function.
  // A GROUP BY ... HAVING score = MAX(score) silently returned the wrong row for
  // some companies (Stripe had a role at 40+ and still read "nothing strong yet").
  //
  // Takes the top FIVE per company and picks the best one that is not hidden,
  // rather than the top one full stop. Bessemer's "Full Time Analyst 2027" is
  // exactly this row — highest-scoring reachable role at the company, and the
  // wrong cycle — and leaving it as the headline on the company page while it
  // is hidden from every list of roles is the same broken-button lesson in a
  // different place.
  const flags = await roleFlags();
  const bestRows = await all(`
      SELECT company, title, key, score, comp_min, comp_max, location,
             blockers, blockers_full_text FROM (
        SELECT j.company, j.title, j.key, s.score, j.comp_min, j.comp_max, j.location,
               j.blockers, j.blockers_full_text,
               ROW_NUMBER() OVER (PARTITION BY j.company ORDER BY s.score DESC, j.key) rn
        ${JOB_FROM}
        WHERE j.closed_at IS NULL AND s.score IS NOT NULL
          AND ${REACHABLE_Q}
      ) WHERE rn <= 5
    `);
  const bestRole = new Map();
  for (const r of bestRows) {
    if (bestRole.has(r.company)) continue;
    if (isWrongCycle({ ...r, groupKey: groupKeyOf(r) }, flags)) continue;
    bestRole.set(r.company, r);
  }
  // The most recently updated application per company.
  //
  // This used to select a bare `a.stage` alongside GROUP BY j.company. SQLite
  // allows that and picks an arbitrary row; Postgres refuses outright —
  // 'column "a.stage" must appear in the GROUP BY clause'. So the SQLite version
  // was not merely non-portable, it was returning an ARBITRARY stage whenever a
  // company had two applications at different stages. Postgres turned a silent
  // wrong answer into a loud one.
  //
  // ROW_NUMBER works in both, and is the same shape already used for bestRole
  // twenty lines above.
  const stages = new Map(
    (await all(`
      SELECT company, stage, updated_at FROM (
        SELECT j.company, a.stage, a.updated_at,
               ROW_NUMBER() OVER (PARTITION BY j.company
                                  ORDER BY a.updated_at DESC, a.key) rn
        FROM jobs j JOIN applications a ON a.key = j.key
        WHERE j.closed_at IS NULL
      ) t WHERE rn = 1
    `)).map((r) => [r.company, r])
  );

  // Networking state lives HERE, on the primary surface, rather than in a
  // separate tab that would go unopened.
  const cc = await contactsByCompany();
  // The titles this company actually hires into, from its own reachable 40+
  // roles. This is what replaces networking_targets.md's "search the alumni
  // directory for" block — that block was generated per CATEGORY, so Palantir,
  // Saronic and Anduril received word-for-word identical lists. Three identical
  // sentences are a template pretending to be three insights, and rendering them
  // as a page rather than a file only makes them look more authoritative.
  const titles = new Map();
  for (const r of await all(
    `SELECT j.company, j.title, COUNT(*) AS n
     ${JOB_FROM}
     WHERE j.closed_at IS NULL AND s.score >= 40 AND ${REACHABLE_Q}
     GROUP BY j.company, j.title
     ORDER BY j.company, n DESC, j.title`
  )) {
    const list = titles.get(r.company) || [];
    if (list.length < 4) list.push(titlePrefix(r.title));
    titles.set(r.company, list);
  }

  // Every count on this row came out of a GROUP BY that cannot see a group key,
  // so each one still includes the hidden role. `best` was the loud half —
  // Bessemer read "Strong · 72" beside a bestTitle of null the moment the flag
  // went on — but reachable40, n2027 and the rest were wrong in the same way and
  // more quietly. Two numbers on one row have to come from one population; here
  // that is seven numbers and a title.
  //
  // Only runs when something is actually flagged, so the normal case costs one
  // Map lookup and no query.
  const hidden = await hiddenCounts(flags);

  const out = rows.map((r) => {
    const c = cc.get(r.name);
    const h = hidden.get(r.name);
    if (h) {
      r = { ...r };
      for (const k of ["roles", "at40", "at60", "reachable", "reachable40",
                       "n2027", "n2027All"]) {
        r[k] = Math.max(0, (r[k] || 0) - (h[k] || 0));
      }
    }
    return {
      ...r,
      // From the role the row NAMES, never from a MAX over a wider set. If the
      // best reachable role at a company is hidden, the band has to move with
      // the title or the two describe different jobs.
      best: bestRole.get(r.name)?.score ?? null,
      titles: [...new Set(titles.get(r.name) || [])],
      bestTitle: bestRole.get(r.name)?.title || null,
      bestKey: bestRole.get(r.name)?.key || null,
      // The screen-out tags for the role this row NAMES, carried alongside its
      // title and band for the same reason those are: two facts on one row must
      // describe the same job. `blockers_full_text` travels with them so the
      // renderer can tell "clear" from "not read".
      blockers: bestRole.get(r.name)?.blockers ?? null,
      blockers_full_text: bestRole.get(r.name)?.blockers_full_text ?? null,
      comp_lo: bestRole.get(r.name)?.comp_min || null,
      comp_hi: bestRole.get(r.name)?.comp_max || null,
      stage: stages.get(r.name)?.stage || null,
      contacts: c?.n || 0,
      replied: c?.replied || 0,
      // Two DIFFERENT populations, returned separately and never summed:
      // `referred` is people who actually put him forward, `referralAsked` is
      // people who were asked. The referral shield on "Mark applied" turns on
      // either being non-zero and says which one it found.
      referred: c?.referred || 0,
      referralAsked: c?.asked || 0,
      contactsDue: c?.due || 0,
      daysSinceContact: c?.daysSinceTouch ?? null,
    };
  });

  // TOTAL, via the trailing name comparison — without it this ordering was not
  // total and the page order depended on whatever order the database happened
  // to return. Every company in "Watching" has the same best score and the same
  // at40, so the first two keys tie and the rest was luck.
  //
  // SQLite and Postgres return group rows in different orders, so the migration
  // diff surfaced this as 17 identical companies in a different sequence. The
  // instability was already there: a re-fetch could have reshuffled the page.
  // Same defect compareRoles was fixed for in section 2, in the one comparator
  // that did not get the treatment.
  // TOTAL: display_name can repeat, `name` is the slug and cannot.
  const byName = (a, b) => String(a.display_name).localeCompare(String(b.display_name))
                        || String(a.name).localeCompare(String(b.name));
  const cmp = {
    best: (a, b) => b.best - a.best || b.at40 - a.at40 || byName(a, b),
    // Sorts on the number the column DISPLAYS. It used to sort on at40 while
    // showing reachable40; they disagree for 10 of the 22 companies that hire
    // this profile, so clicking the header reordered by an invisible figure.
    reachable40: (a, b) => b.reachable40 - a.reachable40 || b.best - a.best || byName(a, b),
    at40: (a, b) => b.at40 - a.at40 || b.best - a.best || byName(a, b),
    roles: (a, b) => b.roles - a.roles || b.best - a.best || byName(a, b),
    n2027: (a, b) => b.n2027 - a.n2027 || b.best - a.best || byName(a, b),
  }[sort] || ((a, b) => b.best - a.best || byName(a, b));
  // A company marked wrong-cycle leaves the page. Role-level flags do not
  // remove a company — a firm with one bad-cycle req and nine good ones is
  // still a firm that hires this profile, and the counts beside it are honest.
  return out.filter((r) => !flags.companies.has(r.name)).sort(cmp);
}

/**
 * When is each company likely to post its class-year-dated roles?
 *
 * READ THE CAVEATS. This is weak evidence today and will get strong with time:
 *
 *  - We have TWO DAYS of observation history, so `first_seen` carries no signal
 *    at all yet. Only the ATS's own posting date means anything.
 *  - Lever reports the requisition CREATION date. Palantir runs evergreen reqs,
 *    so its "Product Designer, New Grad" reports 2017-08-10. Those are excluded
 *    as artifacts, not treated as posting dates.
 *  - Greenhouse reports `updated_at`, i.e. the last edit, not the original post.
 *  - Ashby reports a genuine `publishedAt`. It is the only fully trustworthy
 *    source here, and it showed class-year-dated roles appearing from the
 *    September before the cycle.
 *
 * The daily cron is what turns this into a real forecast: once `first_seen` spans
 * a year, the question answers itself from observation instead of inference.
 */
const PROVENANCE = {
  ashby: ["published", "good"],
  rippling: ["created", "good"],
  greenhouse: ["last edited", "weak"],
  lever: ["req created", "weak"],
};

export async function forecast2027() {
  // 18 months back: anything older is an evergreen requisition, not a posting.
  const floor = new Date(Date.now() - 550 * 86400000).toISOString().slice(0, 10);
  const rows = await all(
    `SELECT j.company,
            COALESCE(MAX(j.display_name), j.company) AS display_name,
            j.source,
            COUNT(*)             AS n,
            MIN(j.posted_at)     AS earliest,
            MAX(s.score)         AS best
     FROM jobs j JOIN scores s ON s.key = j.key
     WHERE j.closed_at IS NULL AND j.start_window = ?
       AND j.posted_at IS NOT NULL AND substr(j.posted_at,1,10) >= ?
     GROUP BY j.company, j.source`,
    [PROGRAM_WINDOW, floor]
  );
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  // A GROUP BY never sees an individual role, so only the company-scope flag can
  // be applied here. That is the honest limit rather than a gap: this page
  // answers "when does this firm post", which stays true of a firm with one
  // wrong-cycle req, and stops being worth asking of a firm on the wrong cycle
  // altogether.
  const cflags = (await roleFlags()).companies;
  return rows
    .filter((r) => !cflags.has(r.company))
    .map((r) => {
      const d = new Date(r.earliest);
      const [prov, quality] = PROVENANCE[r.source] || ["unknown", "weak"];
      return {
        ...r,
        provenance: prov,
        quality,
        month: isNaN(d) ? null : MONTHS[d.getUTCMonth()],
        monthIdx: isNaN(d) ? 99 : d.getUTCMonth(),
        earliestDate: String(r.earliest).slice(0, 10),
      };
    })
    .sort((a, b) => (a.quality === b.quality ? 0 : a.quality === "good" ? -1 : 1)
                    || a.monthIdx - b.monthIdx
                    || String(a.company).localeCompare(String(b.company)));
}

/**
 * Good fit AND good pay. This is the list that was invisible while fit was the
 * only ordering: zero of the top 15 by fit overlap with the top 15 by pay, so the
 * middle — Anduril Mission Software Engineer at 72 and $166-220K, Ramp SWE at 72
 * and $189-330K — never surfaced anywhere.
 */
export async function strongOnBoth({
  minScore = 60, minPay = 140000, limit = 12, hideAboveCeiling = true,
} = {}) {
  // A DISPLAY filter, not a classification change. The pay-rule flip-backs are
  // still classified reachable and still appear in the Inbox; they are just kept
  // off this list, whose entire job is signal density. Reversible in one click.
  //
  // The ceiling now comes from CURATED_Q rather than being written out here. It
  // was written out in two places with two different comparisons — this list
  // used `< 200000` while the other Daily list applied nothing at all, which is
  // why the same three roles were hidden from one section and present in the next.
  const rows = (await all(
    `SELECT ${JOB_FIELDS} ${JOB_FROM}
     WHERE j.closed_at IS NULL AND s.score >= ?
       AND ${hideAboveCeiling ? CURATED_Q : REACHABLE_Q}
       AND j.comp_min IS NOT NULL AND j.comp_min >= ?
     ORDER BY s.score DESC, j.comp_min DESC, j.key LIMIT ?`,
    [minScore, minPay, limit * 3]
  )).map(shape);
  // visibleRoles(), NOT notHidden() DIRECTLY. This list called the predicate
  // itself, which was equivalent while there was one exclusion and stopped
  // being equivalent the moment there were two — a blocked posting would have
  // gone on appearing here alone, on the one list whose entire job is signal
  // density. That is the leak visibleRoles exists to make impossible: "one
  // helper, used everywhere; no per-view filtering", and a view that reaches
  // past the helper to a single ingredient is per-view filtering with an
  // import.
  return (await visibleRoles(rows))
    // Display rule, applied here so the list and its count cannot disagree. An
    // explicit programme role is always trusted; an inferred `entry` one has to
    // look like an individual contributor.
    .filter((r) => r.entry_level === "program" || looksLikeIC(r.title))
    .slice(0, limit);
}

/**
 * Everything Daily is allowed to show, ranked. Same predicate as strongOnBoth,
 * without the pay floor — a role with no published pay belongs here too.
 */
export async function curatedJobs({ minScore = 40, limit = 40, cap = 2, sortCtx = {} } = {}) {
  let rows = (await all(
    `SELECT ${JOB_FIELDS} ${JOB_FROM}
     WHERE j.closed_at IS NULL AND s.score >= ? AND ${CURATED_Q}
     ORDER BY s.score DESC, j.key LIMIT ?`,
    [minScore, Math.max(limit * 8, 400)]
  )).map(shape);
  rows = sortRoles(await visibleRoles(rows), sortCtx);
  if (!cap) return rows.slice(0, limit);
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const n = seen.get(r.company) || 0;
    if (n >= cap) continue;
    seen.set(r.company, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** How many reachable roles sit in each band. Counts, not a distribution chart. */
export async function bandCounts() {
  const rows = await all(
    `SELECT s.score ${JOB_FROM}
     WHERE j.closed_at IS NULL AND s.score IS NOT NULL AND ${REACHABLE_Q}`);
  const out = Object.fromEntries(BANDS.map(([n]) => [n, 0]));
  for (const r of rows) out[bandOf(r.score)]++;
  out.total = rows.length;
  out.strongPlus = out.Excellent + out.Strong;
  return out;
}

export async function payShape() {
  const r = await one(`
    SELECT
      SUM(CASE WHEN j.comp_min IS NOT NULL AND j.comp_min < 90000 THEN 1 ELSE 0 END) AS under90,
      SUM(CASE WHEN j.comp_min IS NOT NULL THEN 1 ELSE 0 END)                        AS known
    ${JOB_FROM} WHERE j.closed_at IS NULL AND s.score IS NOT NULL
      AND ${REACHABLE_Q}`);
  return r || { under90: 0, known: 0 };
}

/**
 * When the data was last refreshed. Stale data that looks live is the worst
 * outcome here, so Daily states this rather than implying freshness.
 */
export async function lastUpdated() {
  const r = await one("SELECT MAX(last_seen) t FROM jobs");
  if (!r || !r.t) return { iso: null, hoursAgo: null };
  const ms = Date.now() - Date.parse(r.t);
  return { iso: r.t, hoursAgo: Math.floor(ms / 3600000) };
}

export async function observedDays() {
  const r = await one("SELECT COUNT(DISTINCT substr(first_seen,1,10)) d FROM jobs");
  return (r && r.d) || 0;
}

export async function entryCounts() {
  // `total` is the DENOMINATOR of the three counts beside it — every open
  // scored posting — so a caller putting `total` and `reachable` on one line is
  // comparing two figures drawn from one population, which is the only way that
  // comparison is honest. It was missing, and lib/askcontext.js reads
  // counts.openRoles from it: absent, the whole "N open postings are tracked"
  // sentence was dropped from the model's context and nothing said so.
  const r = await one(`
    SELECT
      COUNT(*)                                                              AS total,
      SUM(CASE WHEN ${REACHABLE_Q} THEN 1 ELSE 0 END) AS reachable,
      SUM(CASE WHEN j.entry_level = 'experienced' THEN 1 ELSE 0 END)        AS experienced,
      SUM(CASE WHEN j.entry_level = 'program' THEN 1 ELSE 0 END)            AS program
    ${JOB_FROM} WHERE j.closed_at IS NULL AND s.score IS NOT NULL`);
  return r || { total: 0, reachable: 0, experienced: 0, program: 0 };
}

export async function facets() {
  return {
    companies: await all(
      `SELECT j.company AS slug, COALESCE(MAX(j.display_name), j.company) AS name,
              COUNT(*) AS n, MAX(s.score) AS best
       ${JOB_FROM} WHERE j.closed_at IS NULL AND s.score IS NOT NULL
       GROUP BY j.company ORDER BY best DESC, n DESC, j.company`
    ),
    categories: await all(
      `SELECT COALESCE(j.category,'unknown') AS name, COUNT(*) AS n
       ${JOB_FROM} WHERE j.closed_at IS NULL AND s.score IS NOT NULL
       GROUP BY j.category ORDER BY n DESC, j.category`
    ),
    startWindows: await all(
      `SELECT COALESCE(j.start_window,'unknown') AS name, COUNT(*) AS n
       ${JOB_FROM} WHERE j.closed_at IS NULL AND s.score IS NOT NULL
       GROUP BY j.start_window ORDER BY n DESC, j.start_window`
    ),
    stages: await all(
      `SELECT COALESCE(a.stage,'found') AS name, COUNT(*) AS n
       ${JOB_FROM} WHERE j.closed_at IS NULL AND s.score IS NOT NULL
       GROUP BY COALESCE(a.stage,'found')`
    ),
  };
}

/**
 * Roles the deterministic gate deleted, with the literal phrase that decided it.
 *
 * A gate is a regex making a delete decision, and a kill COUNT tells you how
 * much died, never what. The only way a false positive becomes visible is by
 * reading the matched phrase — so this view is phrase-first: `phrases()` groups
 * by the exact substring, and a bad pattern shows up as one phrase with a high
 * count and a meaning the gate never intended.
 *
 * Note these rows have no score and never will, so they cannot go through
 * JOB_FROM, which inner-joins scores.
 */
export async function gateKills({ gate = null, field = null, q = null, limit = 400 } = {}) {
  const where = ["j.closed_at IS NULL", "j.candidate=1", "j.triage=0"];
  const args = [];
  if (gate) { where.push("j.gate_name=?"); args.push(gate); }
  if (field) { where.push("j.gate_field=?"); args.push(field); }
  if (q) {
    // LOWER() on both sides, because SQLite's LIKE is case-INSENSITIVE for
    // ASCII and Postgres's is case-SENSITIVE. This is the dangerous kind of
    // dialect difference: no error, just a search box that quietly stops
    // matching "palantir" against "Palantir" the day it moves to Postgres.
    // ILIKE would work on Postgres alone; LOWER works on both.
    where.push(
      "(LOWER(j.title) LIKE LOWER(?) OR LOWER(j.gate_text) LIKE LOWER(?)" +
      " OR LOWER(COALESCE(j.display_name,j.company)) LIKE LOWER(?))"
    );
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  return await all(
    `SELECT j.key, COALESCE(j.display_name, j.company) AS display_name, j.title,
            j.location, j.url, j.gate_name, j.gate_text, j.gate_field, j.category
     FROM jobs j WHERE ${where.join(" AND ")}
     ORDER BY j.gate_name, LOWER(j.gate_text), display_name, j.title, j.key
     LIMIT ?`,
    [...args, limit]
  );
}

/** One row per distinct matched phrase — where a bad regex is actually visible. */
export async function gatePhrases() {
  return await all(
    `SELECT gate_name, gate_field, LOWER(gate_text) AS phrase, COUNT(*) AS n,
            MIN(title) AS example
     FROM jobs WHERE closed_at IS NULL AND candidate=1 AND triage=0
     GROUP BY gate_name, gate_field, LOWER(gate_text)
     ORDER BY gate_name, n DESC, phrase`
  );
}

export async function gateCounts() {
  return await all(
    `SELECT COALESCE(gate_name,'?') AS gate, COUNT(*) AS n
     FROM jobs WHERE closed_at IS NULL AND candidate=1 AND triage=0
     GROUP BY gate_name ORDER BY n DESC, gate_name`
  );
}

export async function funnel() {
  // One round trip instead of five. The old shape built five thunks and relied
  // on them running synchronously; against Postgres that is five sequential
  // awaits over the network, on a page that renders in one pass.
  const r = await one(`
    SELECT
      (SELECT COUNT(*) FROM jobs WHERE closed_at IS NULL)                        AS open,
      (SELECT COUNT(*) FROM jobs WHERE closed_at IS NULL AND candidate=1)        AS candidates,
      (SELECT COUNT(*) FROM jobs WHERE closed_at IS NULL AND triage=1)           AS gated,
      (SELECT COUNT(*) FROM scores s JOIN jobs j USING(key)
        WHERE j.closed_at IS NULL AND s.score IS NOT NULL)                       AS scored,
      (SELECT COUNT(*) FROM scores s JOIN jobs j USING(key)
        WHERE j.closed_at IS NULL AND s.score>=60)                               AS over60`);
  return {
    open: Number(r.open), candidates: Number(r.candidates), gated: Number(r.gated),
    scored: Number(r.scored), over60: Number(r.over60),
  };
}

/** Writes. Stage and notes only — this app never touches job or score data. */
/**
 * Set a role's posting URL. MANUAL ROWS ONLY.
 *
 * A manual entry is added before its exact posting URL is known — Truist's went
 * in as careers.truist.com so the row could exist and be scored today. Editing
 * it should not mean a commit, a redeploy and a re-run of a CLI.
 *
 * REFUSES A POLLED ROW, and that is the whole safety argument. A polled row's
 * url is written by the board on every fetch: an edit would be silently undone
 * the next morning, which is worse than not offering the control, because it
 * looks like it worked. Only source='manual' rows are stable enough to own an
 * edited URL.
 */
export async function setJobUrl(key, url) {
  const rows = await all("SELECT source FROM jobs WHERE key = ?", [key]);
  if (!rows.length) throw new Error("no such role");
  if (rows[0].source !== "manual") {
    throw new Error("only a manually added role's URL can be edited — a polled "
                  + "row's URL is rewritten by its job board on the next fetch");
  }
  const clean = String(url || "").trim();
  if (clean && !/^https?:\/\//i.test(clean)) {
    throw new Error("that is not an http(s) URL");
  }
  await run("UPDATE jobs SET url = ? WHERE key = ?", [clean, key]);
  return { key, url: clean };
}

export async function setStage(key, stage) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage: ${stage}`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  await run(
    `INSERT INTO applications (key, stage, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET stage=excluded.stage, updated_at=excluded.updated_at`,
    [key, stage, now]
  );
}

export async function addNote(key, text) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
  const prev = await one("SELECT notes FROM applications WHERE key=?", [key])?.notes || "";
  const stamped = `[${now.slice(0, 10)}] ${text}`;
  const merged = prev ? `${prev}\n${stamped}` : stamped;
  await run(
    `INSERT INTO applications (key, stage, notes, updated_at) VALUES (?,'found',?,?)
     ON CONFLICT(key) DO UPDATE SET notes=excluded.notes, updated_at=excluded.updated_at`,
    [key, merged, now]
  );
}

/* ------------------------------------------------------------------ actions
 *
 * Things the owner does, as opposed to things the pipeline found.
 *
 * Insert-only. The LATEST row for a (key, kind) wins, and a row carrying
 * meta {"undo": true} reverses it. Ordering is by `id`, never by `at`: two
 * clicks inside the same second produce identical ISO timestamps, and a
 * save/unsave pair would then settle at random.
 */

const ACTION_KINDS = ["save", "hide", "applied", "done", "target", "checked",
                      "stuck", "split", "deferred"];
const FOLLOW_UP_DAYS = 7;

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");

/**
 * THE WHOLE ACTIONS TABLE, ONCE, grouped by kind.
 *
 * activeKeys(kind) and actionDates(kind) each ran a query PER KIND, and one
 * Daily render asks for seven of them — ten near-identical round trips against
 * one small table. Memoising could not help: the argument differs every call,
 * which is React's cache working correctly rather than failing.
 *
 * So the table is read once. It is a few hundred rows; grouping them in memory
 * is strictly less work than ten queries, and against Neon each of those is a
 * network hop rather than a function call.
 *
 * LATEST ROW WINS, BY ID, which is the same rule the flags and the lifecycle
 * follow and for the same reason: two clicks inside one second write identical
 * timestamps, so ordering on `at` settles the pair at random. The SQL used to
 * do this with a MAX(id) join per kind; the JS below does it for every kind in
 * one pass and is easier to be sure of.
 */
async function _allActions() {
  const rows = await all("SELECT id, key, kind, at, meta FROM actions ORDER BY id");
  const latest = new Map();   // "kind\u0000key" -> row
  const counts = new Map();   // kind -> Map(key -> n)
  for (const r of rows) {
    let undone = false;
    try { undone = !!(r.meta && JSON.parse(r.meta).undo); } catch { undone = false; }
    latest.set(`${r.kind}\u0000${r.key}`, { ...r, undone });
    if (!undone) {
      if (!counts.has(r.kind)) counts.set(r.kind, new Map());
      const c = counts.get(r.kind);
      c.set(r.key, (c.get(r.key) || 0) + 1);
    }
  }
  const active = new Map();   // kind -> Set(key)
  const dates = new Map();    // kind -> Map(key -> at)
  for (const [k, r] of latest) {
    const kind = k.slice(0, k.indexOf("\u0000"));
    if (!active.has(kind)) { active.set(kind, new Set()); dates.set(kind, new Map()); }
    // A date is recorded for the latest row whether or not it was an undo —
    // "when did this last change" is a different question from "is it set".
    dates.get(kind).set(r.key, r.at);
    if (!r.undone) active.get(kind).add(r.key);
  }
  return { active, dates, counts };
}
const allActions = once(_allActions);

/** Keys whose most recent row of this kind is set (i.e. not undone). */
async function _activeKeys(kind) {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`unknown action: ${kind}`);
  return (await allActions()).active.get(kind) || new Set();
}

/** Every action state the UI needs, in one pass. */
async function _actionState() {
  return {
    saved: await activeKeys("save"),
    hidden: await activeKeys("hide"),
    applied: await activeKeys("applied"),
    targets: await activeKeys("target"),
    done: await activeKeys("done"),
  };
}

/** How many times a key has had an action of this kind. Undo rows do not count. */
async function _actionCounts(kind) {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`unknown action: ${kind}`);
  return (await allActions()).counts.get(kind) || new Map();
}

/** When each applied/done key was last set — for "applied 3d ago". */
async function _actionDates(kind) {
  return (await allActions()).dates.get(kind) || new Map();
}

/**
 * Record an action. `on` = true sets it, false writes the undo row.
 * Returns the new state so the client can reconcile rather than assume.
 */
export async function recordAction(key, kind, on = true, note = null) {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`unknown action: ${kind}`);
  if (!key || typeof key !== "string") throw new Error("missing key");
  const at = stamp();
  await run("INSERT INTO actions (key, kind, at, note, meta) VALUES (?,?,?,?,?)",
      [key, kind, at, note, on ? null : JSON.stringify({ undo: true })]);

  // Applied does two more things: it moves every posting in the group to the
  // applied stage, and it puts a check-back on Daily seven days out.
  //
  // NOT a contact row. contacts.csv is person-keyed, contacts.py owns writing
  // it, and this app reads it — a company-level follow-up with no name would
  // render on Daily as a person whose name is missing. An item is the honest
  // shape for "check the application status".
  if (kind === "applied" && on) {
    for (const j of await all(
      `SELECT key, title, COALESCE(display_name, company) AS display_name,
              company, location FROM jobs WHERE closed_at IS NULL`
    )) {
      if (groupKeyOf(j) === key) await setStage(j.key, "applied");
    }
    const co = key.split("|")[0];
    const label = await one(
      `SELECT COALESCE(display_name, company) AS n FROM jobs WHERE company = ? LIMIT 1`,
      [co]
    );
    const due = new Date(Date.now() + FOLLOW_UP_DAYS * 86400000)
      .toISOString().slice(0, 10);
    await addItem({
      id: `followup:${key}`,
      title: `Check application status — ${label?.n || co}`,
      note: "Applied a week ago. Chase it or let it go.",
      due_at: due,
    });
  }
  return { key, kind, on };
}

/**
 * Contacts added in the last `days` days, for the networking cadence.
 *
 * Reads the contacts TABLE. Note that the app's contact DISPLAY still reads
 * contacts.csv through lib/contacts.js, and that file is gitignored — it holds
 * other people's details on purpose — so it cannot exist on Vercel and the
 * displayed count is permanently zero there. contacts.py writes the CSV, not
 * this table. That loop is still open; it is a phase-D leftover, not something
 * this function should paper over by reading a file it knows is absent.
 */
export async function contactsAddedSince(days = 7) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  try {
    // created_at, NOT first_touch. first_touch is when the first message went
    // out; the cadence counts names ADDED. Reading first_touch made this
    // permanently zero — a name entered today has not been written to yet — so
    // the networking tier would have fired forever while appearing to measure
    // something. Same always-empty shape as reading contacts.csv on Vercel.
    const r = await one(
      "SELECT COUNT(*) AS n FROM contacts WHERE created_at >= ?", [cutoff]);
    return Number(r?.n || 0);
  } catch {
    // No contacts table yet. Zero added is the honest answer either way.
    return 0;
  }
}

/* ---------------------------------------------------------------- lifecycle
 *
 * What happened after "worth a look". Insert-only, keyed by the role's GROUP
 * key — see migrations/003_lifecycle.sql for why both of those, and why
 * applications.stage is kept in step rather than replaced.
 */

/**
 * Lifecycle status -> the nearest value in `applications.stage`.
 *
 * PARTIAL ON PURPOSE. `oa`, `final` and `ghosted` have no honest equivalent in
 * the older vocabulary, and giving them an approximate one would put a wrong
 * value on the Companies page — which reads that column — rather than leaving
 * it showing the last thing that was actually true. A missing key means "do not
 * touch it", not "clear it".
 */
const LIFECYCLE_TO_STAGE = {
  applied: "applied",
  phone_screen: "phone_screen",
  interview: "interviewing",
  offer: "offer",
  rejected: "rejected",
};

/**
 * Record a lifecycle move.
 *
 * `referral` is asked once, when marking applied, and is allowed to be null.
 * An unanswered question stores NULL rather than a guessed false: the entire
 * point of the column is to test the referral thesis against the owner's own
 * results, and a fabricated "no" would poison the only evidence that will ever
 * exist about it.
 */
export async function recordRoleEvent(groupKey, status, { referral = null, note = null } = {}) {
  if (!LIFECYCLE_KEYS.includes(status)) throw new Error(`unknown status: ${status}`);
  if (!groupKey || typeof groupKey !== "string") throw new Error("missing key");
  const at = stamp();
  await run(
    `INSERT INTO role_events (id, group_key, status, referral, note, at)
     VALUES (?,?,?,?,?,?)`,
    [`ev:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
     groupKey, status, referral === null ? null : (referral ? 1 : 0), note, at]);

  // Keep the older per-posting column in step for the statuses that have an
  // equivalent, so the Companies page does not go stale. Same loop shape
  // recordAction uses for `applied`.
  const mapped = LIFECYCLE_TO_STAGE[status];
  if (mapped) {
    for (const j of await all(
      `SELECT key, title, COALESCE(display_name, company) AS display_name,
              company, location FROM jobs WHERE closed_at IS NULL`
    )) {
      if (groupKeyOf(j) === groupKey) await setStage(j.key, mapped);
    }
  }
  return { groupKey, status, at };
}

/**
 * Every role's current lifecycle status, as a Map keyed by group key.
 *
 * Returns an EMPTY MAP when the table is absent rather than throwing, so a
 * database that has not had 003 applied renders the app without the In flight
 * section instead of a 500. The People page takes the opposite approach and
 * says out loud that its tables are missing — the difference is that People IS
 * the feature, and this is a section on somebody else's page.
 */
async function _roleLifecycle() {
  let rows;
  try {
    rows = await all("SELECT id, group_key, status, referral, note, at FROM role_events");
  } catch {
    return new Map();
  }
  const by = new Map();
  for (const r of rows) {
    const list = by.get(r.group_key) || [];
    list.push(r);
    by.set(r.group_key, list);
  }
  const out = new Map();
  for (const [k, events] of by) out.set(k, currentStatus(events));
  return out;
}

/**
 * Group key -> the words to put on screen for that role.
 *
 * "In flight" is keyed by group key and has to render a company and a title,
 * and the group key is `slug|lowercased normalised title` — which would render
 * as "palantir|deployment strategist - us government".
 *
 * Roles whose posting has since CLOSED are the interesting case and the reason
 * the caller needs a fallback rather than a filter: you applied, the
 * requisition came down, and the application is still very much in flight. A
 * lookup that quietly dropped those would hide exactly the applications most
 * likely to have gone quiet.
 */
export async function roleLabels() {
  const out = new Map();
  for (const r of await all(
    `SELECT company, COALESCE(display_name, company) AS display_name, title, location
     FROM jobs WHERE closed_at IS NULL`
  )) {
    const k = groupKeyOf(r);
    if (!out.has(k)) {
      out.set(k, {
        company: r.company,
        display_name: r.display_name,
        title: normalizeTitle(r.title, r.location),
      });
    }
  }
  return out;
}

/**
 * THE exclusion. Every list of roles in this app ends with this call.
 *
 * The brief's instruction was "one helper, used everywhere; no per-view
 * filtering", and the second half is the important one. A role hidden on Daily
 * and still sitting on Inbox is worse than one that was never hidden, because
 * the first teaches him the button does not work — and then he stops pressing
 * any of them. Same failure as the nag he could not answer.
 *
 * Takes the folded flags optionally, so a caller making several lists in one
 * request reads the table once.
 */
export async function visibleRoles(rows, flags = null, blocked = null) {
  const f = flags || (await roleFlags());
  const b = blocked || (await blockedApplies());
  // TWO PREDICATES, ONE PER POSTING, AND THE SECOND ONE IS SUBTLER.
  //
  // isWrongCycle reads the GROUP key, so hiding a role hides every city it is
  // posted in — which is right, because that is one role and the owner judged it.
  //
  // isBlocked reads the REQUISITION key, and the group behaviour falls out of
  // where this filter sits rather than out of any logic here: `rows` is one row
  // per posting, groupRoles() runs downstream, so a blocked posting is removed
  // and its group survives on whatever siblings are left. A group disappears
  // exactly when every posting under it is blocked, which is the rule stated
  // without anything having to count.
  //
  // That is the whole reason this is a posting-level table. Palantir lists
  // Deployment Strategist in a dozen cities; the hCaptcha loops on the Chicago
  // requisition, and blocking the group would have deleted eleven good postings
  // — including the New York one — to record one broken form.
  //
  // Both are injectable so a test can drive this with no database at all. The
  // predicate that matters is the one nothing could reach: the blocked filter
  // was added here, and a test that can only call the DB-backed path proves
  // nothing about it on a machine where the table does not exist.
  return rows.filter((r) => !isWrongCycle(r, f) && !isBlocked(r, b));
}

/**
 * Per company, how many rows each Companies count has to give back.
 *
 * Costs nothing when nothing is flagged, which is the normal state — the query
 * does not run at all.
 */
async function hiddenCounts(flags) {
  if (!flags.roles.size && !flags.companies.size) return new Map();
  const rows = await all(
    `SELECT j.company, j.title, j.location, s.score, j.entry_level,
            j.class_fit, j.clearance_status, j.start_window
     ${JOB_FROM}
     WHERE j.closed_at IS NULL AND s.score IS NOT NULL`
  );
  const out = new Map();
  for (const r of rows) {
    if (!isWrongCycle({ ...r, groupKey: groupKeyOf(r) }, flags)) continue;
    const c = out.get(r.company)
      || { roles: 0, at40: 0, at60: 0, reachable: 0, reachable40: 0, n2027: 0, n2027All: 0 };
    // The same three conditions as REACHABLE_Q, in the same order, because a
    // count that gives back a different number from the one it took is worse
    // than no adjustment at all.
    const reachable = ["program", "entry"].includes(r.entry_level)
      && (r.class_fit || "ok") !== "wrong_year"
      && (r.clearance_status || "none_mentioned") !== "required_active";
    const isProgramYear = r.start_window === PROGRAM_WINDOW;
    c.roles += 1;
    if (r.score >= 40) c.at40 += 1;
    if (r.score >= 60) c.at60 += 1;
    if (reachable) c.reachable += 1;
    if (reachable && r.score >= 40) c.reachable40 += 1;
    if (isProgramYear) c.n2027All += 1;
    if (isProgramYear && reachable && r.score >= 40) c.n2027 += 1;
    out.set(r.company, c);
  }
  return out;
}

/**
 * What is hidden, for the undo list at the foot of Inbox.
 *
 * ONE ROW PER FLAG, not one per role. A company flag on Anduril hides more than
 * a hundred postings, and listing them all would have buried the four role-level
 * decisions under a hundred identical lines reading "hidden with the whole
 * company" — with the cap then truncating the list, so the entry you wanted to
 * undo might not be in it at all. The flag is the thing he set and the flag is
 * the thing he undoes.
 *
 * A company row names the company and says how many roles went with it, because
 * "un-hide Anduril" and "un-hide 104 roles" are the same action and he should
 * know which one he is taking.
 */
export async function hiddenRoles({ limit = 50 } = {}) {
  const flags = await roleFlags();
  if (!flags.roles.size && !flags.companies.size) return [];

  const rows = (await all(
    `SELECT ${JOB_FIELDS} ${JOB_FROM}
     WHERE j.closed_at IS NULL AND s.score IS NOT NULL
     ORDER BY s.score DESC, j.key`
  )).map(shape);

  const out = [];

  // Companies first: they are the bigger claim, and there are few of them.
  for (const [company, note] of flags.companies) {
    const mine = rows.filter((r) => r.company === company);
    out.push({
      scope: "company",
      key: company,
      company,
      display_name: mine[0]?.display_name || company,
      // A count, not a title. There is no single role this row is about.
      title: `${new Set(mine.map((r) => r.groupKey)).size} roles`,
      score: mine[0]?.score ?? null,
      note,
    });
  }

  // Then role flags — skipping any whose company is already hidden, because
  // undoing the role would change nothing on screen and a button that does
  // nothing is the failure this list exists to prevent.
  for (const [groupKey, note] of flags.roles) {
    const r = rows.find((x) => x.groupKey === groupKey);
    if (r && flags.companies.has(r.company)) continue;
    out.push({
      scope: "role",
      key: groupKey,
      groupKey,
      company: r?.company || groupKey.split("|")[0],
      display_name: r?.display_name || groupKey.split("|")[0],
      title: r?.title || groupKey.split("|").slice(1).join("|"),
      score: r?.score ?? null,
      note,
    });
  }

  // TOTAL: display_name repeats across companies, key cannot.
  return out
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name))
                 || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit);
}

/* -------------------------------------------------------------- role flags
 *
 * A role or a company marked as the wrong graduating cycle. Insert-only, like
 * `actions`, and folded into a current answer by foldFlags().
 */

/** Every flag row, for the one shared exclusion helper. */
async function _roleFlags() {
  try {
    return foldFlags(await all(
      "SELECT id, scope, key, flag, on_, note, at FROM role_flags"));
  } catch {
    // No table yet. Nothing hidden is the honest answer either way, and a
    // missing flag table must never blank a list.
    return { roles: new Map(), companies: new Map() };
  }
}

/**
 * Hide or un-hide, by role group key or by company slug.
 *
 * Un-hiding writes a row saying so rather than deleting: the reasons he hides
 * things are the only record this system will ever hold of his own judgement
 * about a role, and "hid it, then changed his mind" is part of that.
 */
export async function setRoleFlag(scope, key, on = true, note = null,
                                  flag = FLAG_WRONG_CYCLE) {
  if (!["role", "company"].includes(scope)) throw new Error("scope must be role or company");
  if (!key || typeof key !== "string") throw new Error("missing key");
  // The id is RETURNED, so a caller that needs to undo exactly this write can
  // name it. test_flags used to clean up by timestamp instead and silently
  // missed every row written in its own first second: `stamp()` produces
  // "...T09:00:27+00:00" and `new Date().toISOString()` produces
  // "...T09:00:27.000Z", and as strings "+" sorts before ".". A real flag row
  // survived a cleanup that reported success.
  const id = `fl:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await run(
    `INSERT INTO role_flags (id, scope, key, flag, on_, note, at)
     VALUES (?,?,?,?,?,?,?)`,
    [id, scope, key, flag, on ? 1 : 0, note || null, stamp()]);
  return { id, scope, key, flag, on };
}

/* ---------------------------------------------------------- blocked applies
 *
 * An apply flow that cannot be completed — an hCaptcha that loops, a site
 * answering 406 — against one posting or one application window. Insert-only
 * like `role_flags`, folded by foldBlocked(). See migrations/023 for why it is
 * neither a column on `jobs` nor a second flag value on `role_flags`.
 */

/** Every blocked row, folded. */
async function _blockedApplies() {
  try {
    return foldBlocked(await all(
      "SELECT id, scope, key, reason, note, label, url, on_, at FROM blocked_applies"));
  } catch {
    // NO TABLE YET. Nothing blocked is the honest answer either way, and it is
    // also the SAFE one in this direction: a missing table makes the app show
    // one role too many, where the opposite default would blank every list in
    // the tool the first time a migration had not run yet. Same reasoning as
    // _roleFlags(), and the same shape so the two cannot drift.
    return NO_BLOCKS;
  }
}

/**
 * Record that an apply flow is blocked, or lift it.
 *
 * LIFTING WRITES A ROW SAYING SO rather than deleting. Deleting would leave the
 * table saying an apply flow had never been broken, and how long a company's
 * form stayed broken is the only evidence this system will ever hold about
 * whether that company is worth the evening.
 *
 * `label` and `url` are snapshotted by the CALLER, from whatever it knows at
 * the time — the job row, the window, the bot's log. Nothing here joins to
 * `jobs`, which is what lets the row outlive a requisition Lever has re-ided.
 */
export async function setBlocked(scope, key, {
  reason = null, note = null, label = null, url = null, on = true,
} = {}) {
  if (!["role", "window"].includes(scope)) throw new Error("scope must be role or window");
  if (!key || typeof key !== "string") throw new Error("missing key");
  // Millisecond-prefixed and base-36, so ids sort the way the clock ran — which
  // is what makes foldBlocked's "latest by id" mean "latest". Same shape as the
  // flag ids, for the same reason.
  const id = `bk:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await run(
    `INSERT INTO blocked_applies (id, scope, key, reason, note, label, url, on_, at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, scope, key, reason, note, label, url, on ? 1 : 0, stamp()]);
  return { id, scope, key, reason, on };
}

/* ------------------------------------------------------------------ windows */

/**
 * When each tracked application window was last checked, and any date found.
 *
 * companies.yaml holds `verified:`, edited by hand. That was fine while a human
 * ran `verify_deadlines.py`, and useless from inside a deployed app: Vercel's
 * filesystem is read-only, so "I checked it, still no date" had nowhere to go.
 * A ladder that names the same firm every morning with no way to answer it is a
 * nag, and a nag you cannot answer teaches you to skip the page.
 *
 * So a check is an `actions` row, keyed `window:<firm>|<program>`. The yaml stays
 * the seed; the database records what has happened since. `meta.closes` carries
 * a date when the owner found one — which is how the 16 undated windows get dated,
 * one ten-minute check at a time.
 */
async function _windowChecks() {
  const rows = await all(
    `SELECT a.key, a.at, a.meta FROM actions a
     JOIN (SELECT key, MAX(id) mx FROM actions WHERE kind = 'checked' GROUP BY key) t
       ON t.key = a.key AND t.mx = a.id`
  );
  const out = new Map();
  for (const r of rows) {
    let meta = {};
    try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { meta = {}; }
    if (meta.undo) continue;
    out.set(r.key, { at: r.at, closes: meta.closes || null });
  }
  return out;
}

/**
 * Record that a window was checked, optionally with the close date found.
 *
 * A date entered here is `verified` in the sense companies.yaml means it — read
 * from the firm's own site by a human. That is deliberate and it is the only
 * route by which a window in this system can ever become verified; 1 of 25 is
 * today.
 */
export async function recordWindowCheck(key, closes = null) {
  if (!key || typeof key !== "string") throw new Error("missing key");
  if (closes && !/^\d{4}-\d{2}-\d{2}$/.test(closes)) {
    throw new Error("close date must be YYYY-MM-DD");
  }
  await run("INSERT INTO actions (key, kind, at, note, meta) VALUES (?,'checked',?,?,?)",
    [key, stamp(), closes ? `found close date ${closes}` : "checked — still no date",
     JSON.stringify(closes ? { closes } : {})]);
  return { key, closes: closes || null };
}

/* -------------------------------------------------------------------- items */

export async function listItems({ includeDone = true } = {}) {
  const [done, at, stuck, stuckAt, split, deferrals] = await Promise.all([
    activeKeys("done"), actionDates("done"),
    activeKeys("stuck"), actionDates("stuck"), activeKeys("split"),
    actionCounts("deferred"),
  ]);
  const days = (iso) =>
    iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null;

  const rows = (await all(
    `SELECT id, title, note, due_at, created_at, source, minutes, steps,
            parent_id, unit_company, unit_kind, surfaced_on, deadline_kind
     FROM items`
  )).map((r) => {
    let steps = [];
    try { steps = r.steps ? JSON.parse(r.steps) : []; } catch { steps = []; }
    // CALENDAR DAYS, from day.js, the same helper the window countdown uses.
    // Two countdowns on one page computed two different ways is the shape this
    // project has hit four times; here they sit literally next to each other on
    // Daily, and an item due the same afternoon as a window closes has to agree
    // with it about what day that is.
    const dueIn = daysUntil(r.due_at);
    return {
      ...r,
      done: done.has(r.id),
      doneAt: at.get(r.id) || null,
      // The ladder does arithmetic on this — it compares against the time
      // available — so it arrives as a number or as null, never as a string.
      minutes: r.minutes == null ? null : Number(r.minutes),
      steps: Array.isArray(steps) ? steps : [],
      dueIn,
      // COUNT UP, not only down. A countdown implies progress; for something
      // that has sat untouched for twelve days, age is the honest number and the
      // one that says what is actually going on.
      ageDays: days(r.created_at),
      // NULL reads as self. The column was added without a default on purpose:
      // a DEFAULT 'self' would have labelled every window-derived task
      // self-imposed, which is the exact distinction it exists to draw.
      deadline_kind: r.deadline_kind || "self",
      stuck: stuck.has(r.id),
      stuckDays: days(stuckAt.get(r.id) || null),
      split: split.has(r.id),
      // Three deferrals is an answer. Same shape as the two-follow-ups rule:
      // pushing a thing away repeatedly is a decision, and a tool that keeps
      // asking anyway has stopped listening.
      deferrals: deferrals.get(r.id) || 0,
    };
  });
  // An item that has been broken into steps is not work any more — its steps
  // are. It stays in the table, and stays visible under "split", because
  // nothing here deletes.
  const out = (includeDone ? rows : rows.filter((r) => !r.done))
    .filter((r) => !r.split);
  return out.sort((a, b) => (a.dueIn ?? 9999) - (b.dueIn ?? 9999)
                         || String(a.created_at || "").localeCompare(String(b.created_at || ""))
                         || a.title.localeCompare(b.title)
                         || String(a.id).localeCompare(String(b.id)));
}

/**
 * Break an item into its PRE-AUTHORED steps.
 *
 * Writes the children first and marks the parent split only once they exist, so
 * a failure halfway leaves the original item intact rather than losing the work
 * and the record of it. Nothing is deleted at any point.
 *
 * Returns the number of children created; 0 means the item had no steps, which
 * is a legitimate answer — "stuck" is still recorded, it just cannot be split.
 */
export async function splitItem(id) {
  const item = (await listItems()).find((i) => i.id === id);
  if (!item) throw new Error("no such item");
  if (!item.steps.length) return 0;

  let n = 0;
  for (const [i, step] of item.steps.entries()) {
    const text = typeof step === "string" ? step : step?.text;
    if (!text) continue;
    const mins = typeof step === "object" && step?.minutes != null
      ? Number(step.minutes)
      : null;
    await run(
      `INSERT INTO items (id, title, note, due_at, created_at, source, minutes, steps)
       VALUES (?,?,?,?,?,'split',?,NULL) ON CONFLICT (id) DO NOTHING`,
      [`split:${id}:${i + 1}`, text, `Step ${i + 1} of ${item.steps.length} — ${item.title}`,
       item.due_at, stamp(), mins]
    );
    n += 1;
  }
  if (n) await recordAction(id, "split", true, `split into ${n} steps`);
  return n;
}

/**
 * Re-adding an existing id never clobbers it and never resurrects a done item.
 *
 * `INSERT OR IGNORE` is SQLite-only and Postgres rejects it outright — the
 * "Add an item" box returned "could not add that" and nothing else. No test
 * caught it: the snapshot compares rendered pages, and this is a write. Only
 * clicking the button found it.
 *
 * `ON CONFLICT DO NOTHING` is the portable spelling and works in both.
 */
export async function addItem({ id = null, title, note = null, due_at = null }) {
  const t = (title || "").trim();
  if (!t) throw new Error("an item needs a title");
  const key = id || `item:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await run(
    `INSERT INTO items (id, title, note, due_at, created_at, source)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT (id) DO NOTHING`,
    [key, t, note, due_at, stamp(), id ? "auto" : "user"]
  );
  return key;
}

/**
 * Write today's date onto the children the scheduler chose.
 *
 * The scheduler is pure and returns a PLAN; this is the only thing that acts on
 * it. Idempotent by construction: planToday() returns an empty `surface` once
 * the day's items already carry today's date, so a second page load writes
 * nothing rather than relying on this to be careful.
 */
export async function surfaceItems(ids = [], day) {
  for (const id of ids) {
    await run("UPDATE items SET surfaced_on = ? WHERE id = ?", [day, id]);
  }
  return ids.length;
}

export async function setItemDue(id, dueAt) {
  if (dueAt && !/^\d{4}-\d{2}-\d{2}$/.test(dueAt)) throw new Error("due date must be YYYY-MM-DD");
  await run("UPDATE items SET due_at = ? WHERE id = ?", [dueAt || null, id]);
}

/* ------------------------------------------------------------------- visits */

/** The PREVIOUS visit, read before recording this one. */
export async function lastVisit() {
  const r = await one("SELECT at FROM visits ORDER BY id DESC LIMIT 1");
  return r?.at || null;
}

export async function recordVisit() {
  await run("INSERT INTO visits (at) VALUES (?)", [stamp()]);
}

/* ------------------------------------------------- hours today, run status */

/** Today's answer, or null. Unanswered is a real state and the common one. */
export async function hoursToday(day) {
  try {
    const r = await one("SELECT hours FROM daily_availability WHERE day = ?", [day]);
    return r ? Number(r.hours) : null;
  } catch {
    return null;
  }
}

/** Answering twice replaces: "actually I have four now" is a correction. */
export async function setHoursToday(day, hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > 24) throw new Error("hours must be 1-24");
  await run("DELETE FROM daily_availability WHERE day = ?", [day]);
  await run("INSERT INTO daily_availability (day, hours, at) VALUES (?,?,?)",
            [day, h, stamp()]);
  return { day, hours: h };
}

/** Clear today's answer, so the question can be asked again. */
export async function clearHoursToday(day) {
  await run("DELETE FROM daily_availability WHERE day = ?", [day]);
  return { day, hours: null };
}

/**
 * Did this morning's run work?
 *
 * The freshness stamp reads the newest job row, which answers "is the data
 * fresh" and cannot answer "did the run fail" — a failed run leaves yesterday's
 * data looking exactly like a run with nothing new to fetch. Written by the
 * workflow at the end of its own run.
 */
export async function pipelineStatus() {
  try {
    return await one(
      "SELECT status, run_url, finished_at, note FROM pipeline_status WHERE id = ?",
      ["last"]);
  } catch {
    return null;
  }
}

/* ------------------------------------------------ once per request
 *
 * the actions table was queried eight times in one Daily render.
 *
 * Same question, same answer, one query. See lib/once.js: React's cache
 * is scoped to a single render and is a NO-OP outside one, so the CLI
 * scripts that import this module are unaffected and can never serve a
 * stale row from a cache they cannot see.
 */
export const activeKeys = once(_activeKeys);
export const actionState = once(_actionState);
export const actionCounts = once(_actionCounts);
export const actionDates = once(_actionDates);
export const roleLifecycle = once(_roleLifecycle);
export const roleFlags = once(_roleFlags);
export const blockedApplies = once(_blockedApplies);
export const windowChecks = once(_windowChecks);

/**
 * Every application pack, newest first, with the role it belongs to.
 *
 * ONE QUERY, JOINED, because a pack is meaningless without the role: the page
 * shows the title, the blockers and the apply link beside the drafted text, and
 * fetching those separately would be two sources for one row.
 *
 * `used_at` COMES BACK RAW so the caller can tell an OPENED pack from an
 * untouched one. "141 packs generated" is a vanity number if it cannot say how
 * many were ever read, and that distinction is the whole reason the column
 * exists.
 */
export async function listApplyPacks({ limit = 200 } = {}) {
  return all(`
    SELECT p.key, p.variant, p.variant_reason, p.cover_note,
           p.why_company, p.why_role, p.project_story, p.biggest_challenge,
           p.model, p.created_at, p.used_at, p.raw,
           j.title, j.location, j.url,
           COALESCE(j.display_name, j.company) AS display_name,
           j.company, j.blockers, j.blockers_full_text, s.score
      FROM apply_packs p
      JOIN jobs j ON j.key = p.key
      LEFT JOIN scores s ON s.key = p.key
     WHERE j.closed_at IS NULL
     -- Highest fit first, then the key: a comparator that can return 0 for two
     -- distinct rows reshuffles the page on every load, which has happened
     -- three separate times in this project.
     ORDER BY s.score DESC NULLS LAST, p.key
     LIMIT ?`, [limit]);
}

/**
 * Record that the owner copied something out of a pack.
 *
 * FIRST TOUCH ONLY. `used_at` answers "has he ever worked from this", so a
 * second copy must not move it -- otherwise the column drifts into meaning
 * "last touched", which is a different question nobody asked.
 */
export async function markPackUsed(key, at = new Date().toISOString()) {
  return run("UPDATE apply_packs SET used_at = ? WHERE key = ? AND used_at IS NULL",
             [at, key]);
}
