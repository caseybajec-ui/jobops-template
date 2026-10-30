/**
 * The networking half of the tool, as rules.
 *
 * Pure — no database, no fs, no model — for the same reason lib/today.js is:
 * every answer here is a stored fact or a date subtraction, so the same inputs
 * always give the same output and the whole thing can be tested against fixed
 * dates rather than against whatever the table holds this morning. It also has
 * to run inside client components, which rules out anything with `node:` in it.
 *
 * WHY THIS IS THE IMPORTANT FILE. The gap data's own conclusion is that a
 * referral is what routes around the two things that stop this profile — no CS
 * degree, and no clearance. The tool had a contacts table, a "Follow-ups owed"
 * heading, and a "Find 2 names" link, and none of the three could do anything,
 * because there was no way to record that a person exists or that anything
 * happened with them.
 *
 * TWO RULES FROM CLAUDE.md ARE LOAD-BEARING HERE AND ARE ENFORCED IN CODE:
 *
 *   Cadence stops at two. Day 5, day 12, then done — never a third. Two
 *   unanswered messages is an answer, and keeping the relationship intact for a
 *   future warm intro is worth more than persistence. owedFollowUps() stops
 *   offering a nudge once three messages have gone out, permanently.
 *
 *   Never manufacture a connection. The templates below state only what is
 *   literally true: a shared institution, a fact from the public posting, who
 *   the owner is. No "I've been following your work", no invented shared
 *   experience, no warmth with no basis. There is no model anywhere in this
 *   file and there is not going to be one.
 *
 * WHO THE OWNER IS COMES FROM profile.json, BAKED. The original carried one
 * person's name, school, class year and product in the template bodies as
 * literals -- the exact thing that survives a copy and then signs someone
 * else's name to a note to a stranger. Every owner fact is a merge field now,
 * filled from OWNER at render time (see OWNER_FIELDS and renderTemplate).
 */
import { OWNER, PREFS } from "./config.generated.js";

/* ------------------------------------------------------------ closed sets */

/**
 * What can have happened with a person. Closed, ordered roughly by how far
 * along it is, and the ONLY values `interactions.type` may hold.
 *
 * Stored as TEXT with the set enforced here and in the API route rather than as
 * a CHECK constraint or a Postgres enum — see migrations/002_people.sql for
 * why. The practical consequence is that this array is the schema, so adding a
 * value here is the whole change.
 */
export const INTERACTION_TYPES = [
  ["outreach_sent", "Sent them a message", "Messaged"],
  ["reply_received", "They replied", "Replied"],
  ["call_scheduled", "Booked a call", "Call booked"],
  ["call_done", "Had the call", "Talked"],
  ["referral_asked", "Asked for a referral", "Referral asked"],
  ["referral_received", "They referred me", "Referred"],
  ["thank_you_sent", "Sent a thank-you", "Thanked"],
];

export const INTERACTION_LABEL = Object.fromEntries(
  INTERACTION_TYPES.map(([k, , past]) => [k, past]));
export const INTERACTION_VERB = Object.fromEntries(
  INTERACTION_TYPES.map(([k, verb]) => [k, verb]));
export const INTERACTION_KEYS = INTERACTION_TYPES.map(([k]) => k);

export const CHANNELS = [
  ["linkedin", "LinkedIn"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["in_person", "In person"],
];
export const CHANNEL_KEYS = CHANNELS.map(([k]) => k);
export const CHANNEL_LABEL = Object.fromEntries(CHANNELS);

/** Where the name came from. LinkedIn is a SOURCE, never something scraped. */
export const SOURCES = [
  ["alumni_directory", `${OWNER.schoolShort} alumni directory`],
  ["linkedin", "LinkedIn"],
  // A list the owner compiled by hand and typed in as a batch — distinct from a
  // directory search or a LinkedIn find, so the row can say where it came from.
  ["manual-alumni-list", "Alumni list, entered by hand"],
  ["referral", "Introduced by someone"],
  ["event", "Met at an event"],
  ["other", "Other"],
];
export const SOURCE_KEYS = SOURCES.map(([k]) => k);
export const SOURCE_LABEL = Object.fromEntries(SOURCES);

export const WARMTH = [
  ["cold", "Never spoken"],
  ["warm", "Some connection"],
  ["responsive", "Replies to me"],
];
export const WARMTH_KEYS = WARMTH.map(([k]) => k);
export const WARMTH_LABEL = Object.fromEntries(WARMTH);

/* --------------------------------------------------------------- the clock */

const DAY = 86400000;

/** Parse a stored date or timestamp to a Date at UTC midnight of that day. */
function dayOf(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days from `iso` until `now`. Negative means `iso` is in the future. */
export function daysSince(iso, now = new Date()) {
  const d = dayOf(iso);
  if (!d) return null;
  return Math.floor((dayOf(now.toISOString()) - d) / DAY);
}

/**
 * Business days between a date and now — the unit the nudge rule is written in.
 *
 * "Five days after a Friday message" lands on a Wednesday if you count calendar
 * days and on the following Friday if you count working ones. The second is
 * what a person waiting on a reply actually means, and getting it wrong nudges
 * someone two days early, every time, on every message sent late in the week.
 *
 * Counts the days AFTER `iso` up to and including today, excluding Saturday and
 * Sunday. Holidays are not modelled: there is no calendar in this repo and
 * inventing one would be a guess wearing a schema.
 */
export function businessDaysSince(iso, now = new Date()) {
  const from = dayOf(iso);
  const to = dayOf(now.toISOString());
  if (!from || !to || to <= from) return 0;
  let n = 0;
  for (let t = from.getTime() + DAY; t <= to.getTime(); t += DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/** Monday of the week containing `now`, as a UTC midnight Date. */
export function weekStart(now = new Date()) {
  const d = dayOf(now.toISOString());
  const dow = d.getUTCDay();              // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;   // Sunday belongs to the week just ending
  return new Date(d.getTime() - back * DAY);
}

/* -------------------------------------------------------------- the status */

/**
 * Where a person is, derived from the LATEST thing that happened.
 *
 * Never stored. contacts.status exists — 001 created it and contacts.py still
 * writes it — and nothing in this app reads it, because a stored status is a
 * second copy of a fact the interactions table already holds, and the two
 * copies disagree the first time a write half-fails.
 *
 * "Gone cold" is the one status that is about ELAPSED TIME rather than about an
 * event, which is why it takes `now`. It deliberately does not apply to someone
 * who has referred you: that relationship is not going cold, it is done.
 */
export const COLD_AFTER_DAYS = 21;

export const STATUSES = [
  ["to_contact", "To contact", "Nobody has messaged them yet."],
  ["referred", "Referred", "They put you forward. Say thank you if you have not."],
  ["referral_asked", "Referral asked", "You asked. Give it a week before checking in."],
  ["in_conversation", "In conversation", "Live. The ball is somewhere between you."],
  ["waiting", "Waiting on reply", "Message sent, nothing back yet."],
  ["cold", "Gone cold", `Nothing either way for ${COLD_AFTER_DAYS} days.`],
];
export const STATUS_LABEL = Object.fromEntries(STATUSES.map(([k, l]) => [k, l]));
export const STATUS_BLURB = Object.fromEntries(STATUSES.map(([k, , b]) => [k, b]));
export const STATUS_ORDER = STATUSES.map(([k]) => k);

/** Newest first. Ties on the same day break on id, so the order is total. */
export function sortInteractions(list = []) {
  return [...list].sort(
    (a, b) => String(b.occurred_at || "").localeCompare(String(a.occurred_at || ""))
           || String(b.id || "").localeCompare(String(a.id || "")));
}

export function derivedStatus(interactions = [], now = new Date()) {
  const sorted = sortInteractions(interactions);
  const latest = sorted[0];
  if (!latest) return "to_contact";

  const base =
      latest.type === "referral_received" ? "referred"
    : latest.type === "referral_asked" ? "referral_asked"
    : latest.type === "outreach_sent" ? "waiting"
    : "in_conversation";

  // A referral is not a relationship that can go stale — it already delivered.
  if (base === "referred") return base;
  const age = daysSince(latest.occurred_at, now);
  return age !== null && age >= COLD_AFTER_DAYS ? "cold" : base;
}

/* ------------------------------------------------------------- the cadence */

/**
 * Two follow-ups, then stop. From CLAUDE.md, verbatim in intent:
 *
 *   "Cadence stops at two. Day 5, day 12, then done — never a third. Two
 *   unanswered messages is an answer, and keeping the relationship intact for a
 *   future warm intro is worth more than persistence."
 *
 * So three messages total — the first one and two nudges — and after that the
 * contact never appears in the owed list again, whatever else happens. This is
 * a hard stop in code rather than a note in a document, because a note is a rule
 * enforced by whoever remembers it.
 */
export const MAX_MESSAGES = 3;
export const NUDGE_AFTER_BUSINESS_DAYS = 5;
export const REPLY_WITHIN_DAYS = 2;
export const THANK_WITHIN_DAYS = 1;
export const REFERRAL_CHECK_AFTER_DAYS = 7;

/** The weekly target. Five. Same number as CLAUDE.md's contacts-per-week and a
 *  DIFFERENT NOUN: that one counts names added, this one counts messages sent.
 *  Both are stated in full wherever they are rendered, so the two fives can
 *  never be read as one number. */
export const MESSAGES_PER_WEEK = 5;

/**
 * How many people are worth knowing at one company before moving on.
 *
 * Two. One contact is a single point of failure — they change jobs, they never
 * reply, they turn out to be in a different part of the business — and the
 * fourth adds very little a referral needs. It is the number "Find 2 names" has
 * always said on the Companies page, and it now has somewhere to be counted
 * against: 0/2, 1/2, done.
 */
export const NAMES_PER_COMPANY = 2;

/**
 * What is owed today, and to whom.
 *
 * Deterministic, computed at page load, no stored task list — because a stored
 * one goes stale the moment an interaction is logged from somewhere else, and
 * then the page is telling you to chase somebody you already spoke to.
 *
 * Every rule reads the LATEST interaction only. "Sent a message and heard
 * nothing" is exactly "the newest row is an outreach_sent", and asking the
 * question that way means a reply logged later ends the obligation with no
 * separate bookkeeping.
 *
 * `contacts` arrive already carrying their own `interactions` array.
 */
export function owedFollowUps(contacts = [], now = new Date()) {
  const owed = [];
  for (const c of contacts) {
    const sorted = sortInteractions(c.interactions || []);
    const latest = sorted[0];
    if (!latest) continue;

    const sent = sorted.filter((i) => i.type === "outreach_sent").length;
    const days = daysSince(latest.occurred_at, now) ?? 0;
    // `resolve` is the interaction that DISCHARGES this obligation, so the
    // one-tap "Done" on the row logs what actually happened rather than
    // setting a done flag on a task that does not exist. There is no task
    // table here and there should not be one: an obligation is a consequence
    // of the history, so the only honest way to end it is to add to the
    // history. Ticking a box would leave the rule computing the same
    // obligation again on the next page load.
    const push = (what, why, template, resolve) =>
      owed.push({
        id: c.id,
        name: c.name,
        company: c.company,
        display_name: c.display_name || c.company,
        what,
        why,
        template,
        resolve,
        since: latest.occurred_at,
        days,
      });

    if (latest.type === "outreach_sent") {
      const bd = businessDaysSince(latest.occurred_at, now);
      // The hard stop. Not "deprioritised" — absent.
      if (sent < MAX_MESSAGES && bd >= NUDGE_AFTER_BUSINESS_DAYS) {
        push(`Nudge ${c.name}`,
             `${bd} working days since message ${sent} of ${MAX_MESSAGES}. One more, then stop.`,
             "follow_up", "outreach_sent");
      }
    } else if (latest.type === "reply_received" && days >= REPLY_WITHIN_DAYS) {
      push(`Reply to ${c.name}`,
           `They wrote back ${days} days ago and you have not answered.`,
           null, "outreach_sent");
    } else if (latest.type === "call_done" && days >= THANK_WITHIN_DAYS) {
      push(`Thank ${c.name}`,
           `You spoke ${days} days ago. A thank-you inside a day is the whole cost of keeping this warm.`,
           "thank_you", "thank_you_sent");
    } else if (latest.type === "referral_asked" && days >= REFERRAL_CHECK_AFTER_DAYS) {
      push(`Check in with ${c.name}`,
           `You asked for a referral ${days} days ago and heard nothing.`,
           "follow_up", "outreach_sent");
    }
  }
  // OLDEST FIRST. The thing that has been waiting longest is the thing about to
  // stop being retrievable; a newest-first list buries it under today's news.
  // Total, so two obligations from the same day cannot swap between loads.
  return owed.sort((a, b) => b.days - a.days
                          || String(a.name).localeCompare(String(b.name))
                          || String(a.id).localeCompare(String(b.id)));
}

/** Cap on how many are shown at once. Five is a session, twelve is a wall. */
export const OWED_SHOWN = 5;

/**
 * Warm relationships with nothing happening. Informational, never a task.
 *
 * Deliberately not in owedFollowUps: there is no action attached, and putting
 * "someone is going cold" in a list of things to do makes the list unfinishable.
 * A person going cold is either past their cadence — in which case the rule
 * above has already, correctly, stopped asking — or the ball is with them.
 */
export function goingCold(contacts = [], now = new Date()) {
  return contacts
    .filter((c) => {
      const latest = sortInteractions(c.interactions || [])[0];
      if (!latest) return false;
      if (derivedStatus(c.interactions, now) !== "cold") return false;
      return true;
    })
    .map((c) => {
      const latest = sortInteractions(c.interactions)[0];
      return { ...c, coldFor: daysSince(latest.occurred_at, now) };
    })
    .sort((a, b) => b.coldFor - a.coldFor
                 || String(a.name).localeCompare(String(b.name))
                 || String(a.id).localeCompare(String(b.id)));
}

/**
 * This week, in three numbers. Resets Monday.
 *
 * No streaks and no badges. An empty "0 of 5" on a Tuesday is its own
 * motivation, and a streak counter turns a missed week into a reason to stop
 * opening the page.
 */
export function weeklyPulse(contacts = [], now = new Date()) {
  const start = weekStart(now).getTime();
  let sent = 0;
  let replies = 0;
  let calls = 0;
  for (const c of contacts) {
    for (const i of c.interactions || []) {
      const d = dayOf(i.occurred_at);
      if (!d || d.getTime() < start) continue;
      if (i.type === "outreach_sent") sent++;
      else if (i.type === "reply_received") replies++;
      else if (i.type === "call_scheduled" || i.type === "call_done") calls++;
    }
  }
  return { sent, replies, calls, target: MESSAGES_PER_WEEK, since: weekStart(now) };
}

/* ------------------------------------------------------ the referral shield */

/**
 * Companies where applying without a referral in motion is worth one question.
 *
 * NOT every company, and that is the whole design. An interruption on every
 * application is a dialog you learn to dismiss without reading, which is worth
 * less than no dialog at all — the same failure as the nag you cannot answer.
 *
 * These four are named in CLAUDE.md as tier-1 defense targets and they are the
 * places where the screen this routes around is hardest: no CS degree, and a
 * clearance he cannot hold until an employer sponsors it. Anything scoring
 * Excellent joins them, because a top-band role is worth one question whoever
 * posted it.
 */
export const SHIELD_COMPANIES = new Set([
  "palantir", "andurilindustries", "saronic", "shieldai",
]);

/**
 * Should applying to this role stop and ask first?
 *
 * `referral` is true when SOMEBODY at that company has been asked or has
 * already put him forward — either counts, because the point is whether a
 * referral is in motion, not whether it has landed.
 *
 * Returns false when there is nothing to say. NEVER blocks: the caller shows a
 * question with "Apply anyway" as a first-class answer, and the answer sticks
 * because the role then reads as applied.
 */
export function needsReferralCheck({ company, band, referral } = {}) {
  if (referral) return false;
  return SHIELD_COMPANIES.has(company) || band === "Excellent";
}

/* ------------------------------------------------------- names and companies */

/**
 * A name out of a LinkedIn profile URL, so pasting a link is enough to start a
 * record.
 *
 * Deterministic and dumb on purpose: split the slug, drop the trailing hash
 * LinkedIn appends, title-case what is left. It is a STARTING POINT that lands
 * in an editable field, never a claim — "jane-doe-8a41b2" becomes "Jane Doe"
 * and the field is right there to fix.
 *
 * This reads a string the user pasted. It does not fetch the URL, and nothing
 * in this repository ever will: CLAUDE.md rule 2 says never scrape LinkedIn,
 * and its terms prohibit it.
 */
export function nameFromLinkedIn(url) {
  const m = String(url || "").match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  const parts = decodeURIComponent(m[1])
    .split("-")
    // LinkedIn's disambiguating suffix is hex-ish and never a name.
    .filter((p) => p && !/^[0-9a-f]{4,}$/i.test(p) && !/^\d+$/.test(p));
  if (!parts.length) return null;
  return parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

/** True when the string looks like a LinkedIn profile link rather than a name. */
export function looksLikeLinkedIn(s) {
  return /linkedin\.com\/in\//i.test(String(s || ""));
}

/**
 * What the one-action add form on Companies sends, or null if it cannot yet.
 *
 * Two boxes — a name and a LinkedIn link — and one button. A link pasted into
 * the name box is turned into a name and moved to the link (string work, no
 * fetch: rule 2). A link without a scheme gets one, because the API refuses a
 * bare "linkedin.com/in/x" and the row would otherwise carry a dead anchor.
 * Everything else is fixed here rather than typed, so the form cannot send a
 * field the route will refuse. Pure, so the rule is tested without a browser.
 */
export function quickAddPayload({ name, link, company } = {}) {
  let n = String(name || "").trim();
  let l = String(link || "").trim();
  const co = String(company || "").trim();
  if (looksLikeLinkedIn(n)) {
    if (!l) l = n;
    n = nameFromLinkedIn(n) || "";
  }
  if (!n || !co) return null;
  if (l && !/^https?:\/\//i.test(l)) l = "https://" + l;
  return {
    action: "add", name: n, company: co, linkedin_url: l || null,
    source: l ? "linkedin" : "alumni_directory", warmth: "cold",
  };
}

/* ----------------------------------------------------------- the templates */

/**
 * Four templates, assembled with merge fields. NO MODEL, and that is a
 * requirement rather than a cost saving.
 *
 * A model writing these would produce warmth it has no basis for — "I've been
 * following your work on X" about a person the owner has never read — which is
 * the exact thing CLAUDE.md forbids, on the one surface where a real person
 * reads the output. A template can only say what its fields hold.
 *
 * What every one of these does say: a shared institution stated plainly, who
 * is writing and when they graduate, and one small specific answerable
 * question. What none of them says: flattery, implied familiarity, "I hope
 * this finds you well", or "I would love to connect and learn more about
 * opportunities" — which gets no replies and is the reason the ask is a
 * QUESTION in all four.
 *
 * NO CREDENTIAL IS SHIPPED IN THE WORDING. The original named the owner's
 * product and its numbers; a template cannot know what the next owner has
 * built, and rule 4 forbids inventing it. The owner adds their own one-line
 * credential by editing the template on the People page, where the override
 * is stored.
 *
 * {shared_hook} is the only free field and it is optional. It exists so the
 * owner can state a real link in their own words; the default text says
 * nothing rather than inventing something.
 */
export const TEMPLATE_FIELDS = ["first_name", "company", "role_title",
                                "role_fact", "shared_hook"];

/**
 * The owner's own merge fields, filled from the baked profile at render time
 * so a caller never has to pass them and an override can never leave them
 * blank. A caller MAY pass any of them to override (tests do).
 */
export const OWNER_FIELDS = [
  "owner_first_name", "owner_name", "owner_school", "owner_class_label",
  "owner_class_year", "owner_graduation", "owner_start_season",
];

export function ownerFields(owner = OWNER, prefs = PREFS) {
  return {
    owner_first_name: owner.firstName,
    owner_name: owner.name,
    owner_school: owner.schoolShort,
    owner_class_label: owner.classLabel,
    owner_class_year: String(owner.classYear),
    owner_graduation: owner.graduation,
    owner_start_season: prefs?.canStartSeason || "summer",
  };
}

/**
 * One concrete, checkable detail from the posting, as a WHOLE SENTENCE.
 *
 * "One concrete thing" is the discipline, and a cold note naming a specific
 * requisition reads differently from one about the company in general: it
 * says he is asking about a JOB, not asking for one.
 *
 * DERIVED, NEVER WRITTEN. Location and title come straight off the row, so
 * the sentence is true by construction. No model touches it -- a model asked
 * for "something concrete about the role" produces plausible detail, and
 * plausible detail about a stranger's job is exactly what CLAUDE.md forbids
 * on the one surface where a real person reads it.
 *
 * A WHOLE SENTENCE, not a clause, because the field is often EMPTY -- both
 * Palantir contacts have no location on file today. Wrapped in punctuation
 * ("{company} - {role_fact} - is...") an empty value leaves "- -" sitting in
 * a note to a real person; renderTemplate collapses double spaces but cannot
 * know that the dashes around a cut field should go too. A standalone
 * sentence just disappears.
 *
 * ONE POSTING CAN LIST MANY CITIES, joined with "; " by fetch_jobs -- nine of
 * them in one 331-character string put a scrollbar across Daily once. The
 * first is named and the rest counted, because "the Washington, DC one" is
 * the useful half and a nine-city list in a cold email is noise.
 */
export function roleFactOf(job) {
  if (!job) return "";
  const parts = String(job.location || "")
    .split(";").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) {
    return `I am looking at the ${parts[0]} posting specifically.`;
  }
  return `I am looking at the ${parts[0]} posting specifically, one of `
    + `${parts.length} locations it is listed in.`;
}

/**
 * The ONE role to write to this person about, and why.
 *
 * NOT A DROPDOWN. A picker asks the owner to make a choice the data can already
 * make, on a page whose whole job is "what should I do right now" -- and
 * the cadence makes the choice nearly irreversible anyway: two messages per
 * person, ever, so there is one real slot, not twelve. Offering twelve
 * options for one slot is the interface implying a freedom that does not
 * exist.
 *
 * HIGHEST SCORE AMONG REACHABLE, tie-broken on key so the recommendation
 * cannot change between two renders of the same page. Palantir has eight
 * roles at exactly 78; without the tie-break the row would name a different
 * one each time it loaded, which reads as the tool changing its mind.
 *
 * THE REASON IS RENDERED, not just computed. A recommendation whose basis is
 * invisible is one the owner has to either trust blindly or re-derive by hand,
 * and they can override it on the row -- so the line has to say enough to
 * disagree with.
 */
export function recommendRole(roles = []) {
  const list = [...roles].sort(
    (a, b) => (b.score ?? -1) - (a.score ?? -1)
           || String(a.key).localeCompare(String(b.key)));
  return list[0] || null;
}

/**
 * Why that role, in one line. Says the population out loud.
 *
 * "Two numbers on one row must come from one population": the rank and the
 * total both count REACHABLE roles, never all open ones. Palantir has 310
 * open and 12 reachable, and "best of 310" would be a different, false
 * claim about a list that was never considered.
 */
export function recommendReason(role, roles = []) {
  if (!role) return "";
  const n = roles.length;
  const scored = roles.filter((r) => r.score != null).length;
  const where = String(role.location || "").split(";")[0].trim();
  const bits = [];
  if (role.score != null && scored > 1) {
    bits.push(`best fit of ${n} reachable ${n === 1 ? "role" : "roles"} `
      + `here (${role.score})`);
  } else if (n > 1) {
    bits.push(`one of ${n} reachable roles here`);
  } else {
    bits.push("the only reachable role here");
  }
  if (where) bits.push(where);
  return bits.join(", ");
}

/**
 * A role title short enough for a 300-character box.
 *
 * Boards write compound titles with their own separator:
 *   "Forward Deployed Software Engineer - US Government - Federal Health"
 * so the head of the title is the role and the tail is the posting's
 * sub-team. Cutting at the board's own separator gives a shorter title that
 * is still the role's real name, which is why this shortens the TITLE and
 * never the prose -- trimming the sentence would cut the question, and the
 * question is the only part that can earn a reply.
 *
 * Measured over every reachable role at the eight companies with contacts:
 * 15 of 256 notes exceeded 300 characters, the worst at 316. A template
 * that fits the common case and silently overflows the rest is the bug
 * LinkedIn makes invisible -- it truncates without warning, so the note
 * arrives cut off mid-sentence and nothing says so.
 */
export function shortTitle(title, max = 64) {
  const t = String(title || "").trim();
  if (t.length <= max) return t;
  // The board's own separators, longest first, then a comma.
  for (const sep of [" - ", " \u2013 ", " \u2014 ", ", "]) {
    const head = t.split(sep)[0].trim();
    if (head && head.length <= max) return head;
  }
  // Nothing to cut at: fall back to whole words, never mid-word.
  const words = t.split(/\s+/);
  let out = "";
  for (const w of words) {
    if ((out + " " + w).trim().length > max) break;
    out = (out + " " + w).trim();
  }
  return out || t.slice(0, max);
}

/**
 * The LinkedIn note, guaranteed to fit.
 *
 * Shortens the title only as far as it must, so the common case keeps the
 * full one. Returns the text and what it had to give up, because a caller
 * that cannot tell whether it was shortened cannot show the owner that it was.
 */
export function linkedinNote(fields = {}, { limit = LINKEDIN_LIMIT } = {}) {
  const body = fields.body || TEMPLATE_BY_KEY.linkedin_note.body;
  const full = String(fields.role_title || "");
  for (const max of [200, 64, 48, 36, 28]) {
    const title = shortTitle(full, max);
    const text = renderTemplate(body, { ...fields, role_title: title,
                                         role_fact: "" });
    if (text.length <= limit) {
      return { text, title, shortened: title !== full, over: false };
    }
  }
  // Every shortening tried and it still does not fit. Say so rather than
  // hand back something LinkedIn will cut: the caller renders the warning,
  // and the owner edits. Silently over-length is the one outcome not allowed.
  const title = shortTitle(full, 28);
  const text = renderTemplate(body, { ...fields, role_title: title,
                                      role_fact: "" });
  return { text, title, shortened: true, over: text.length > limit };
}

export const TEMPLATES = [
  {
    key: "alum_cold",
    label: "Alum, cold",
    when: "They went to your school and you have never spoken.",
    body: `Hi {first_name}, I'm {owner_first_name}, class of {owner_class_year}. We both went to {owner_school}, which is the only reason I'm in your inbox.

I'm trying to work out whether {role_title} at {company} is the right place to start out after graduating. {role_fact}

Would you have 15 minutes in the next couple of weeks to tell me what that work is actually like day to day?

Thanks either way,
{owner_first_name}`,
  },
  {
    key: "recruiter",
    label: "Recruiter or university recruiting",
    when: "They hire for the programme rather than work in it.",
    body: `Hi {first_name}, I'm {owner_name}, {owner_school}, graduating {owner_graduation} and looking at full-time {role_title} roles starting {owner_start_season} {owner_class_year}.

Two questions, both quick: when does {company} open its {owner_class_year} full-time applications, and is there anything you'd want to see from a candidate before then?

Thanks,
{owner_first_name}`,
  },
  {
    key: "practitioner",
    label: "Engineer or PM at the company",
    when: "They do the job. Lead with the question, not the ask.",
    body: `Hi {first_name}, {owner_first_name} here, a {owner_school} {owner_class_label} graduating {owner_graduation}.

I'm trying to understand {role_title} at {company} from someone who actually does it rather than from the posting. {role_fact} The thing I can't tell from outside: how much of the week goes on customers versus the codebase, and what separates the people who do it well from the people who are fine at it?

If you have 15 minutes in the next couple of weeks I'd take them. If not, even a one-line answer to that question would help.

{owner_first_name}`,
  },
  {
    key: "deployment",
    label: "Deployment strategist / forward-deployed",
    when: "They do the Palantir-shaped deployment job. The gap IS the question.",
    body: `Hi {first_name}, {owner_first_name} here, {owner_school}, class of {owner_class_year}. No connection between us; I'm writing because you do the job I'm trying to understand. {shared_hook}

What a posting cannot tell me is what it is like to work inside a customer's operation, against their constraints, which is the part of {role_title} at {company} I most want to understand. {role_fact}

So: in a normal week, how much of it is understanding the customer's problem versus building against it; and which of the two do people underestimate?

{owner_first_name}`,
  },
  {
    key: "follow_up",
    label: "Follow-up, no reply",
    when: "Five working days on. Two of these, then stop.",
    body: `Hi {first_name}, following up once on the note below.

Still the same one question: what is {role_title} at {company} actually like week to week?

If it's not a good time, no reply needed at all and I won't chase it further.

{owner_first_name}`,
  },
  {
    key: "linkedin_note",
    label: "LinkedIn connection note",
    when: "The 300-character box on a connection request. Under it, or it is silently truncated.",
    // LINKEDIN'S BOX IS 300 CHARACTERS AND IT DOES NOT WARN. A note written
    // at cold-email length arrives cut off mid-sentence, which reads worse
    // than sending nothing. So this is not the full note trimmed: it keeps
    // only the three things that have to survive -- who the owner is, which
    // role, one answerable question.
    //
    // {role_fact} is deliberately NOT in it. The location sentence is the
    // first thing worth losing at this length, and a template that only
    // fits when a field happens to be empty is one that breaks the day the
    // field is filled. testLength below asserts the worst case, not this one.
    body: `Hi {first_name}, I'm {owner_first_name}, {owner_school} {owner_class_year}. I'm trying to understand {role_title} at {company} from someone who does it: in a normal week, how much is the customer versus the code?`,
  },
  {
    key: "thank_you",
    label: "Thank-you after a call",
    when: "Inside a day. This is the whole cost of staying memorable.",
    body: `{first_name}, thank you for the time today. {shared_hook}

I'll do the thing we talked about and let you know how it goes.

{owner_first_name}`,
  },
];

/**
 * LinkedIn's connection-note limit. It truncates SILENTLY at 300, so a
 * note over it is delivered cut off and nobody is told.
 */
export const LINKEDIN_LIMIT = 300;

export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);
export const TEMPLATE_BY_KEY = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));

/**
 * Fill a template.
 *
 * An UNKNOWN field is cut rather than left as a placeholder, and that is the
 * hard rule from CLAUDE.md applied to a different surface: no square-bracket
 * marker and no "{company}" ever reaches an output a human reads. If the value
 * is missing the sentence has to survive without it, which is why every
 * template reads correctly with {shared_hook} empty.
 *
 * Cleans up the whitespace a removed field leaves behind, so a cut never shows
 * as a double space or a line with a full stop hanging off it.
 */
export function renderTemplate(body, fields = {}) {
  let out = String(body || "");
  // The owner's fields first, from the baked profile, so a template can never
  // go out unsigned; a caller's value for one of them wins.
  const all = { ...ownerFields(), ...fields };
  for (const f of [...OWNER_FIELDS, ...TEMPLATE_FIELDS]) {
    const v = (all[f] ?? "").toString().trim();
    out = out.split(`{${f}}`).join(v);
  }
  // Anything left is a field this function does not know about. Cut it too — a
  // brace reaching a real person's inbox is worse than a slightly shorter note.
  out = out.replace(/\{[a-z_]+\}/gi, "");
  return out
    // A DASH NEVER LEAVES THIS FUNCTION. The shipped templates have none;
    // this catches an override the owner pasted in from elsewhere. Replaced
    // with a comma and a space, then the whitespace pass below tidies up,
    // which is exactly what apply_packs._clean does to a pack.
    .replace(DASHES, ",")
    .replace(/,\s*,/g, ",")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+([.,;:?!])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Dashes that must never reach a person. Em, en, and the horizontal bar.
 *
 * SAME RULE AS THE PACKS, on the same reasoning: apply_packs._clean strips
 * them in code rather than asking a model not to produce them, because
 * asking works most of the time and stripping works every time. The owner
 * does not write them, so a dash in an outgoing note is a tell that a
 * machine did.
 *
 * THE TEMPLATES ARE WRITTEN WITHOUT THEM rather than cleaned afterwards, so
 * the shipped wording reads the way it will send. This gate exists for the
 * OTHER path: the owner can override any template from the People page, and an
 * override is free text that may well be pasted in from somewhere else.
 */
const DASHES = /[\u2014\u2013\u2015]/g;

/** The offending dash and where, or null. Null means it is clean. */
export function dashClaim(text) {
  const i = String(text || "").search(DASHES);
  if (i < 0) return null;
  return String(text).slice(Math.max(0, i - 24), i + 25);
}
/** The first name, for {first_name}. "Jane Doe" -> "Jane". */
export function firstNameOf(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

/* --------------------------------------------------------- conversation prep */

/**
 * What to ask, by role family. Static, written once, editable later.
 *
 * A model could generate these and it would cost money to do it worse: the
 * questions worth asking a deployment strategist are the same every time, and
 * the ones a model invents drift toward the generic — "what does a typical day
 * look like" — which is the question that gets a brochure answer.
 *
 * Each bank ends with the ASK LADDER, and it is the same three lines every
 * time, because the sequencing is what people get wrong: insight first, and a
 * referral only after there is a reason for one.
 */
export const ASK_LADDER = [
  "Ask for insight, not a job. The first conversation buys you a second one.",
  "Only ask for a referral once they have said something that makes you a better fit than they expected.",
  "Close with something small and specific you will do, then actually do it and tell them.",
];

export const PREP_BANKS = [
  {
    key: "deployment",
    label: "Deployment Strategist / forward-deployed",
    questions: [
      "What does a deployment actually look like week to week — how much is with the customer, how much is in the code?",
      "How long is it before a new grad is in front of a customer on their own?",
      "Who has done well on your team without a CS degree, and what did they turn out to be good at?",
      "What separates the people who get a return offer from the ones who do not?",
      "How much of the job is picking which problem to solve versus solving the one you are handed?",
      "What is the failure mode for someone who is technical enough but not commercial enough — or the other way round?",
      "What would you want to see from someone applying this cycle that most applicants do not show you?",
    ],
  },
  {
    key: "apm",
    label: "APM / product",
    questions: [
      "How is the programme structured — rotations, or one team for the whole term?",
      "What does a new grad actually own in the first six months? A feature, a surface, a metric?",
      "How do you evaluate product sense in the interview, concretely — what does a good answer sound like?",
      "How much of the job is writing versus meetings versus data?",
      "What does the APM cohort do after the programme, in practice rather than on the careers page?",
      "Does having shipped and charged for my own product help here, or is it neutral?",
      "What is the most common reason someone does not convert at the end?",
    ],
  },
  {
    key: "defense_ops",
    label: "Defense operations / mission ops",
    questions: [
      "What does mission ops mean at this company specifically? The title covers very different jobs across the industry.",
      "How does clearance sponsorship actually work here — when in the process does it start, and how long does it take in practice?",
      "How much of the role is in the field or on site versus at a desk?",
      "Who do you work with most — engineering, the customer, programme management?",
      "What is the balance between running an existing process and building one that does not exist yet?",
      "What does someone need to know about the defense customer that you cannot learn from outside?",
      "What would make you say a new grad was doing well after six months?",
    ],
  },
  {
    key: "vc",
    label: "VC / growth analyst",
    questions: [
      "What does sourcing actually look like day to day — inbound triage, cold outreach, thesis work?",
      "What do you read every week that I should be reading?",
      "How do you evaluate someone who has run their own small company rather than done two years of banking?",
      "How much of the analyst job is diligence versus finding things?",
      "What does the analyst who gets asked to stay do differently?",
      "How much writing is there, and who reads it?",
      "What is the honest downside of coming in as an analyst without a finance-programme background?",
    ],
  },
];

export const PREP_BY_KEY = Object.fromEntries(PREP_BANKS.map((b) => [b.key, b]));

/**
 * Which bank fits a role title. Deterministic keyword match, first hit wins.
 *
 * Returns null rather than a default when nothing matches, and the UI then
 * shows the four banks to choose from. A wrong bank is worse than no bank: it
 * would put "how does clearance sponsorship work" in front of a VC analyst.
 */
const FAMILY_PATTERNS = [
  ["deployment", /\b(deployment strategist|forward.deployed|fdse|solutions architect|implementation)\b/i],
  ["vc", /\b(investment|venture|growth equity|private equity|analyst,? (client|financial)|associate,? investment)\b/i],
  ["defense_ops", /\b(mission ops|mission operations|defense|defence|national security|government|intelligence)\b/i],
  ["apm", /\b(product manager|apm|associate product|product ops|product operations|rotational product)\b/i],
];

export function roleFamilyOf(title) {
  const t = String(title || "");
  for (const [key, re] of FAMILY_PATTERNS) if (re.test(t)) return key;
  return null;
}
