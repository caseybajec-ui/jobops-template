/**
 * The networking rules. Run: node test_people.mjs
 *
 * lib/people.js is pure, so all of this runs against fixed dates with no
 * database — which is the point: the rules that decide whether to chase a real
 * person have to be checkable without waiting five business days to see.
 *
 * The two assertions that matter most, and why:
 *
 *   THE CADENCE STOPS AT TWO. CLAUDE.md: "Day 5, day 12, then done — never a
 *   third. Two unanswered messages is an answer." A tool that keeps suggesting
 *   one more message will eventually get one sent, so the stop is checked in
 *   both directions: it must still offer at two, and must never offer at three.
 *
 *   NO BRACE REACHES A HUMAN. renderTemplate cuts an unknown field rather than
 *   leaving it. This is CLAUDE.md's "never emit a bracket" rule on the one
 *   surface where the output is read by someone who is not the owner, and the test
 *   asserts it over every shipped template with every field empty.
 */
import {
  businessDaysSince, daysSince, weekStart, derivedStatus, sortInteractions,
  owedFollowUps, goingCold, weeklyPulse, nameFromLinkedIn, looksLikeLinkedIn,
  renderTemplate, firstNameOf, roleFamilyOf, TEMPLATES, TEMPLATE_FIELDS,
  PREP_BANKS, ASK_LADDER, INTERACTION_KEYS, STATUS_LABEL, STATUS_ORDER,
  MAX_MESSAGES, NUDGE_AFTER_BUSINESS_DAYS, COLD_AFTER_DAYS, MESSAGES_PER_WEEK,
  SOURCE_KEYS, SOURCE_LABEL, quickAddPayload, roleFactOf, TEMPLATE_BY_KEY,
  TEMPLATE_KEYS, dashClaim, recommendRole, recommendReason, linkedinNote,
  shortTitle, LINKEDIN_LIMIT, OWNER_FIELDS, ownerFields,
} from "./lib/people.js";
// The SAME gate the packs use. A cold note to a stranger at a defense
// company is the last place to assert an adjudication nobody has made.
import { forbiddenClaim } from "./lib/clearance.js";
import {
  schoolPeopleSearchUrl, SCHOOL_LINKEDIN_ALUMNI, SCHOOL_SEARCH_PREFIX, OWNER,
} from "./lib/constants.js";
import { PREFS } from "./lib/config.generated.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

// A fixed Wednesday. Every date below is relative to it, so the suite does not
// change behaviour depending on which day it is run.
const WED = new Date("2026-09-16T12:00:00Z");

/* ------------------------------------------------------------- the calendar */

eq(daysSince("2026-09-16", WED), 0, "today is zero days ago");
eq(daysSince("2026-09-09", WED), 7, "a week ago is seven days");
eq(daysSince(null, WED), null, "no date is not zero days ago");

// The whole reason business days exist here. A message sent on Friday the 11th
// has had FIVE working days by Friday the 18th, not by Wednesday the 16th —
// counting calendar days would nudge everyone two days early, every single time
// a message goes out late in the week.
eq(businessDaysSince("2026-09-11", WED), 3,
   "Fri 11 -> Wed 16 is 3 working days, not 5 calendar days");
eq(businessDaysSince("2026-09-11", new Date("2026-09-18T12:00:00Z")), 5,
   "Fri 11 -> Fri 18 is exactly 5 working days");
eq(businessDaysSince("2026-09-14", WED), 2, "Mon 14 -> Wed 16 is 2 working days");
eq(businessDaysSince("2026-09-16", WED), 0, "same day is zero");
eq(businessDaysSince("2026-09-20", WED), 0, "a future date is zero, never negative");

// Weeks start Monday, and Sunday belongs to the week just ending rather than
// resetting the count the day before the owner would look at it.
eq(weekStart(WED).toISOString().slice(0, 10), "2026-09-14", "Wednesday's week starts Monday");
eq(weekStart(new Date("2026-09-14T00:30:00Z")).toISOString().slice(0, 10), "2026-09-14",
   "Monday is its own week start");
eq(weekStart(new Date("2026-09-20T23:00:00Z")).toISOString().slice(0, 10), "2026-09-14",
   "Sunday still belongs to the week that just ended");

/* --------------------------------------------------------------- the status */

const ix = (type, occurred_at, id = `ix:${type}-${occurred_at}`) =>
  ({ id, type, occurred_at, contact_id: "p:1" });

eq(derivedStatus([], WED), "to_contact", "nobody messaged them yet");
eq(derivedStatus([ix("outreach_sent", "2026-09-15")], WED), "waiting", "sent, nothing back");
eq(derivedStatus([ix("reply_received", "2026-09-15")], WED), "in_conversation", "they replied");
eq(derivedStatus([ix("call_done", "2026-09-15")], WED), "in_conversation", "had the call");
eq(derivedStatus([ix("referral_asked", "2026-09-15")], WED), "referral_asked", "asked for one");
eq(derivedStatus([ix("referral_received", "2026-09-15")], WED), "referred", "they referred you");

// LATEST wins, and "latest" is by date and not by array order — the rows come
// back from the database in whatever order it likes.
eq(derivedStatus([ix("reply_received", "2026-09-15"), ix("outreach_sent", "2026-09-10")], WED),
   "in_conversation", "the newest interaction decides, whatever order they arrive in");
eq(derivedStatus([ix("outreach_sent", "2026-09-10"), ix("reply_received", "2026-09-15")], WED),
   "in_conversation", "and the same the other way round");

// Cold is about elapsed time, not about an event.
eq(derivedStatus([ix("outreach_sent", "2026-08-01")], WED), "cold",
   `nothing for ${COLD_AFTER_DAYS}+ days is cold`);
// ...except a referral, which is not a relationship going stale. It delivered.
eq(derivedStatus([ix("referral_received", "2026-01-01")], WED), "referred",
   "a referral from January is still a referral, not a cold contact");

ok(STATUS_ORDER.every((s) => STATUS_LABEL[s]), "every status has a label to render");

/* ------------------------------------------------------------- what is owed */

const person = (id, name, interactions) =>
  ({ id, name, company: "palantir", display_name: "Palantir", interactions });

// Rule 1: a message with no reply, after five WORKING days.
{
  const early = owedFollowUps([person("p:1", "Ana", [ix("outreach_sent", "2026-09-14")])], WED);
  eq(early.length, 0, "two working days in, nothing is owed yet");

  const due = owedFollowUps(
    [person("p:1", "Ana", [ix("outreach_sent", "2026-09-08")])], WED);
  eq(due.length, 1, "six working days in, a nudge is owed");
  eq(due[0].what, "Nudge Ana", "and it says who and what");
  eq(due[0].template, "follow_up", "and which template writes it");
}

// THE HARD STOP, in both directions. This is the assertion that keeps a real
// person from getting a fourth message.
{
  const twoSent = [ix("outreach_sent", "2026-08-20", "ix:a"),
                   ix("outreach_sent", "2026-09-04", "ix:b")];
  eq(owedFollowUps([person("p:1", "Ana", twoSent)], WED).length, 1,
     `after ${MAX_MESSAGES - 1} messages a nudge is still offered`);

  const threeSent = [...twoSent, ix("outreach_sent", "2026-09-07", "ix:c")];
  eq(owedFollowUps([person("p:1", "Ana", threeSent)], WED).length, 0,
     `after ${MAX_MESSAGES} messages nothing is EVER owed again — the cadence stops at two follow-ups`);
}

// Rule 2: they wrote back and nobody answered.
eq(owedFollowUps([person("p:1", "Ben", [ix("reply_received", "2026-09-13")])], WED)[0]?.what,
   "Reply to Ben", "an unanswered reply after two days is owed");
eq(owedFollowUps([person("p:1", "Ben", [ix("reply_received", "2026-09-16")])], WED).length, 0,
   "a reply that arrived today is not yet overdue");

// Rule 3: the thank-you, which costs nothing and is the whole of staying memorable.
eq(owedFollowUps([person("p:1", "Cal", [ix("call_done", "2026-09-15")])], WED)[0]?.what,
   "Thank Cal", "a call yesterday with no thank-you is owed");
eq(owedFollowUps([person("p:1", "Cal",
     [ix("call_done", "2026-09-15"), ix("thank_you_sent", "2026-09-15", "ix:t")])], WED).length, 0,
   "and it stops the moment the thank-you is logged");

// Rule 4: a referral asked for and never mentioned again.
eq(owedFollowUps([person("p:1", "Dee", [ix("referral_asked", "2026-09-01")])], WED)[0]?.what,
   "Check in with Dee", "a referral asked two weeks ago is owed a check-in");
eq(owedFollowUps([person("p:1", "Dee", [ix("referral_asked", "2026-09-14")])], WED).length, 0,
   "but not after two days");

// Nothing is owed to somebody nobody has contacted. There is no interaction to
// measure from, and "you have not messaged them" is a different section.
eq(owedFollowUps([person("p:1", "Eve", [])], WED).length, 0,
   "a contact with no history owes nothing — that is the To contact list, not this one");

// OLDEST FIRST. The thing waiting longest is the one about to stop being
// retrievable; newest-first buries it under today's news.
{
  const list = owedFollowUps([
    person("p:1", "New", [ix("reply_received", "2026-09-13", "ix:n")]),
    person("p:2", "Old", [ix("reply_received", "2026-08-25", "ix:o")]),
  ], WED);
  eq(list.map((o) => o.name), ["Old", "New"], "owed items come oldest first");
}

/* -------------------------------------------------------------- going cold */

{
  const cold = goingCold([
    person("p:1", "Stale", [ix("outreach_sent", "2026-08-01")]),
    person("p:2", "Fresh", [ix("outreach_sent", "2026-09-15")]),
    person("p:3", "Helped", [ix("referral_received", "2026-01-01")]),
  ], WED);
  eq(cold.map((c) => c.name), ["Stale"],
     "only the stale one is going cold — a referral is done, not cooling");
  ok(cold[0].coldFor >= COLD_AFTER_DAYS, "and it says how long it has been");
}

/* ------------------------------------------------------------- weekly pulse */

{
  const p = weeklyPulse([
    person("p:1", "A", [ix("outreach_sent", "2026-09-15"), ix("outreach_sent", "2026-09-11", "ix:x")]),
    person("p:2", "B", [ix("reply_received", "2026-09-16"), ix("call_scheduled", "2026-09-14", "ix:y")]),
  ], WED);
  // Mon 14 onwards only: the 15th and the 16th and the 14th count, the 11th
  // (previous Friday) does not.
  eq({ sent: p.sent, replies: p.replies, calls: p.calls }, { sent: 1, replies: 1, calls: 1 },
     "the pulse counts this week only and resets on Monday");
  eq(p.target, MESSAGES_PER_WEEK, "against a stated target");
}

/* ------------------------------------------------------------ pasted links */

eq(nameFromLinkedIn("https://www.linkedin.com/in/jane-doe-8a41b2/"), "Jane Doe",
   "a pasted profile URL is enough to start a record");
eq(nameFromLinkedIn("linkedin.com/in/marcus-oconnell"), "Marcus Oconnell",
   "without the scheme too");
eq(nameFromLinkedIn("https://example.com/jane"), null,
   "anything that is not a profile URL gives nothing rather than a wrong name");
ok(looksLikeLinkedIn("https://www.linkedin.com/in/x"), "and the form can tell which it was handed");
ok(!looksLikeLinkedIn("Jane Doe"), "a plain name is a plain name");

/* -------------------------------------------------------------- templates */

eq(firstNameOf("Jane Doe"), "Jane", "the merge field takes the first name");
eq(firstNameOf(""), "", "and an empty name is empty, not undefined");

// NO BRACE REACHES A HUMAN. Every shipped template, rendered with NOTHING
// filled in, must still be sendable prose. This is "never emit a bracket" on
// the one surface a stranger reads.
for (const t of TEMPLATES) {
  const bare = renderTemplate(t.body, {});
  ok(!/[{}]/.test(bare), `${t.key} leaves no brace behind when every field is empty`);
  // Per LINE. Written first as a check over the whole body with newlines mapped
  // to spaces, which reported every template as broken: a paragraph break is
  // "\n\n" and became two spaces. The thing being guarded against is a gap
  // INSIDE a sentence where a field was cut, and that is always within a line.
  ok(bare.split("\n").every((l) => !/ {2,}/.test(l)),
     `${t.key} has a double space inside a line where a field was cut out`);
  ok(bare.length > 80, `${t.key} is still a real message with nothing filled in`);
  ok(!/hope this finds you well|following your work|love to connect/i.test(t.body),
     `${t.key} contains no manufactured warmth`);
  // The thank-you is exempt, and only the thank-you: it is the one template
  // that is not an ask. Every template that IS an ask has to end in something
  // answerable — "I'd love to connect and learn more about opportunities" gets
  // no replies, and a question is the difference.
  if (t.key !== "thank_you") {
    ok(/\?/.test(t.body), `${t.key} asks no actual question, which is what gets replies`);
  }
}

eq(renderTemplate("Hi {first_name} at {company}.", { first_name: "Ana", company: "Palantir" }),
   "Hi Ana at Palantir.", "fields are substituted");
eq(renderTemplate("Hi {first_name}. {unknown_field} Thanks.", { first_name: "Ana" }),
   "Hi Ana. Thanks.", "an unknown field is CUT, never left as a placeholder");

ok(TEMPLATES.length >= 4, "all four templates ship");
ok(TEMPLATE_FIELDS.every((f) => TEMPLATES.some((t) => t.body.includes(`{${f}}`))),
   "every merge field is actually used by at least one template");

/* ------------------------------------------------------------------- prep */

eq(roleFamilyOf("Deployment Strategist - US Government"), "deployment", "FDSE-track titles");
eq(roleFamilyOf("Forward Deployed Software Engineer"), "deployment", "and the long form");
eq(roleFamilyOf("Associate Product Manager, New Grad (2027 Start)"), "apm", "APM titles");
eq(roleFamilyOf("Mission Operations Specialist"), "defense_ops", "defense ops titles");
eq(roleFamilyOf("Full Time Analyst 2027"), null,
   "an ambiguous title returns null so the UI offers all four — a WRONG bank would put clearance questions in front of a VC analyst");

for (const b of PREP_BANKS) {
  ok(b.questions.length >= 6 && b.questions.length <= 8,
     `${b.key} has 6-8 questions, got ${b.questions.length}`);
  // Contains a question, rather than ends with one: several of these are a
  // question plus a clarifying sentence ("The title covers very different jobs
  // across the industry"), and the clarifier is the useful half.
  ok(b.questions.every((q) => q.includes("?")), `${b.key}: every line actually asks something`);
  ok(!b.questions.some((q) => /\{|\[/.test(q)), `${b.key}: no placeholders`);
}
eq(ASK_LADDER.length, 3, "the ask ladder is three lines");
ok(/referral/i.test(ASK_LADDER[1]), "and the middle one is when to ask for the referral");

ok(INTERACTION_KEYS.length === 7, "seven kinds of thing can happen with a person");

/* ------------------------------------------------------- positive control */

// Prove the cadence assertion above can fail. If MAX_MESSAGES were ignored, a
// fourth message would be offered; assert directly that the rule is what stops
// it, rather than trusting that the earlier eq() is exercising anything.
{
  const four = Array.from({ length: 4 }, (_, i) =>
    ix("outreach_sent", "2026-09-0" + (1 + i), "ix:" + i));
  const stillNothing = owedFollowUps([person("p:1", "Ana", four)], WED);
  ok(stillNothing.length === 0,
     "control: four messages sent and the tool STILL suggests another — the cadence stop is not working");
  // ...and the mirror: one message, long enough ago, definitely does produce one,
  // so "length === 0" above is not simply what this function always returns.
  const one = owedFollowUps([person("p:1", "Ana", [ix("outreach_sent", "2026-09-01")])], WED);
  ok(one.length === 1,
     "control: a single unanswered message produces nothing — owedFollowUps cannot fire at all");
}

/* --------------------------------------------------------------- sources */

// A list of names the owner typed in from an alumni list is a distinct source
// from a directory search or a LinkedIn find, and the row has to say so — the
// closed set is enforced at the API and in addContact, so a value that is not
// here cannot be stored at all.
ok(SOURCE_KEYS.includes("manual-alumni-list"),
   "a hand-entered alumni list is a source the closed set accepts");
ok(!!SOURCE_LABEL["manual-alumni-list"] && SOURCE_LABEL["manual-alumni-list"].length > 3,
   "and it has a label the form can show");

/* ------------------------------------------------------- quick add payload */

// The one-action form on Companies: a name and a LinkedIn link, one button.
// This is the whole of what it sends, decided in one pure place so the form
// cannot invent a field the API will refuse.
{
  const url = "https://www.linkedin.com/in/jane-doe-1a2b3c/";
  const p = quickAddPayload({ name: url, link: "", company: "palantir" });
  ok(p && p.name === "Jane Doe", "a LinkedIn link pasted into the name box becomes a name");
  ok(p && p.linkedin_url === url, "and the link is kept");
  ok(p && p.source === "linkedin", "a person found by link is sourced to LinkedIn");

  const q = quickAddPayload({ name: "Jane Doe", link: "linkedin.com/in/janedoe", company: "palantir" });
  ok(q && q.linkedin_url === "https://linkedin.com/in/janedoe",
     "a bare link gets its scheme — the API refuses one without it");

  const r = quickAddPayload({ name: "Jane Doe", link: "", company: "palantir" });
  ok(r && r.linkedin_url === null && r.source === "alumni_directory",
     "no link: sourced to the directory, and no empty-string URL is sent");
  ok(r && r.company === "palantir" && r.action === "add" && r.warmth === "cold",
     "the rest is fixed, never typed");

  ok(quickAddPayload({ name: "  ", link: "", company: "palantir" }) === null, "no name, no payload");
  ok(quickAddPayload({ name: "https://www.linkedin.com/in/", link: "", company: "palantir" }) === null,
     "a link with no readable slug yields no name, so no payload — the box stays for the owner to type one");
  ok(quickAddPayload({ name: "Jane Doe", link: "", company: "" }) === null, "no company, no payload");
}

/* ------------------------------------------------------- alumni links */

// LinkedIn's school /people/ pages IGNORE ?keywords= — the original owner
// clicked three of them on 2026-09-03 and every one landed on the same
// unfiltered page of 51,107 alumni with an empty search box, because that page
// filters on the client. So the per-company link is a plain PEOPLE SEARCH
// seeded with the school's first search term, and the school page is offered
// beside it as what it is: unfiltered, filtered by hand.
//
// THE SCHOOL COMES FROM THE BAKED PROFILE, so the expectations are built from
// the same value rather than typed: a literal here would assert one owner's
// school against the next owner's build.
{
  const prefix = encodeURIComponent(SCHOOL_SEARCH_PREFIX);
  ok(SCHOOL_SEARCH_PREFIX === OWNER.schoolSearchTerms[0],
     "the search is seeded with the FIRST school term from profile.json");
  ok(schoolPeopleSearchUrl("Anduril")
       === `https://www.linkedin.com/search/results/people/?keywords=${prefix}%20Anduril`,
     "the per-company link is a people search seeded with the school term and the company");
  ok(schoolPeopleSearchUrl("Applied Intuition")
       === `https://www.linkedin.com/search/results/people/?keywords=${prefix}%20Applied%20Intuition`,
     "a two-word company is encoded, not split");
  ok(!schoolPeopleSearchUrl("Anduril").includes("/school/"),
     "and it is NOT a school page with a query string, which is the thing that does not work");
  // The alumni page is OPTIONAL: profile.json may leave it out, and then the
  // constant is null and the UI renders no second link rather than a dead one.
  ok(SCHOOL_LINKEDIN_ALUMNI === null || /^https:\/\/www\.linkedin\.com\/school\/[^?]+\/people\/$/.test(SCHOOL_LINKEDIN_ALUMNI),
     `the school alumni page is null or a bare /school/<slug>/people/ URL (${SCHOOL_LINKEDIN_ALUMNI})`);
  ok(SCHOOL_LINKEDIN_ALUMNI === null || !SCHOOL_LINKEDIN_ALUMNI.includes("?"),
     "and carries no query string at all — one would be dropped and look like a filter");
  ok(SCHOOL_LINKEDIN_ALUMNI === (OWNER.schoolLinkedinAlumniUrl || null),
     "and it is exactly what profile.json says, or null");
}

/* ------------------------------------------------- the owner merge fields */

// WHO IS WRITING comes from profile.json, baked, and is filled at render time
// so no template can go out unsigned or signed with someone else's name. The
// original carried its owner's name, school and class year as literals in
// the bodies; every one is a merge field now.
{
  const of = ownerFields();
  eq(of.owner_first_name, OWNER.firstName, "the first name is the baked one");
  eq(of.owner_name, OWNER.name, "and the full name");
  eq(of.owner_school, OWNER.schoolShort, "and the short school name");
  eq(of.owner_class_year, String(OWNER.classYear), "and the class year, as text");
  eq(of.owner_graduation, OWNER.graduation, "and the graduation month");
  eq(of.owner_start_season, PREFS.canStartSeason || "summer", "and the season they can start");
  ok(OWNER_FIELDS.every((f) => f in of), "ownerFields() fills every declared owner field");

  // Filled WITHOUT the caller passing them.
  eq(renderTemplate("Hi {first_name}, I'm {owner_first_name} ({owner_school} {owner_class_year}).",
                    { first_name: "Ana" }),
     `Hi Ana, I'm ${OWNER.firstName} (${OWNER.schoolShort} ${OWNER.classYear}).`,
     "owner fields fill from the profile with nothing passed");
  // And a caller's value wins, so a test or a preview can render as someone else.
  eq(renderTemplate("{owner_first_name}", { owner_first_name: "Sam" }), "Sam",
     "a passed owner field overrides the baked one");

  // EVERY SHIPPED TEMPLATE IS SIGNED BY THE OWNER, not by a literal.
  for (const t of TEMPLATES) {
    ok(t.body.includes("{owner_first_name}"), `${t.key}: signs off with the owner's first name field`);
    ok(!/\bI'm [A-Z][a-z]+,/.test(t.body) || /\{owner_(first_)?name\}/.test(t.body),
       `${t.key}: introduces the writer by merge field, never by a literal name`);
  }
  // And the rendered cold notes carry the real values.
  const out = renderTemplate(TEMPLATE_BY_KEY.alum_cold.body,
    { first_name: "Max", company: "Palantir", role_title: "Deployment Strategist", role_fact: "", shared_hook: "" });
  ok(out.includes(OWNER.firstName) && out.includes(OWNER.schoolShort) && out.includes(String(OWNER.classYear)),
     "the cold alum note names the owner, their school and their class");
}


/* ============ PER-ROLE OUTREACH DRAFTS ==================================== */
//
// The two named Palantir contacts have role = NULL, target_role = NULL and
// job_key = NULL, so before roleFactOf and the picker every draft to them
// rendered the literal words "the role" -- a note about a company rather than
// about a job, which is the version that gets no reply.

const ROLE = {
  key: "lever:palantir:x", title: "Deployment Strategist, New Grad - Intel",
  location: "Washington, D.C.", url: "https://example.invalid/x",
};
const MULTI = { ...ROLE, location: "New York, NY; Seattle, WA; Denver, CO" };
const NOWHERE = { ...ROLE, location: "" };

const render = (k, job) => renderTemplate(TEMPLATE_BY_KEY[k].body, {
  first_name: "Max", company: "Palantir",
  role_title: job?.title || "the role", role_fact: roleFactOf(job),
  shared_hook: "",
});

/* THE FACT IS DERIVED, AND IT IS TRUE BY CONSTRUCTION. */
ok(roleFactOf(ROLE).includes("Washington, D.C."),
   "the fact names the posting's own location");
ok(roleFactOf(MULTI).includes("New York, NY") && /3 locations/.test(roleFactOf(MULTI)),
   `a multi-city posting names the first and counts the rest: ${roleFactOf(MULTI)}`);
ok(roleFactOf(NOWHERE) === "", "no location on file means no claim at all");
ok(roleFactOf(null) === "", "and neither does no role");

/* AN EMPTY FACT LEAVES NO TRACE. This is the state BOTH contacts are in, so it
 * is the case that actually renders today -- an orphaned dash or a doubled
 * space would go straight to a real person. */
for (const k of TEMPLATE_KEYS) {
  const out = render(k, NOWHERE);
  ok(!/\{[a-z_]+\}/i.test(out), `${k}: no unfilled placeholder survives`);
  ok(!/ {2,}/.test(out), `${k}: no doubled space where the fact was cut`);
  ok(!/[—-]\s*[—-]/.test(out), `${k}: no orphaned dashes around the cut field`);
  ok(!/\s+[.,]/.test(out), `${k}: no punctuation left hanging`);
}

/* THE DISCIPLINE, ON THE COLD TEMPLATES A STRANGER ACTUALLY RECEIVES. */
for (const k of ["alum_cold", "practitioner", "deployment"]) {
  const out = render(k, ROLE);

  // Names the actual requisition, not "the role".
  ok(out.includes(ROLE.title), `${k}: names the specific role`);
  ok(!/\bthe role\b/.test(out), `${k}: does not fall back to "the role"`);
  ok(out.includes("Washington, D.C."), `${k}: carries one concrete posting fact`);

  // A small, answerable ask -- a question mark, not "let's connect".
  ok(out.includes("?"), `${k}: asks an answerable question`);
  ok(!/love to connect|learn more about opportunities|pick your brain/i.test(out),
     `${k}: no unanswerable ask`);

  // NEVER MANUFACTURE A CONNECTION. Nothing implying he has read their work.
  ok(!/following your work|admire|impressed by|big fan|loved your|your post|your talk/i
     .test(out), `${k}: implies no familiarity with them`);
  ok(!/hope this finds you well/i.test(out), `${k}: no filler opener`);

  // THE SAME CLEARANCE GATE AS THE PACKS. A cold note to a stranger at a
  // defense company is the last place to assert an adjudication nobody made.
  const claim = forbiddenClaim(out);
  ok(claim === null, `${k}: makes no clearance claim${claim ? ` — ${claim}` : ""}`);

  // And no bracket, on the surface a real person reads.
  ok(!/\[[^\]]+\]/.test(out), `${k}: no square-bracket placeholder`);
}

/* THE SHARED INSTITUTION IS STATED PLAINLY, and only where it is true. The
 * deployment template is for someone whose CONNECTION is the job, not the
 * school, and it says exactly that rather than implying a school link. */
ok(new RegExp(`both went to ${OWNER.schoolShort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(render("alum_cold", ROLE)),
   "the alum template states the shared institution plainly, by its baked name");
ok(/No connection between us/.test(render("deployment", ROLE)),
   "and the deployment template states plainly that there is none");



/* ============ NO EM DASHES, ANYWHERE IN OUTREACH ========================= */
//
// Same rule as the packs, on the same reasoning: apply_packs._clean strips them
// in code rather than asking a model not to produce them. The owner does not
// write them, so a dash in an outgoing note is a tell that a machine did.
//
// THE TEMPLATES ARE WRITTEN WITHOUT THEM rather than cleaned afterwards, so the
// shipped wording reads the way it will send -- but renderTemplate strips them
// too, because an override is free text the owner may have pasted from elsewhere.

const DASH_CHARS = ["\u2014", "\u2013", "\u2015"];

for (const t of TEMPLATES) {
  const d = dashClaim(t.body);
  ok(d === null, `template ${t.key} carries no dash${d ? `: ${JSON.stringify(d)}` : ""}`);
}

/* THE TWO NAMED PALANTIR CONTACTS, every template, rendered. The real names,
 * because "Max H." has a full stop in it and the whitespace pass that repairs a
 * cut field runs over the punctuation too. */
const CONTACTS = ["Max H.", "Mamdooh"];
const REAL_ROLE = {
  key: "lever:palantir:real",
  title: "Deployment Strategist - US Government",
  location: "New York, NY",
  url: "https://jobs.lever.co/palantir/real",
  score: 92,
};

let dashes = 0;
for (const name of CONTACTS) {
  for (const k of TEMPLATE_KEYS) {
    for (const job of [REAL_ROLE, null]) {
      const fields = {
        first_name: firstNameOf(name), company: "Palantir",
        role_title: job?.title || "the role", role_fact: roleFactOf(job),
        shared_hook: "",
      };
      const out = k === "linkedin_note"
        ? linkedinNote(fields).text
        : renderTemplate(TEMPLATE_BY_KEY[k].body, fields);

      for (const ch of DASH_CHARS) {
        if (out.includes(ch)) dashes++;
      }
      ok(dashClaim(out) === null,
         `${name} / ${k} / ${job ? "with role" : "no role"}: no dash`);
      // The gates the packs use, on the same text.
      ok(forbiddenClaim(out) === null, `${name} / ${k}: no clearance claim`);
      ok(!/\[[^\]]+\]/.test(out), `${name} / ${k}: no bracket`);
      ok(!/\{[a-z_]+\}/i.test(out), `${name} / ${k}: no unfilled field`);
    }
  }
}
ok(dashes === 0,
   `ZERO dashes across ${CONTACTS.length} contacts x ${TEMPLATE_KEYS.length} `
   + `templates x 2 role states, counted directly: found ${dashes}`);

/* AN OVERRIDE CANNOT SMUGGLE ONE IN. This is the path that actually carries
 * risk now the shipped templates are clean -- the owner can rewrite any template
 * from the People page, and free text often arrives pasted. */
const smuggled = renderTemplate(
  `Hi {first_name} \u2014 a note \u2013 with dashes \u2015 in it.`,
  { first_name: "Max" });
ok(dashClaim(smuggled) === null,
   `an override's dashes are stripped on render: ${JSON.stringify(smuggled)}`);
ok(!/ {2,}|\s+[.,]/.test(smuggled),
   `and the replacement leaves no doubled space or hanging comma: ${JSON.stringify(smuggled)}`);

/* ============ THE LINKEDIN NOTE FITS, ALWAYS ============================= */
//
// LinkedIn's connection box is 300 characters and truncates SILENTLY, so a note
// that is merely rendered and hoped for arrives cut off mid-question, which
// reads worse than sending nothing. Measured over every reachable role at the
// companies with contacts, 15 of 256 exceeded it, the worst at 316.

ok(LINKEDIN_LIMIT === 300, "the cap is LinkedIn's actual 300");
ok(TEMPLATE_KEYS.includes("linkedin_note"), "there is a LinkedIn variant");

// A TITLE THAT CANNOT FIT, whatever the owner's name and school are. The
// template's fixed prose plus the baked owner fields leave some room under
// 300; the fixture is padded past it so the shortening path is driven no
// matter how short the owner's name is. The real worst case in the corpus
// ("… - US Government - Federal Health and Civilian") is tried first, and
// fits or shortens as the room allows -- either outcome is correct.
const LONG = "Forward Deployed Software Engineer - US Government - Federal "
  + "Health and Civilian - Enterprise Platform, Mission Software and Data Integration";
const short = linkedinNote({
  first_name: "Alexandra", company: "Palantir", role_title: LONG, shared_hook: "",
});
ok(short.text.length <= LINKEDIN_LIMIT,
   `an over-long title still fits: ${short.text.length} chars`);
ok(short.shortened, "and it says that it had to shorten the title");
ok(short.title === "Forward Deployed Software Engineer",
   `cut at the board's own separator, got ${JSON.stringify(short.title)}`);
ok(!short.over, "and it is not over the limit");

/* IT SHORTENS THE TITLE, NEVER THE PROSE. Trimming the sentence would cut the
 * question, and the question is the only part that can earn a reply. */
ok(short.text.includes("?"), "the question survives shortening");
ok(/how much is the customer versus the code/.test(short.text),
   "and it is still the whole question");

/* A SHORT TITLE IS LEFT ALONE. */
const plain = linkedinNote({
  first_name: "Max", company: "Palantir",
  role_title: "Deployment Strategist", shared_hook: "",
});
ok(!plain.shortened, "a title that fits is not shortened");
ok(plain.title === "Deployment Strategist", "and survives intact");

/* ============ ONE RECOMMENDED ROLE, WITH ITS REASON ====================== */
//
// Not a dropdown: the cadence allows two messages per person ever, so there is
// one real slot. Offering twelve options for it implies a freedom that the rule
// does not give.

const POOL = [
  { key: "b", title: "Deployment Strategist", location: "New York, NY", score: 78 },
  { key: "a", title: "Deployment Strategist - US Gov", location: "Denver, CO", score: 92 },
  { key: "c", title: "FDSE", location: "Seattle, WA", score: 78 },
];
ok(recommendRole(POOL).key === "a", "it picks the highest score");

/* TIE-BROKEN ON KEY, so the row cannot name a different role on each render.
 * Palantir has eight roles at exactly 78. */
const TIED = [
  { key: "z", title: "Z", location: "NY", score: 78 },
  { key: "a", title: "A", location: "NY", score: 78 },
];
ok(recommendRole(TIED).key === "a", "ties break on key, not on input order");
ok(recommendRole([...TIED].reverse()).key === "a",
   "and the same way whichever order they arrive in");
ok(recommendRole([]) === null, "no roles means no recommendation");

/* THE REASON NAMES THE POPULATION IT RANKED. "Two numbers on one row must come
 * from one population": Palantir has 310 open and 12 reachable, and "best of
 * 310" would be a claim about a list that was never considered. */
const why = recommendReason(recommendRole(POOL), POOL);
ok(/reachable/.test(why), `the reason says reachable: ${why}`);
ok(/\b3\b/.test(why), `and counts the pool it actually ranked: ${why}`);
ok(/92/.test(why), `and states the score: ${why}`);
ok(/Denver, CO/.test(why), `and where it is: ${why}`);
ok(recommendReason(null, POOL) === "", "no role means no reason");


/* ------------------------------------------------------------------ report */

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
