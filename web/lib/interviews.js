/**
 * What each kind of interview actually looks like. Static content, no model.
 *
 * EVERY ENTRY CARRIES A DISCLAIMER AND IT IS NOT DECORATION. This is compiled
 * from public interview reports, which is a genuinely weaker source than
 * anything else in this tool — the deadline windows at least come from a firm's
 * own site. It renders in graphite under every note, in the same spirit as the
 * "estimated" chip: a weak source said plainly beats a confident wrong one, and
 * the McKinsey miss is what that rule cost when it was ignored.
 *
 * NOTHING HERE IS ABOUT THE OWNER. It describes a process and suggests
 * preparation; it never asserts a fact about their background, and the clearance line in
 * defense_ops is the fixed phrasing from lib/clearance.js rather than a
 * paraphrase — test_clearance.mjs fires the predicate at every one of these.
 */

// The owner's class year, baked from profile.json. The one fact about the
// owner this file is allowed to carry, because "is this my intake" is a
// question about the JOB, and the year is what makes it answerable.
import { CLASS_YEAR, OWNER } from "./config.generated.js";

/** Rendered under every note, in graphite. Never omitted. */
export const DISCLAIMER =
  "Compiled from public interview reports; unverified — confirm with a contact "
  + "before relying on it.";

/**
 * THE QUESTION TO ASK EVERY TIME.
 *
 * 668 of 734 open scored roles state no start date at all, and no amount of
 * parsing changes that — the posting does not say. It is a question that can
 * only be answered by a human, it has to be asked on every call, and the owner
 * would otherwise rediscover that per application.
 *
 * It sits in `ask` on every family rather than in one family's prep list,
 * because it is not about the format of the interview. It is about the job.
 */
export const ALWAYS_ASK = [
  "When does this role actually start, and is a fall start possible? "
  + `Almost no posting says, and you graduate in ${OWNER.graduation.split(/\s+/)[0]}.`,
  `Is this the ${CLASS_YEAR} intake, or this year's?`,
];

export const INTERVIEWS = {
  deployment_strategist_fdse: {
    label: "Deployment strategist / forward deployed",
    process: [
      "A recruiter conversation.",
      "One or more problem-decomposition interviews: an ambiguous situation, "
      + "broken into what you would learn and do first.",
      "A case-style discussion drawing on something real from your background.",
      "A conversation about values and why this kind of work.",
      "Some tracks add a technical or data-reasoning round.",
    ],
    prep: [
      "Practise decomposing messy problems OUT LOUD: what is the goal, what do "
      + "we know, what would I check first, what is the smallest useful thing "
      + "to ship.",
      "Two stories from your own work ready — one about a user problem you "
      + "diagnosed from data, one about a decision made with incomplete information.",
      "Be able to explain what “deployment” means at that company in your "
      + "own words.",
      "Know one recent public deployment or customer story.",
    ],
    ask: ALWAYS_ASK,
  },

  apm_product: {
    label: "APM / early-career product",
    process: [
      "Recruiter screen.",
      "A product-sense round: design or improve a product for a user.",
      "An execution and analytics round: metrics, tradeoffs, what you would measure.",
      "Sometimes a technical-comfort conversation.",
      "A behavioural round.",
    ],
    prep: [
      "A repeatable structure for product questions: user, problem, options, "
      + "tradeoffs, metric.",
      "Something you built or ran as a live case study — pricing decisions, "
      + "churn, what you would build next and why.",
      "Comfort discussing how you work with engineers as the person who ships "
      + "the code yourself.",
      "One strong story about killing a feature.",
    ],
    ask: ALWAYS_ASK,
  },

  defense_ops: {
    label: "Mission operations / defense ops",
    process: [
      "Recruiter screen.",
      "A conversation with the hiring manager about the mission area.",
      "A scenario or case about supporting a system in the field, or a customer "
      + "with a hard constraint.",
      "A behavioural round.",
      "Sometimes a technical-comfort or systems-thinking round.",
    ],
    prep: [
      "Know the company's actual products and one deployment context.",
      // THE FIXED PHRASING. Not a paraphrase, and not softened upward: US
      // citizen, no current or prior clearance, no known disqualifying factors,
      // willing to undergo the process. Eligibility is an adjudicator's
      // determination, and saying otherwise on a defense application is a false
      // claim. Do NOT reword this line.
      "Expect the citizenship and clearance question. Answer it exactly as "
      + "profile.json states it: US citizen, no current or prior clearance, no "
      + "known disqualifying factors, willing to undergo the process. Say "
      + "nothing that sounds like a determination somebody has already made.",
      "Mention the SF-86 pack is in progress — it is a real answer to “how "
      + "quickly could you start the process”.",
      "A story about operating under constraints — a budget, a cap, a deadline.",
      "Genuine questions about what mission ops means day to day there.",
    ],
    ask: ALWAYS_ASK,
  },

  vc_analyst: {
    label: "VC / growth analyst",
    process: [
      "Resume screen.",
      "A conversation about how you think about markets and companies.",
      "A sourcing or market-map exercise.",
      "A modelling or memo exercise at some firms.",
      "Partner conversations.",
    ],
    prep: [
      "Two companies you would back and why, each with the counterargument.",
      "A market you understand better than most, from your own work.",
      "A crisp founder-turned-analyst narrative.",
      "Know what the firm actually invests in, by fund.",
    ],
    ask: [
      ...ALWAYS_ASK,
      // The Bessemer lesson, generalised: an analyst programme's class year and
      // its graduation window are different things, and the gap between them is
      // what made their programme the wrong cycle.
      "Which graduating class is this programme for, and what months does it "
      + `take? A “${CLASS_YEAR} class” can mean December ${CLASS_YEAR} graduates.`,
    ],
  },

  consulting: {
    label: "Consulting",
    process: [
      "An online assessment or game-based test.",
      "One or two case interviews: market sizing, profitability, entry.",
      "A behavioural and fit round.",
      "Sometimes a group exercise.",
    ],
    prep: [
      "Case structure and mental maths until both are automatic.",
      "Three behavioural stories mapped to leadership, conflict and analysis, "
      + "one from each of your evidence items.",
      "A one-line reason for consulting over building. Honest, not performed.",
      "Timing: these windows close as roles fill, so readiness matters more "
      + "than polish.",
    ],
    ask: ALWAYS_ASK,
  },
};

/** The note for a family, or null. Unknown family renders nothing at all. */
export function interviewNote(family) {
  return INTERVIEWS[family] || null;
}
