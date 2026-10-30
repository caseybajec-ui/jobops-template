/**
 * What happened after "worth a look" — the rules, pure.
 *
 * No database and no `node:` imports, for the same reason display.js, today.js
 * and people.js have none: these run on the server AND inside client
 * components, and they are testable against fixed dates.
 *
 * A role used to be either visible or not. There was a per-posting stage column
 * holding one value with no history, so "applied three weeks ago and heard
 * nothing" and "applied yesterday" were indistinguishable — which is the only
 * distinction that changes what to do next.
 */

/**
 * The stages, in order, with what each one means in plain words.
 *
 * `saved` is deliberately absent from the head of this list even though the
 * brief put it there: saving already exists, as the `save` action on every row
 * in the app, and a second one would be two places to look for one fact. The
 * lifecycle starts where the application does.
 *
 * `ghosted` is a real outcome and gets a name. Without it the honest state —
 * "they never replied and never will" — has to be recorded as `rejected`,
 * which is a different thing and would quietly overstate how many decisions
 * were actually made about him.
 */
export const LIFECYCLE = [
  ["applied", "Applied", "In, waiting."],
  ["oa", "Online assessment", "A test to do, usually on a clock."],
  ["phone_screen", "Phone screen", "First real conversation."],
  ["interview", "Interview", "Rounds with the team."],
  ["final", "Final round", "Last stage before a decision."],
  ["offer", "Offer", "Decide."],
  ["rejected", "Rejected", "A decision was made."],
  ["ghosted", "Ghosted", "No decision, and there is not going to be one."],
];

export const LIFECYCLE_KEYS = LIFECYCLE.map(([k]) => k);
export const LIFECYCLE_LABEL = Object.fromEntries(LIFECYCLE.map(([k, l]) => [k, l]));
export const LIFECYCLE_BLURB = Object.fromEntries(LIFECYCLE.map(([k, , b]) => [k, b]));

/** Nothing more will happen on its own. These leave "In flight". */
export const TERMINAL = new Set(["offer", "rejected", "ghosted"]);

/** Handled = off the inbox by default. An offer is still live, so it is not here. */
export const HANDLED = new Set(["applied", "oa", "phone_screen", "interview",
                                "final", "offer", "rejected", "ghosted"]);

/**
 * Stages where an interview prep checklist appears.
 *
 * From the phone screen on: before that there is nothing to prepare for, and a
 * checklist on every applied role is a checklist you stop reading.
 */
export const PREPPING = new Set(["phone_screen", "interview", "final"]);

/**
 * How long a role can sit in `applied` before it is worth a nudge.
 *
 * Two weeks, chosen from the thing being waited on rather than from taste: an
 * application that has not moved in a fortnight has either been read and
 * shelved or never been read, and both are cases where knowing somebody inside
 * the company is the only lever left. Same reasoning as the 45-day window
 * horizon — a warning shorter than the process it warns about cannot do its job.
 */
export const NUDGE_AFTER_DAYS = 14;

/**
 * How long a just-recorded application can be taken back.
 *
 * Sixty seconds: long enough for "I ticked the wrong firm", short enough that
 * it stays an undo rather than becoming a way to delete history. Past it the
 * honest correction is a `rejected` or `ghosted` event, not a hole.
 *
 * It lives HERE rather than beside the query that enforces it, for the reason
 * this whole file exists: lib/applications.js imports driver.js, which imports
 * `pg`, and a "use client" component importing that made webpack try to bundle
 * `pg` for the browser — "Module not found: Can't resolve 'fs'". Exactly the
 * failure documented at the top of display.js, in a new place.
 */
export const UNDO_WINDOW_SECONDS = 60;

const DAY = 86400000;

export function daysIn(at, now = new Date()) {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / DAY);
}

/**
 * Where a role is now, from its events. LATEST WINS, by time then by id.
 *
 * Ordering on `at` alone is not total — two clicks inside the same second write
 * identical ISO timestamps, and the pair would then settle at random. The same
 * trap the actions table documents, which orders by id for exactly this reason.
 */
export function currentStatus(events = [], now = new Date()) {
  if (!events.length) return null;
  const sorted = [...events].sort(
    (a, b) => String(b.at || "").localeCompare(String(a.at || ""))
           || String(b.id || "").localeCompare(String(a.id || "")));
  const latest = sorted[0];
  // The referral answer belongs to the APPLIED event, not to the latest one —
  // it is a fact about how he got in, and it must survive every later move.
  const appliedEvent = [...sorted].reverse().find((e) => e.status === "applied");
  return {
    status: latest.status,
    at: latest.at,
    days: daysIn(latest.at, now),
    note: latest.note || null,
    referral: appliedEvent && appliedEvent.referral !== null
      && appliedEvent.referral !== undefined
      ? !!appliedEvent.referral
      : null,
    terminal: TERMINAL.has(latest.status),
    history: sorted,
  };
}

/**
 * Roles still in play, longest-waiting first.
 *
 * Ordered by days-in-stage rather than by how far along they are: the thing
 * that has not moved is the thing that needs a decision, and a list sorted by
 * stage buries it under whatever happens to be furthest along.
 */
export function inFlight(byRole = new Map(), now = new Date()) {
  const out = [];
  for (const [key, s] of byRole) {
    if (!s || s.terminal) continue;
    out.push({ groupKey: key, ...s, nudge: s.status === "applied" && s.days >= NUDGE_AFTER_DAYS });
  }
  return out.sort((a, b) => (b.days ?? 0) - (a.days ?? 0)
                         || String(a.groupKey).localeCompare(String(b.groupKey)));
}

/**
 * Applications with a referral against those without.
 *
 * SHOWN ONLY ONCE THERE ARE AT LEAST THREE, and that threshold is the honest
 * part. One application with a referral and one without is not evidence of
 * anything, and rendering "100% vs 0%" off a sample of two would be the same
 * failure as the 2027 posting forecast built on two days of first_seen: a
 * confident answer the data cannot support.
 *
 * Even at three this is a tally, never a rate. `unknown` is counted and shown
 * rather than being folded into "without", because "he did not answer the
 * question" and "he applied cold" are different facts.
 */
export const MIN_FOR_TALLY = 3;

/**
 * Takes a LIST, not a Map of roles.
 *
 * It took `Map<groupKey, status>` — role applications only — which meant the
 * three consulting applications with the nearest deadline were invisible to the
 * one number that exists to test whether referrals work. It now takes the union
 * from listActiveApplications(), so both kinds count once each.
 *
 * Accepts `referral` or `withReferral` because the two shapes call it that:
 * currentStatus() says `referral`, the union says `withReferral`. Reading both
 * is cheaper than a mapping layer whose only job is renaming one field.
 */
export function referralTally(applications = []) {
  const list = applications instanceof Map
    ? [...applications.values()]
    : Array.from(applications || []);
  let withRef = 0;
  let without = 0;
  let unknown = 0;
  let progressedWith = 0;
  let progressedWithout = 0;
  for (const s of list) {
    if (!s) continue;
    const ref = s.withReferral !== undefined ? s.withReferral : s.referral;
    const moved = s.status !== "applied" && s.status !== "rejected" && s.status !== "ghosted";
    if (ref === true) { withRef++; if (moved) progressedWith++; }
    else if (ref === false) { without++; if (moved) progressedWithout++; }
    else unknown++;
  }
  const total = withRef + without + unknown;
  return {
    withRef, without, unknown, total,
    progressedWith, progressedWithout,
    enough: total >= MIN_FOR_TALLY,
  };
}

/**
 * The interview prep checklist, by role family.
 *
 * Static and hand-written, the same call as the conversation-prep banks in
 * people.js and for the same reason: a generated list drifts to the generic,
 * and "research the company" is not worth a line. The families are identical to
 * the ones roleFamilyOf() already returns, so a role classified once is
 * classified everywhere.
 */
export const PREP_CHECKLISTS = {
  deployment: {
    label: "Deployment Strategist / forward-deployed",
    research: [
      "Find one customer of theirs you can name and say what problem they bought this to solve.",
      "Read the last three engineering or product posts on their blog; note one thing you disagree with.",
      "Work out who the buyer is — a programme office, a commercial ops team — and what they are measured on.",
    ],
    questions: [
      "Walk me through a time you turned a vague problem into something shippable.",
      "A customer wants something the product cannot do. What do you do this week?",
      "SQL and data-shaping: expect to be asked to reason about a messy dataset out loud.",
      "Why this rather than a conventional PM role?",
    ],
  },
  apm: {
    label: "APM / product",
    research: [
      "Use the product properly for an hour. Write down three things you would change and why.",
      "Find their most recent launch and work out what bet it represents.",
      "Know their business model well enough to say which metric this team moves.",
    ],
    questions: [
      "Product sense: improve X for user Y. They are testing whether you pick a user before a feature.",
      "Execution: a metric drops 15% overnight. Structure the diagnosis.",
      "Estimation, out loud, with your assumptions stated.",
      "Tell me about something you shipped end to end and what it cost you.",
    ],
  },
  defense_ops: {
    label: "Defense operations / mission ops",
    research: [
      "Know the platform or programme this team supports well enough to describe it in two sentences.",
      "Read their most recent contract award or partnership announcement.",
      "Be clear on where the role sits between engineering, the customer, and programme management.",
    ],
    questions: [
      "Describe a process you built from nothing and how you knew it was working.",
      "How do you operate when the information is incomplete and the decision cannot wait?",
      "Expect the citizenship and clearance question. Answer it exactly as profile.json states it: US citizen, no current or prior clearance, no known disqualifying factors, willing to undergo the process. Do NOT say cleared or eligible — that is a determination an adjudicator makes, not you.",
      "Why defense, and why now?",
    ],
  },
  vc: {
    label: "VC / growth analyst",
    research: [
      "Read their last four investments and have a view on one of them.",
      "Know the fund's stage, cheque size and thesis without looking it up.",
      "Prepare one company they have NOT invested in that you think they should.",
    ],
    questions: [
      "Pitch me a company. They are testing structure and conviction, not the pick.",
      "How would you size this market? Say your assumptions before your number.",
      "What have you read this week?",
      "Why an analyst seat rather than staying operational?",
    ],
  },
};

export const CHECKLIST_KEYS = Object.keys(PREP_CHECKLISTS);
