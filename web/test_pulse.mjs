/**
 * Conversion metrics and the profile card. Run: node test_pulse.mjs
 *
 * The whole point of the pulse is to decide what the owner does with his December:
 * if alumni messages get replies and cold ones do not, the answer is more
 * alumni messages. That makes a wrong number here worse than no number, so the
 * two rules that keep it honest are tested harder than the arithmetic:
 *
 *   a rate below n=3 is not reported at all, and
 *   a message that never got a reply is not a data point about speed.
 */
import {
  rate, median, weekStart, pairSendsAndReplies, computePulse, mondayRetro, MIN_N,
} from "./lib/pulse.js";
import {
  FIELDS, FIELD_KEYS, READ_ONLY, DEFAULTS, completeness, copyAllText, rejectWrite,
} from "./lib/card.js";
import { forbiddenClaim } from "./lib/clearance.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* -------------------------------------------------- the n<3 suppression */

eq(MIN_N, 3, "the floor is three");
ok(!rate(1, 1).enough, "one reply out of one is not a 100% reply rate");
eq(rate(1, 1).label, "too few to say", "and it says so rather than printing a number");
eq(rate(1, 1).pct, null, "with no percentage at all to be misread");
eq(rate(1, 1).hits, 1, "but the raw counts survive, because those are true at any n");
eq(rate(1, 1).total, 1, "both of them");
ok(!rate(2, 2).enough, "two of two is still too few");
ok(rate(3, 3).enough, "three is the first n that reports");
eq(rate(3, 3).label, "100%", "and then it says the number");
eq(rate(1, 4).label, "25%", "rounding to whole percent");
eq(rate(0, 5).label, "0%", "zero of five is a real answer, not a missing one");
eq(rate(0, 0).label, "too few to say", "and nothing at all is not 0%");

/* ------------------------------------------------------------- median */

eq(median([]), null, "no durations, no median");
eq(median([4]), 4, "one is its own median");
eq(median([1, 2, 3]), 2, "odd counts take the middle");
eq(median([1, 2, 3, 10]), 3, "even counts average the two middles, rounded");
// A MEDIAN, NOT A MEAN, and this is why: one 40-day reply must not move it.
eq(median([1, 1, 2, 2, 40]), 2, "one very late reply does not drag the median");
eq(median([1, null, 2, undefined, 3]), 2, "and non-numbers are dropped, not counted as zero");

/* ------------------------------------------- pairing sends with replies */

const ix = (id, contact, type, at) =>
  ({ id, contact_id: contact, type, occurred_at: at });

{
  // ONE REPLY ANSWERS ONE MESSAGE. Three messages to one contact and a single
  // reply is one reply — not three — and that is the normal case here, because
  // the cadence sends follow-ups on day 5 and day 12.
  const pairs = pairSendsAndReplies([
    ix("i1", "c1", "outreach_sent", "2026-08-01"),
    ix("i2", "c1", "outreach_sent", "2026-08-06"),
    ix("i3", "c1", "outreach_sent", "2026-08-13"),
    ix("i4", "c1", "reply_received", "2026-08-14"),
  ]);
  eq(pairs.length, 3, "three messages produce three pairs");
  eq(pairs.filter((p) => p.reply).length, 1, "and exactly one of them was answered");
  // The reply answers the MOST RECENT message before it, so the duration is
  // one day and not thirteen.
  eq(pairs.find((p) => p.reply).send.id, "i3", "the reply answers the latest message");
}
{
  const pairs = pairSendsAndReplies([
    ix("i1", "c1", "outreach_sent", "2026-08-01"),
    ix("i2", "c2", "outreach_sent", "2026-08-01"),
    ix("i3", "c2", "reply_received", "2026-08-03"),
  ]);
  eq(pairs.length, 2, "pairs are per contact");
  eq(pairs.filter((p) => p.reply).length, 1, "and one of two contacts replied");
}
{
  // A reply with no preceding message is not a pair. It happens: he logs a
  // reply to something sent before the tool existed.
  eq(pairSendsAndReplies([ix("i1", "c1", "reply_received", "2026-08-03")]).length, 0,
     "an orphan reply invents no message");
}

/* --------------------------------------------------------- the whole pulse */

const NOW = new Date("2026-09-02T12:00:00Z");   // a Wednesday

{
  // ALL ZEROES must render, because that is the state on the day this ships.
  const p = computePulse({ now: NOW });
  eq(p.week.sent, 0, "an empty week is zero, not undefined");
  eq(p.replyRate.label, "too few to say", "and no rate is claimed from nothing");
  eq(p.medianDays, null, "nor a median");
  eq(p.sources, [], "and no source breakdown at all");
  eq(p.applications.submitted, 0, "no applications");
  eq(p.applications.referredRate.label, "too few to say", "and no referral verdict");
}

{
  const contacts = [
    { id: "c1", source: "usc_alumni" }, { id: "c2", source: "usc_alumni" },
    { id: "c3", source: "usc_alumni" }, { id: "c4", source: "linkedin" },
  ];
  const interactions = [
    ix("a1", "c1", "outreach_sent", "2026-08-24"), ix("a2", "c1", "reply_received", "2026-08-26"),
    ix("b1", "c2", "outreach_sent", "2026-08-24"), ix("b2", "c2", "reply_received", "2026-08-25"),
    ix("c1x", "c3", "outreach_sent", "2026-08-24"),
    ix("d1", "c4", "outreach_sent", "2026-08-24"),
  ];
  const p = computePulse({ interactions, contacts, now: NOW });

  eq(p.replyRate.hits, 2, "two replies");
  eq(p.replyRate.total, 4, "out of four messages");
  eq(p.replyRate.label, "50%", "which is enough to report");

  const alumni = p.sources.find((s) => s.key === "usc_alumni");
  eq(alumni.total, 3, "three alumni messages");
  eq(alumni.label, "67%", "two of three replied");
  // THE MEDIAN EXCLUDES THE UNANSWERED ONE. Two replies at 2 and 1 days; the
  // third message never got one and contributes to the RATE but not the speed.
  eq(alumni.medianDays, 2, "median over the two that actually replied");
  eq(alumni.answered, 2, "and it says how many produced a duration");

  const li = p.sources.find((s) => s.key === "linkedin");
  eq(li.label, "too few to say", "one LinkedIn message says nothing about LinkedIn");
  eq(li.total, 1, "though the count is still shown");
}

/* --------------------------------------------------------- applications */

{
  const apps = [
    { withReferral: true, status: "phone_screen" },
    { withReferral: true, status: "interview" },
    { withReferral: true, status: "applied" },
    { withReferral: false, status: "applied" },
    { withReferral: false, status: "rejected" },
    { withReferral: null, status: "applied" },
  ];
  const p = computePulse({ applications: apps, now: NOW });
  eq(p.applications.submitted, 6, "six applications");
  eq(p.applications.withRef, 3, "three with a referral");
  eq(p.applications.withoutRef, 2, "two cold");
  // NULL IS NEITHER. "He did not answer the question" and "he applied cold"
  // are different facts, and folding the first into the second would invent
  // evidence against the very thesis this page tests.
  eq(p.applications.unknownRef, 1, "and one he did not answer for");
  eq(p.applications.referredRate.label, "67%", "two of three referred applications moved");
  eq(p.applications.coldRate.label, "too few to say", "two cold ones say nothing yet");
  eq(p.applications.screens, 1, "one screen");
  eq(p.applications.interviews, 1, "one interview");
}

/* ------------------------------------------------------------ week start */

eq(weekStart(new Date("2026-09-02T12:00:00Z")), "2026-08-31",
   "a Wednesday belongs to the Monday before it");
eq(weekStart(new Date("2026-08-31T12:00:00Z")), "2026-08-31",
   "a Monday is its own week start");
// Weeks start Monday because the retro is a Monday ritual; a Sunday-start week
// would report a "last week" that ended the day before yesterday.
eq(weekStart(new Date("2026-09-06T12:00:00Z")), "2026-08-31",
   "and a Sunday still belongs to the week that began on Monday");

/* ---------------------------------------------------------- Monday retro */

{
  const wed = computePulse({ now: NOW });
  eq(mondayRetro(wed, [], NOW), null,
     "no retro on a Wednesday — a week in progress is a number that moves while you read it");
}
{
  const monday = new Date("2026-09-07T12:00:00Z");
  const interactions = [
    ix("a1", "c1", "outreach_sent", "2026-09-01"), ix("a2", "c1", "reply_received", "2026-09-02"),
    ix("b1", "c2", "outreach_sent", "2026-09-02"),
    ix("c1x", "c3", "outreach_sent", "2026-09-03"),
  ];
  const p = computePulse({ interactions, now: monday });
  const r = mondayRetro(p, [{ id: "x", due_at: "2026-09-03", done: false }], monday);
  ok(r && !r.empty, "a Monday gets a retro");
  eq(r.sent, 3, "three messages last week");
  eq(r.replies, 1, "one reply");
  eq(r.slipped, 1, "and one task slipped past its date");
  ok(/3 messages sent, 1 reply/.test(r.lines[0]), "stated in words, correctly pluralised");
}
{
  const monday = new Date("2026-09-07T12:00:00Z");
  const r = mondayRetro(computePulse({ now: monday }), [], monday);
  ok(r.empty, "an empty week is an empty retro");
  ok(/two names and one application/.test(r.lines[0]),
     "and it names the smallest next thing rather than reporting zero");
}

/* ------------------------------------------------------- the profile card */

eq(FIELD_KEYS.length, FIELDS.length, "every field has a key");
ok(FIELDS.every(([k, l, g]) => k && l && g), "and a label and a group");
ok(READ_ONLY.has("clearance_line"), "the clearance line cannot be edited from the app");
ok(READ_ONLY.size === 1, "and it is the only read-only field");

// The default clearance sentence must itself pass the rule it exists to state.
eq(forbiddenClaim(DEFAULTS.clearance_line), null,
   "the seeded clearance line makes no claim an adjudicator has not made");
ok(/no current or prior clearance/i.test(DEFAULTS.clearance_line),
   "and does state the position out loud");

// RULE 4. Nothing invents resume text, least of all on the surface built for
// pasting into real application forms.
ok(!DEFAULTS.bullet_1 && !DEFAULTS.bullet_2 && !DEFAULTS.bullet_3,
   "the three bullets start empty rather than seeded with invented text");

{
  const p = { ...DEFAULTS, legal_name: "A", email: "a@b.c" };
  const c = completeness(p);
  ok(c.filled === 5, "completeness counts what is actually filled");
  ok(c.missing.includes("phone"), "and names what is missing");
  ok(!c.missing.some((k) => k.startsWith("bullet_")),
     "a blank bullet is an honest blank, not an incompletion to nag about");
}

{
  const text = copyAllText({ legal_name: "Jordan Reyes", email: "c@example.com", phone: "" });
  eq(text, "Legal name: Jordan Reyes\nEmail: c@example.com",
     "copy-all is one labelled field per line, with empty fields omitted");
  ok(!/\n\n/.test(text), "and no blank lines, because it is pasted into one box");
  // An empty field must not render as a label with nothing after it — on a form
  // that reads as an answer of "none".
  ok(!/Phone:/.test(text), "an empty field is absent rather than labelled blank");
}

/* ------------------------------------------------------------ write rules */

eq(rejectWrite("legal_name", "Jordan Reyes"), null, "an ordinary field accepts an ordinary value");
ok(rejectWrite("clearance_line", "anything") !== null, "the clearance line refuses every write");
ok(rejectWrite("nonsense_field", "x") !== null, "an unknown field is refused");
{
  // THE RULE, ON THE WRITE PATH. A free-text box under time pressure is exactly
  // where "willing to undergo the process" becomes "eligible".
  const err = rejectWrite("bullet_1", "I am clearance-eligible for TS/SCI.");
  ok(err !== null, "a bullet claiming eligibility is refused");
  ok(/adjudicator/.test(err), "and the message says why, rather than just 'invalid'");
}
eq(rejectWrite("bullet_1", "Cut AI cost per brief by half with the Batch API."), null,
   "while a real bullet goes through untouched");

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
