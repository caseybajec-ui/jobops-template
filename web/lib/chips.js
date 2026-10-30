/**
 * What a chip says, decided once. Pure — no React, no `node:` — so the rules
 * are testable without rendering anything and the component below is only a
 * span with a class name.
 *
 * THE PROBLEM. Small coloured labels had accumulated in five places with five
 * private colour rules: the deadline row tinted its own text, the verification
 * label was a bare word, the urgency scale existed on Daily and nowhere else,
 * and the gap between a company name and its chip was set per call site (and
 * missing in Closing soon). Colour is supposed to carry exactly five meanings
 * in this app; three of them live in chips, and they have to mean the same
 * thing at the same weight on every page or they mean nothing.
 *
 * Three variants, and no fourth without a reason:
 *
 *   urgency        how long until it closes. TODAY is the only filled red pill
 *                  in the app — that is what makes it findable.
 *   verification   how much a date is worth. This is the McKinsey lesson wearing
 *                  a colour: 1 of 25 dates is read from a firm's own site, and a
 *                  guess that renders like a fact costs a recruiting cycle.
 *   status         OPEN NOW / class year / new-grad program. Deliberately grey and
 *                  deliberately not urgent — it is a fact about the role, not a
 *                  claim on the day.
 */

/**
 * Urgency from days remaining.
 *
 * `self` — a date the owner set for themselves — takes the OUTLINED variant of the same
 * scale rather than a scale of its own. The distinction that matters is
 * "the world will not wait" against "I said I would", and rendering a
 * self-imposed date as a filled red pill is how a tool teaches you that red
 * means nothing.
 */
import { num } from "./num.js";

export const URGENCY_STEPS = [
  ["today", 0, 0],
  ["now", 1, 7],
  ["soon", 8, 30],
  ["later", 31, Infinity],
];

export function urgencyOf(days, kind = "external") {
  // null and "" BEFORE Number(), because Number(null) is 0 and Number("") is 0.
  // A window with no close date would otherwise render as the filled red TODAY
  // pill — the loudest thing on the page, asserting a deadline nobody has ever
  // read. 16 of the 25 tracked windows have no date, so this was not an edge
  // case; it was most of them.
  const d = num(days);
  if (d === null) return null;
  // Overdue is louder than today, never quieter. It used to fall off the bottom
  // of the scale and render grey, which is the wrong answer in the one case
  // where being wrong is unrecoverable.
  const step = d < 0 ? "today" : (URGENCY_STEPS.find(([, lo, hi]) => d >= lo && d <= hi) || [])[0];
  if (!step) return null;
  return { tone: step, outlined: kind === "self", kind };
}

/**
 * How much a date is worth, from `companies.yaml`'s own confidence values.
 *
 * `verified` is the only one that means a human read it off the firm's site.
 * Everything else is a prompt to go and check, and has to look like one.
 */
export const VERIFICATION = {
  verified: ["confirmed", "Read from the firm's own site."],
  "secondary-source": ["weak", "Two or more independent trackers agree. Not the firm."],
  "historical-estimate": ["unconfirmed", "Inferred from previous years. Confirm it."],
  // A date HE set, for a firm that has published none. Its own tone rather
  // than a fallback to "unconfirmed" — that word would claim the FIRM's date
  // was being estimated, and there is no firm's date.
  "planning-target": ["self", "A date you set yourself. The firm has published none."],
};

/**
 * The one sentence explaining what the three confidence chips mean.
 *
 * Exported for the same reason URGENCY_SENTENCE is: it appears in the footer
 * legend AND in the "?" on the first chip, and a rule written twice is a rule
 * that drifts. 1 of 25 tracked dates is `verified`; the whole point of the chip
 * is that the other 24 do not look like facts.
 */
export const VERIFICATION_SENTENCE =
  "Only “confirmed” has been read off the firm's own site — everything else "
  + "is a prompt to go and check.";

/**
 * The WORD for each confidence value, in one place.
 *
 * Forecast's Open-now table had its own set — "from firm's site" / "secondary
 * source" / "estimate" — against Daily's "confirmed" / "2 trackers" /
 * "estimated". Identical data, identical colours, two nouns, and no way for a
 * reader to tell it was one scale. Keyed by TONE rather than by the yaml value
 * so the chip and any plain-text caller cannot fall out of step.
 */
export const VERIFICATION_WORD = {
  confirmed: "confirmed", weak: "2 trackers", unconfirmed: "estimated", self: "your target",
};

/** The same word, addressed by the yaml's own confidence value. */
export const VERIFICATION_LABEL = Object.fromEntries(
  Object.entries(VERIFICATION).map(([k, [tone]]) => [k, VERIFICATION_WORD[tone]]));

export function verificationOf(confidence) {
  const [tone, why] = VERIFICATION[confidence] || VERIFICATION["historical-estimate"];
  return { tone, why, confidence: confidence || "historical-estimate" };
}

/** The class string for a chip, so markup cannot invent a variant. */
export function chipClass(variant, tone, outlined = false) {
  return ["chip", `chip-${variant}`, tone && `tone-${tone}`, outlined && "outlined"]
    .filter(Boolean).join(" ");
}

/**
 * The one sentence explaining the urgency scale.
 *
 * It appears in the legend AND in the "?" on the first urgency chip, and it is
 * exported rather than written twice because a threshold with prose beside it
 * has drifted from its constant once already in this codebase — the nav badge
 * said "21 days" for weeks after the horizon moved to 45.
 */
export const URGENCY_SENTENCE =
  "Red closes inside a week, gold inside a month, grey after that. "
  + "An outline means it is a date you set yourself.";
