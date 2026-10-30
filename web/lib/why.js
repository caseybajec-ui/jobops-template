/**
 * Why a role landed where it did, in sentences.
 *
 * NO NEW SCORING, and that is the whole design. Every line below is read off a
 * column the pipeline already wrote — the deterministic gate's verdicts, the
 * scorer's own reasons, the spread across its samples. Nothing here judges
 * anything; it translates.
 *
 * WHY IT WAS NEEDED. A band is a one-word summary of a judgement made by a
 * model against a profile, filtered by four deterministic gates, and the only
 * thing on screen was the word. "Strong" is not an explanation, and a tool
 * whose central number cannot be interrogated is one you either trust blindly
 * or stop using — and the owner does not write code, so "read the scorer" is
 * not an available answer.
 *
 * Pure: no database, no `node:`. Runs in the client component that renders it.
 */

import { bandOf, BANDS, NEW_GRAD_PAY_CEILING } from "./display.js";
// The owner's class year and the start_window label the gate writes for it,
// baked from profile.json. Pure data, so it is safe in a client component.
import { CLASS_YEAR, PROGRAM_WINDOW, OWNER } from "./config.generated.js";

/**
 * The four deterministic gates, in the order they are applied, said plainly.
 *
 * These run in Python BEFORE any model sees the role, and they are the reason
 * most roles are missing rather than low-scoring. the owner's most likely question
 * about a role he cannot find is answered here and nowhere else.
 */
export function gateFacts(job = {}) {
  const out = [];

  const level = job.entry_level;
  out.push({
    key: "level",
    label: "Level",
    pass: level === "program" || level === "entry",
    text: level === "program"
      ? `A named new-grad programme — the kind you can actually start in ${OWNER.graduation}.`
      : level === "entry"
        ? "Open to new graduates."
        : level === "experienced"
          ? "The posting wants more experience than you will have. It is here as intelligence about who hires this profile, not as something to apply to."
          : "The posting does not say what level it is, so it was let through rather than dropped.",
  });

  const fit = job.class_fit || "ok";
  out.push({
    key: "class",
    label: "Your graduating class",
    pass: fit !== "wrong_year",
    text: fit === "wrong_year"
      ? `For a different graduating class${job.class_year ? ` — this one is dated ${job.class_year}` : ""}. ${job.class_reason || ""}`.trim()
      : job.start_window === PROGRAM_WINDOW
        ? `Dated for a ${CLASS_YEAR} start, which is your year.`
        : "Nothing in the posting rules out your class year.",
  });

  const clr = job.clearance_status || "none_mentioned";
  out.push({
    key: "clearance",
    label: "Clearance",
    pass: clr !== "required_active",
    // The phrasing rule from CLAUDE.md applies here as everywhere: this may say
    // what the POSTING requires and what the employer does. It never says
    // anything about whether the owner is eligible, because that is an
    // adjudicator's determination and not a fact this tool holds.
    text: clr === "required_active"
      ? "The posting requires a clearance the holder already has. An employer sponsors a clearance; you cannot obtain one in order to apply."
      : clr === "sponsorable"
        ? "The employer sponsors the clearance. That is the version of this that is open to you."
        : clr === "eligibility_only"
          ? "The posting asks for eligibility rather than a clearance already held."
          : "No clearance mentioned in the posting.",
  });

  if (job.yoe) {
    out.push({
      key: "yoe",
      label: "Years asked for",
      pass: Number(job.yoe) <= 2,
      text: `The posting asks for ${job.yoe}+ years. That number was pulled out of the text by a regex and compared to a cutoff IN CODE — a model asked to compare two integers gets it wrong often enough to have killed real roles at Anduril.`,
    });
  }

  if (job.comp_min) {
    out.push({
      key: "pay",
      label: "Pay",
      pass: job.entry_level === "program" || job.comp_min <= NEW_GRAD_PAY_CEILING,
      text: job.comp_min > NEW_GRAD_PAY_CEILING && job.entry_level !== "program"
        ? `The published floor is above $${Math.round(NEW_GRAD_PAY_CEILING / 1000)}K, which for a role that is not a named programme usually means it is not really a new-grad seat.`
        : "The published band is in the range a new grad is actually hired into.",
    });
  }

  return out;
}

/**
 * How much to trust the number.
 *
 * The scorer is run several times per role and the SPREAD across those runs is
 * stored. A wide spread means the model disagreed with itself, which is a fact
 * about the score rather than about the role — and it is the single most
 * important caveat on this page, because a 72 with a 30-point spread and a 72
 * with a 2-point spread look identical everywhere else in the app.
 */
export function confidenceText(job = {}) {
  const spread = Number(job.score_spread ?? 0);
  const n = Number(job.n_samples ?? 0);
  // "Scored 1 times" is the kind of thing that makes a reader trust the rest of
  // the page slightly less, for free.
  const runs = n === 1 ? "Scored once" : `Scored ${n} times`;
  if (n === 1) {
    return "Scored once, so there is no spread to report. Re-scoring the same role moves it by about ten points either way, which is why the band is the display and not the number.";
  }
  if (spread <= 6) {
    return `${runs} and it landed in the same place each time (${job.score_lo}–${job.score_hi}). As stable as this scorer gets.`;
  }
  if (spread <= 14) {
    return `${runs}, landing between ${job.score_lo} and ${job.score_hi}. Normal wobble — read it as a band, not a number.`;
  }
  return `${runs} and landed anywhere from ${job.score_lo} to ${job.score_hi}. The scorer disagreed with ITSELF here, so read the reasons below and ignore the number.`;
}

/** The band boundaries, so "why Strong and not Excellent" has an answer. */
export function bandText(score) {
  const n = Number(score) || 0;
  const name = bandOf(score);
  const i = BANDS.findIndex(([b]) => b === name);
  const floor = BANDS[i][1];
  const above = i > 0 ? BANDS[i - 1] : null;
  return above
    ? `${n} of 100 puts this in ${name}, which runs from ${floor} up. ${above[1]} would have made it ${above[0]}.`
    : `${n} of 100 puts this in ${name}, the top band, which starts at ${floor}.`;
}

/**
 * Everything, assembled. One object, so the component is a renderer.
 *
 * `blocked` is the list of gates this role FAILED. It is separated out because
 * a failed gate is the answer to a different question — "why can't I apply to
 * this" rather than "why is it ranked here" — and burying it in a list of
 * passes is how it gets missed.
 */
export function whyThisFit(job = {}) {
  const gates = gateFacts(job);
  return {
    band: bandOf(job.score),
    bandText: bandText(job.score),
    confidence: confidenceText(job),
    gates,
    blocked: gates.filter((g) => !g.pass),
    reasons: job.reasons || [],
    gaps: job.gaps || [],
    // Which model, at what effort. Not decoration: CLAUDE.md's hardest cost
    // rule is that one model scores everything, because two models on one scale
    // put the top of every ranking in whichever one inflates more.
    model: job.model || null,
    effort: job.effort || null,
  };
}
