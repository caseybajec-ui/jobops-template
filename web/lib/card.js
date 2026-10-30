/**
 * The profile card: the fields every application form asks for, in one place.
 *
 * Pure — no database, no `node:` — so the field list, the copy-all formatting
 * and the read-only rule are all testable without a browser.
 *
 * WHY. A Workday form asks for the same legal name, address, phone, GPA and
 * graduation date every single time, and the owner retypes them from memory. That
 * is where a 3.91 becomes a 3.19 and a postcode loses a digit — errors nobody
 * notices until the application has already gone.
 */
import { PERMITTED_STATEMENT, forbiddenClaim } from "./clearance.js";

/**
 * [key, label, group, options]
 *
 * `readOnly` is not styling. The clearance line may not be edited from the app,
 * because eligibility is an adjudicator's determination and a free-text box on
 * a form is precisely where "willing to undergo the process" quietly becomes
 * "eligible" — under time pressure, in a field nobody re-reads. The rule is in
 * lib/clearance.js and validated on write by the API route.
 */
export const FIELDS = [
  ["legal_name", "Legal name", "you"],
  ["preferred_name", "Preferred name", "you"],
  ["email", "Email", "you"],
  ["phone", "Phone", "you"],

  ["street", "Street", "address"],
  ["city", "City", "address"],
  ["state", "State", "address"],
  ["postal", "Postal code", "address"],
  ["country", "Country", "address"],

  ["linkedin_url", "LinkedIn", "links"],
  // The column keeps its original name (migrations/008_profile.sql); only the
  // label is generic. A product, portfolio or personal site -- whatever the
  // owner points a form's "website" box at.
  ["briefd_url", "Portfolio / product site", "links"],

  ["gpa", "GPA", "school"],
  ["expected_graduation", "Expected graduation", "school"],

  ["work_authorization", "Work authorization", "eligibility"],
  ["clearance_line", "Clearance", "eligibility", { readOnly: true }],

  // TWO SETS, one per resume variant. The unsuffixed columns are the TECH set
  // and predate the split, so nothing the owner already typed had to move.
  // completeness() excludes every bullet_ prefix, so the finance three being
  // blank does not read as an incomplete profile — an empty bullet is an honest
  // blank, and that was true before there were six of them.
  ["bullet_1", "Bullet 1", "bullets", { multiline: true, variant: "tech" }],
  ["bullet_2", "Bullet 2", "bullets", { multiline: true, variant: "tech" }],
  ["bullet_3", "Bullet 3", "bullets", { multiline: true, variant: "tech" }],
  ["bullet_1_finance", "Bullet 1", "bullets", { multiline: true, variant: "finance" }],
  ["bullet_2_finance", "Bullet 2", "bullets", { multiline: true, variant: "finance" }],
  ["bullet_3_finance", "Bullet 3", "bullets", { multiline: true, variant: "finance" }],
];

/** The three bullet keys for a variant, in order. */
export function bulletKeys(variant) {
  return FIELDS.filter(([, , g, o]) => g === "bullets" && o?.variant === variant)
               .map(([k]) => k);
}

export const GROUPS = [
  ["you", "You"],
  ["address", "Address"],
  ["links", "Links"],
  ["school", "School"],
  ["eligibility", "Eligibility"],
  ["bullets", "Three bullets"],
];

export const FIELD_KEYS = FIELDS.map(([k]) => k);
export const FIELD_LABEL = Object.fromEntries(FIELDS.map(([k, l]) => [k, l]));
export const READ_ONLY = new Set(
  FIELDS.filter(([, , , o]) => o && o.readOnly).map(([k]) => k));

/**
 * What a brand-new profile holds.
 *
 * Only the three things that are facts rather than data entry: the citizenship
 * position, the clearance sentence, and the country. Everything else is blank,
 * INCLUDING the bullets — CLAUDE.md rule 4 is absolute, and seeding invented
 * resume text on the one surface designed for pasting into real forms is the
 * worst possible place to break it.
 */
export const DEFAULTS = {
  id: "me",
  country: "United States",
  work_authorization: "US citizen, no sponsorship required",
  clearance_line: PERMITTED_STATEMENT,
};

/** Is this profile usable yet, and what is missing? Never a score. */
export function completeness(profile = {}) {
  // The bullets are optional by design — a blank bullet is an honest blank, and
  // counting it as incomplete would nag toward filling it with something.
  const required = FIELD_KEYS.filter((k) => !k.startsWith("bullet_"));
  const filled = required.filter((k) => String(profile[k] || "").trim());
  return {
    filled: filled.length,
    total: required.length,
    missing: required.filter((k) => !String(profile[k] || "").trim()),
  };
}

/**
 * The whole card as plain text, one labelled field per line.
 *
 * For pasting into a Workday free-text box, so: no blank lines, no headings, no
 * markdown. Empty fields are OMITTED rather than rendered as "Phone:" with
 * nothing after it — a form filled from this should not contain a label with no
 * value, which reads as an answer of "none".
 */
export function copyAllText(profile = {}, variant = "tech") {
  return FIELDS
    // ONE variant's bullets, never both. There are two "Bullet 1" fields now,
    // and pasting both sets into a Workday box would put two different first
    // bullets under the same label — the reader cannot tell which is the
    // answer, and one of them is framed for the wrong industry.
    .filter(([, , , o]) => !o?.variant || o.variant === variant)
    .map(([k, label]) => [label, String(profile[k] || "").trim()])
    .filter(([, v]) => v)
    .map(([label, v]) => `${label}: ${v}`)
    .join("\n");
}

/**
 * Reject a write that would make a claim nobody is entitled to make.
 *
 * Belongs here rather than only in the API route so the rule is testable
 * without a server, and so a second write path cannot come along without it.
 * Returns an error string, or null.
 */
export function rejectWrite(key, value) {
  if (!FIELD_KEYS.includes(key)) return `unknown field ${key}`;
  if (READ_ONLY.has(key)) return `${FIELD_LABEL[key]} is fixed and cannot be edited`;
  const claim = forbiddenClaim(value);
  if (claim) {
    return `that says ${JSON.stringify(claim)} — a clearance determination is made `
         + "by an adjudicator, not by you. Say what is true instead: no current "
         + "or prior clearance, willing to undergo the process.";
  }
  return null;
}
