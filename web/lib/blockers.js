/**
 * How a role's screen-out tags render. Pure — no database, no network, no `node:`.
 *
 * THE CLASSIFIER IS NOT HERE AND MUST NOT BE. blockers.py stamps the tags at
 * ingest and the value is read from the row; this file only decides how to show
 * what is already stored. Two implementations of "what counts as a blocker"
 * is how schema.sql drifted twenty columns behind reality — and here it would
 * be worse, because the two would disagree per-role with no error anywhere.
 *
 * IT GATES NOTHING. No caller filters, sorts or scores on these. They are read
 * by a person, next to the role, before they get attached to a title.
 */

/** Tags that actually screen the owner out. Order is the order they render in. */
export const HARD = ["cs_degree", "years_4plus", "clearance"];

/**
 * Tags that are NOT blockers for the owner, and render green.
 *
 * The profile this was built for is a US citizen needing no sponsorship, who
 * holds no clearance, knows of no disqualifying factors, and is willing to
 * undergo the process (profile.json `citizenship` and `clearance`). So a
 * posting demanding citizenship, or one offering to sponsor a clearance, is a
 * role they can take — and saying so out loud is better than leaving a defense
 * row with an unexplained clearance mention that reads as a wall.
 *
 * THE LABELS BELOW MAY NEVER IMPLY AN ADJUDICATED RESULT. Not "cleared", not
 * "clearance-eligible" as though someone had decided it. Clearance eligibility
 * is determined by a government adjudicator, and asserting it is a false claim
 * on a defense application — the highest-stakes place in this pipeline to get
 * wrong. See the clearance phrasing rules in CLAUDE.md.
 */
export const SOFT = ["clearance_obtainable", "citizenship_only"];

export const LABEL = {
  cs_degree: "CS/eng degree",
  years_4plus: "4+ yrs",
  clearance: "Clearance held",
  clearance_obtainable: "Clearance obtainable",
  citizenship_only: "US citizens",
};

// NO FACT ABOUT THE OWNER IN HERE. These explain what the POSTING says; what
// the owner holds is in profile.json and is not restated as a literal that a
// copy for someone else would carry forward.
export const EXPLAIN = {
  cs_degree:
    "The posting requires a degree in computer science, engineering or a "
    + "scientific field.",
  years_4plus:
    "The posting states four or more years of experience as the bar, in a "
    + "bullet that is not marked preferred.",
  clearance:
    "The posting requires a clearance already held.",
  clearance_obtainable:
    "The clearance can be obtained or sponsored — not a blocker for someone "
    + "with no known disqualifying factors who is willing to undergo the "
    + "process.",
  citizenship_only:
    "US citizens only — not a blocker for a US citizen.",
};

/** Parse whatever the row is carrying into a tag array. */
export function tagsOf(row) {
  const raw = row?.blockers;
  if (!raw) return null;                      // NULL = never classified
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    // A row carrying unparseable JSON is NOT a clean row. Returning [] here
    // would render it as "no blockers", which is the one answer it cannot
    // support — same reason an unparseable triage verdict passes through as
    // plausible rather than being dropped.
    return null;
  }
}

/** Only the tags that screen the owner out. */
export function hardTags(tags) {
  return (tags || []).filter((t) => HARD.includes(t));
}

/**
 * The row's verdict: "clear" | "blocked" | "unknown".
 *
 * "unknown" IS THE IMPORTANT ONE AND IT IS THE COMMON CASE. storage_policy
 * truncates every non-candidate description at 2,000 characters and 9,691 of
 * 9,708 sit exactly on that limit, with the requirements section past the cut.
 * A row with no tags and truncated text has not been cleared, it has not been
 * READ — and rendering that as clear is the always-empty-source failure this
 * project keeps hitting. Anything that has never been classified at all is
 * unknown too.
 */
export function verdictOf(row) {
  const tags = tagsOf(row);
  if (tags === null) return "unknown";
  if (hardTags(tags).length) return "blocked";
  // blockers_full_text: 1 complete, 0 truncated. Anything else is not a yes.
  const complete = row?.blockers_full_text === 1
    || row?.blockers_full_text === true;
  return complete ? "clear" : "unknown";
}

/** The chips for one row, worst first, each with the colour it renders in. */
export function chipsOf(row) {
  const tags = tagsOf(row);
  if (!tags || !tags.length) return [];
  const order = [...HARD, ...SOFT];
  return tags
    .filter((t) => order.includes(t))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((t) => ({
      tag: t,
      label: LABEL[t] || t,
      explain: EXPLAIN[t] || "",
      hard: HARD.includes(t),
    }));
}

/**
 * The truncation line for the digest's pipeline health.
 *
 * THE OWNER ASKED FOR THIS EVERY DAY UNTIL IT IS FIXED, and it is the honest half of
 * the feature: the tags are only as good as the text they were computed from,
 * and 84% of open roles were cut at 2,000 characters before anyone read them.
 * A blocker feature that quietly worked on a sixth of the corpus while
 * reporting nothing would be exactly the silent failure it was built to catch.
 *
 * @param counts { total, unknown } over OPEN roles.
 */
export function truncationLine(counts) {
  // NOT a destructuring default. `= {}` applies only to `undefined`, and an
  // explicit `null` sails straight past it and throws — which is exactly how
  // this was first written, and the caller passes null when it could not read
  // the count. Same family as `Number(null) === 0` in lib/num.js.
  const total = Number(counts?.total || 0);
  const unknown = Number(counts?.unknown || 0);
  if (!counts || !total) {
    return "**Blockers: no roles counted.** Either the backfill has not run or "
      + "the read failed. This is missing data, not a clean result.";
  }
  if (!unknown) return null;                  // nothing to say is not a section
  const pct = Math.round((100 * unknown) / total);
  return `**${unknown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} `
    + `open roles (${pct}%) have UNKNOWN blockers** — their description was `
    + `truncated at 2,000 characters before the requirements section, so `
    + `"no blocker" on those rows means "not read", not "clear".`;
}
