/**
 * Does any of this work? Pure — no database, no `node:`.
 *
 * The tool has recorded outreach and applications for weeks and has never once
 * said whether they convert. That is the question that decides what the owner does
 * with his December: if alumni messages get replies and cold ones do not, the
 * answer is more alumni messages, and nothing on any screen has been able to
 * say so.
 *
 * TWO RULES GOVERN EVERYTHING HERE.
 *
 * 1. A RATE BELOW n=3 IS NOT REPORTED. One reply out of one message is not a
 *    100% reply rate, it is one reply — and a tool that prints "100%" beside it
 *    is inviting a decision that the data cannot support. Everything under the
 *    floor renders "too few to say" and shows its raw counts instead, which are
 *    always true.
 *
 * 2. AN UNANSWERED MESSAGE IS NOT A DATA POINT ABOUT SPEED. Median days to
 *    reply is computed over messages that GOT one; a send with no reply is
 *    excluded from the median and counted in the denominator of the rate.
 *    Folding "never replied" into a duration as some large number would be
 *    inventing an observation, and folding it in as zero would be worse.
 *
 * Both are the same instinct as the deadline confidence labels: a weak answer
 * said plainly beats a confident wrong one.
 */
import { today as todayIn, weekday as weekdayIn } from "./day.js";

/** Below this, a ratio is a coincidence. */
export const MIN_N = 3;

/**
 * A rate that knows whether it is allowed to exist.
 *
 * Always returns the counts, because those are true at any n and are what
 * should be rendered when the rate cannot be.
 */
export function rate(hits, total) {
  const n = Number(total) || 0;
  const h = Number(hits) || 0;
  if (n < MIN_N) {
    return { hits: h, total: n, pct: null, enough: false, label: "too few to say" };
  }
  const pct = Math.round((h / n) * 100);
  return { hits: h, total: n, pct, enough: true, label: `${pct}%` };
}

/** The middle value, or null. Never a mean: one 40-day reply would move it. */
export function median(values = []) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const daysBetween = (a, b) =>
  Math.round((Date.parse(day(b) + "T00:00:00Z") - Date.parse(day(a) + "T00:00:00Z")) / 86400000);

/**
 * The Monday that starts the week containing `d`, in the user's timezone.
 *
 * Weeks start Monday because the retro is a Monday ritual and a Sunday-start
 * week would report a "last week" that ended yesterday-but-one.
 */
export function weekStart(d = new Date(), tz = "America/Los_Angeles") {
  const local = new Date(d.toLocaleString("en-US", { timeZone: tz }));
  const dow = (local.getDay() + 6) % 7;            // Monday = 0
  local.setDate(local.getDate() - dow);
  return local.toLocaleDateString("en-CA");         // YYYY-MM-DD
}

/**
 * Pair every outreach message with the reply that followed it, per contact.
 *
 * ONE REPLY ANSWERS ONE MESSAGE, and it answers the most recent message before
 * it. Without that, a contact messaged three times and replying once would
 * count as three replies — which is exactly the shape a follow-up cadence
 * produces, so it is not a corner case here, it is the normal case.
 *
 * Ordered by (occurred_at, id): two interactions logged on one day carry the
 * same date, and ordering on the date alone would settle them at random.
 */
export function pairSendsAndReplies(interactions = []) {
  const byContact = new Map();
  for (const i of interactions) {
    if (!byContact.has(i.contact_id)) byContact.set(i.contact_id, []);
    byContact.get(i.contact_id).push(i);
  }

  const pairs = [];
  for (const [, list] of byContact) {
    const sorted = [...list].sort(
      (a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at))
             || String(a.id).localeCompare(String(b.id)));
    let openSend = null;
    for (const i of sorted) {
      if (i.type === "outreach_sent") {
        // A second message before any reply REPLACES the open one rather than
        // queueing: the reply, when it comes, is to the most recent thing said.
        if (openSend) pairs.push({ send: openSend, reply: null });
        openSend = i;
      } else if (i.type === "reply_received" && openSend) {
        pairs.push({ send: openSend, reply: i });
        openSend = null;
      }
    }
    if (openSend) pairs.push({ send: openSend, reply: null });
  }
  return pairs;
}

/**
 * Everything the Pulse page shows, from the rows it is given.
 *
 * `contacts` supplies each contact's SOURCE, so reply rate can be broken down
 * by where the name came from — the one breakdown that changes behaviour.
 */
export function computePulse({
  interactions = [], contacts = [], applications = [], now = new Date(),
  tz = "America/Los_Angeles",
} = {}) {
  const thisWeek = weekStart(now, tz);
  const lastWeek = weekStart(new Date(Date.parse(thisWeek + "T00:00:00Z") - 86400000), tz);

  const sourceOf = new Map(contacts.map((c) => [c.id, c.source || "other"]));
  const inWeek = (iso, start) => {
    const d = day(iso);
    if (!d) return false;
    const end = new Date(Date.parse(start + "T00:00:00Z") + 7 * 86400000)
      .toISOString().slice(0, 10);
    return d >= start && d < end;
  };

  const count = (type, week = null) => interactions.filter(
    (i) => i.type === type && (week === null || inWeek(i.occurred_at, week))).length;

  const totals = {
    sent: count("outreach_sent"),
    replies: count("reply_received"),
    callsBooked: count("call_scheduled"),
    callsDone: count("call_done"),
    referralsAsked: count("referral_asked"),
    referralsReceived: count("referral_received"),
  };
  const week = {
    sent: count("outreach_sent", thisWeek),
    replies: count("reply_received", thisWeek),
    callsBooked: count("call_scheduled", thisWeek),
    callsDone: count("call_done", thisWeek),
    referralsAsked: count("referral_asked", thisWeek),
    referralsReceived: count("referral_received", thisWeek),
  };
  const prior = {
    sent: count("outreach_sent", lastWeek),
    replies: count("reply_received", lastWeek),
  };

  /* ------------------------------------------------------ reply rate by source */

  const pairs = pairSendsAndReplies(interactions);
  const bySource = new Map();
  for (const p of pairs) {
    const key = sourceOf.get(p.send.contact_id) || "other";
    const e = bySource.get(key) || { sent: 0, replied: 0, days: [] };
    e.sent += 1;
    if (p.reply) {
      e.replied += 1;
      const d = daysBetween(p.send.occurred_at, p.reply.occurred_at);
      // A reply logged before its message is a data-entry slip, not a negative
      // duration. Dropped from the median rather than allowed to drag it down.
      if (Number.isFinite(d) && d >= 0) e.days.push(d);
    }
    bySource.set(key, e);
  }

  const sources = [...bySource]
    .map(([key, e]) => ({
      key,
      ...rate(e.replied, e.sent),
      medianDays: median(e.days),
      // How many of the rate's own denominator produced a duration. Without it
      // "median 2 days" beside "12 sent" reads as though all twelve replied.
      answered: e.days.length,
    }))
    // TOTAL: rates tie constantly at 0 and at 100, so the key breaks it.
    .sort((a, b) => b.total - a.total || String(a.key).localeCompare(String(b.key)));

  const allDays = [...bySource.values()].flatMap((e) => e.days);

  /* ------------------------------------------------------------ applications */

  const submitted = applications.length;
  const withRef = applications.filter((a) => a.withReferral === true).length;
  const withoutRef = applications.filter((a) => a.withReferral === false).length;
  // NULL is neither. "He did not answer" and "he applied cold" are different
  // facts, and folding the first into the second would invent evidence against
  // the very thesis this page exists to test.
  const unknownRef = submitted - withRef - withoutRef;

  const progressed = (rows) => rows.filter(
    (a) => a.status && !["applied", "saved", "rejected", "ghosted"].includes(a.status)).length;

  const stage = (name) => applications.filter((a) => a.status === name).length;

  return {
    week, prior, totals,
    weekOf: thisWeek,
    lastWeekOf: lastWeek,

    replyRate: rate(pairs.filter((p) => p.reply).length, pairs.length),
    medianDays: median(allDays),
    answered: allDays.length,
    sources,

    applications: {
      submitted,
      withRef, withoutRef, unknownRef,
      screens: stage("phone_screen"),
      interviews: stage("interview") + stage("final"),
      offers: stage("offer"),
      rejected: stage("rejected"),
      // The comparison the whole networking half of this tool is a bet on.
      // Suppressed below n=3 like everything else, because "1 of 1 referred
      // applications progressed" is not evidence that referrals work.
      referredRate: rate(
        progressed(applications.filter((a) => a.withReferral === true)), withRef),
      coldRate: rate(
        progressed(applications.filter((a) => a.withReferral === false)), withoutRef),
    },
  };
}

/**
 * The Monday retro: three sentences about the week that just ended.
 *
 * Only ever about LAST week, and only on a Monday. A retro on a Wednesday is a
 * report about a week still in progress, which is a number that changes while
 * you read it.
 */
export function mondayRetro(pulse, items = [], now = new Date(), tz = "America/Los_Angeles") {
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  if (local.getDay() !== 1) return null;

  const start = pulse.lastWeekOf;
  const end = pulse.weekOf;
  const sent = pulse.prior.sent;
  const replies = pulse.prior.replies;

  // A task whose due date fell inside last week and which is still not done.
  const slipped = items.filter(
    (i) => !i.done && i.due_at && String(i.due_at) >= start && String(i.due_at) < end).length;

  const apps = 0;   // filled by the caller, which knows the application dates

  if (!sent && !replies && !slipped) {
    return {
      empty: true,
      lines: ["Last week: nothing logged. This week starts with two names and one application."],
    };
  }

  const r = rate(replies, sent);
  return {
    empty: false,
    sent, replies, slipped, apps,
    rateLabel: r.enough ? r.label : null,
    lines: [
      `Last week: ${sent} ${sent === 1 ? "message" : "messages"} sent, `
      + `${replies} ${replies === 1 ? "reply" : "replies"}`
      + (r.enough ? ` (${r.label})` : "") + ".",
      slipped
        ? `${slipped} ${slipped === 1 ? "task" : "tasks"} slipped past their date.`
        : "Nothing slipped.",
    ],
  };
}
