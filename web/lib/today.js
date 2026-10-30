/**
 * What to do right now. One thing, chosen by rules, with the reason and the time.
 *
 * Daily used to answer "here is some information". Three of its five sections
 * rendered empty states — "Nothing saved yet", "None owed", "Nothing closing
 * inside 21 days" — which read as a quiet day and were in fact an empty
 * `actions` table, an empty `contacts` table, and a horizon shorter than the
 * task it was warning about. Nothing on the page was phrased as an instruction.
 *
 * This picks exactly one. Pure function, no I/O, no model: everything it reads
 * is a stored fact or a date subtraction, so the same inputs always give the
 * same answer and it can be tested without a database.
 *
 * TWO ORDERING PRINCIPLES, both deliberate:
 *
 *   Irreversibility beats urgency. A closing window is unrecoverable — miss it
 *   and the cycle is gone. A networking touch or a saved role is not. So a
 *   window outranks an on-you item outranks outreach, even when the item is due
 *   sooner.
 *
 *   A guess never becomes a command. 1 of 25 tracked dates is `verified`. So
 *   confidence governs the WORDING, never the eligibility (see tier 1), and the
 *   act of confirming an unknown date is itself a tier — the highest-value
 *   recurring job in this system, because 16 windows have no date at all and
 *   nobody is watching them.
 *
 * THE TIME CONSTRAINT. The top item must be completable in the time the owner
 * actually has. Four minutes on a Tuesday buys one phone call or five directory
 * searches, and every item on the old page cost more than the session. So each
 * candidate carries `minutes` — a STATED number from daily.yaml or
 * companies.yaml, never inferred, never guessed — and when the chosen item does
 * not fit a short sitting, `alsoIfShort` offers the smallest real thing that
 * does. Not a mode switch, and not a lie about how long the big one takes.
 */

import {
  windowKey, MAX_DEFERRALS, compareWindows, STALE_DAYS, CONTACTS_PER_WEEK,
} from "./display.js";
import { NAMES_PER_COMPANY } from "./people.js";
import { plural, pluralWord, inDays, outOf } from "./plural.js";
// The owner's class year and school, baked from profile.json. Two sentences
// below name them; a literal here would have told the next owner to look for
// someone else's year in someone else's directory.
import { CLASS_YEAR, OWNER } from "./config.generated.js";

/** Minutes assumed when nothing states a figure. Per KIND, never per item. */
export const DEFAULT_MINUTES = {
  fetch: 2,
  apply: 120,
  confirm_window: 10,
  item: 30,
  find_names: 20,
  triage_role: 3,
};

/** A sitting this short only fits the small stuff. */
export const SHORT_SITTING = 15;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** datePhrase is written to stand alone; it also gets embedded after a full stop. */
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Minutes for a candidate: stated wins, kind default fills in. */
function mins(stated, kind) {
  return num(stated) ?? DEFAULT_MINUTES[kind] ?? 30;
}

/**
 * How a close date is allowed to be described.
 *
 * `historical-estimate` may not render as "33 days" — that is the McKinsey
 * failure exactly: a note reading "typically closes mid/late September" when the
 * window had shut on 11 August. It renders as "~30 Sep, estimated" and the
 * action says to confirm it.
 */
export function datePhrase(d) {
  if (!d.closes) return "no published date";
  // timeZone: "UTC" is load-bearing, not tidiness. The dates are stored as bare
  // days and parsed as midnight UTC; formatting them in a US timezone renders
  // every one of them a DAY EARLY — "closes 29 Sep" for a window that closes on
  // the 30th. Caught by the tests, and it would have been invisible on screen.
  const when = new Date(d.closes + "T00:00:00Z").toLocaleDateString("en-GB",
    { day: "numeric", month: "short", timeZone: "UTC" });
  if (d.confidence === "verified") return `closes ${when} — ${d.closeIn} days`;
  if (d.confidence === "secondary-source") return `closes ${when} (two sources) — ${d.closeIn} days`;
  return `closes ~${when}, estimated — confirm it`;
}

/**
 * Pick today's one thing.
 *
 * Every argument is already-fetched data; this function does no I/O so that the
 * rules can be tested against fixed dates rather than against whatever the
 * database happens to hold this morning.
 */
export function chooseToday({
  windows = [],        // getDeadlines(), all of them
  undated = [],        // undatedWindows(), least-recently-checked first
  items = [],          // listItems(), done flag included
  companies = [],      // listCompanies(), needs reachable40 / n2027 / contacts
  contactsThisWeek = 0,   // contacts added in the last 7 days, from the DB
  newRoles = [],       // scored roles first seen since the last visit
  updated = {},        // lastUpdated()
  horizonDays = 45,
} = {}) {
  const open = [];

  // ---------------------------------------------------------------- tier 0
  // Everything below is read off data the fetch produces. If that has not run,
  // every other answer on this page is a claim about yesterday.
  if (updated.hoursAgo === null || updated.hoursAgo > 36) {
    open.push({
      tier: 0,
      kind: "fetch",
      title: "Run the daily fetch",
      why: updated.hoursAgo === null
        ? "Nothing has ever been fetched, so every list below is empty rather than quiet."
        : `Last run ${Math.floor(updated.hoursAgo / 24)} days ago. Everything below is that old.`,
      minutes: DEFAULT_MINUTES.fetch,
      href: null,
    });
  }

  // ---------------------------------------------------------------- tier 1
  // An open window with a date, inside the horizon. Confidence does NOT gate
  // this — it gates the wording. Excluding estimated dates would have put
  // "check a careers page" above "apply to the three firms whose window is open
  // now", which is the original contradiction wearing a different hat. The
  // firms' own note says it outright: "Submission date is the real filter, not
  // any published cutoff — roles close as they fill."
  //
  // One per close date. Deloitte, Accenture and EY-Parthenon all close the same
  // day; that is one fact, not three, and three of them is not a shortlist.
  const dated = windows
    .filter((d) => d.status === "open" && d.closeIn !== null && d.closeIn <= horizonDays)
    .sort(compareWindows);
  if (dated.length) {
    const soonest = dated[0];
    const sameDate = dated.filter((d) => d.closes === soonest.closes);
    const firms = sameDate.map((d) => d.firm);
    open.push({
      tier: 1,
      kind: "apply",
      title: firms.length > 1
        ? `Apply to ${firms.slice(0, -1).join(", ")} and ${firms[firms.length - 1]}`
        : `Apply to ${soonest.firm}`,
      why: `The only application window open to you right now. ${cap(datePhrase(soonest))}.`,
      // One firm's programme line is not a caption for three firms. When they
      // share a date, say what the item actually is instead.
      detail: firms.length > 1
        ? `${firms.length} separate applications, one window.`
        : soonest.program,
      minutes: mins(soonest.minutes, "apply") * firms.length,
      href: "/forecast",
      firms,
      // ONE ENTRY PER FIRM, so the card can be a checklist rather than a
      // sentence. "Apply to Accenture, Deloitte and EY-Parthenon" is three
      // applications and one tick box: there was no way to record having done
      // two of them, so the item stayed open and said nothing about progress.
      //
      // Everything the composite card needs to create a real application is
      // here — the firm, the programme, the window it came from, and its own
      // close date, because the shared date is what grouped them but each
      // still has its own countdown once one is confirmed by hand.
      windows: sameDate.map((d) => ({
        firm: d.firm,
        program: d.program,
        closes: d.closes || null,
        closeIn: d.closeIn ?? null,
        confidence: d.confidence || null,
        // Carried through so the row can name which resume to attach. The
        // field list here is explicit, so anything not named is dropped —
        // which is exactly how the finance tag came to render nowhere.
        category: d.category || null,
        classYear: d.class_year ? Number(d.class_year) : null,
        key: windowKey(d),
        minutes: mins(d.minutes, "apply"),
      })),
      // The same task can exist twice: as a tracked window here, and as an
      // on-you item the owner wrote. Both rendered, 600px apart, saying the
      // same thing in different words. Linking them lets the page show it ONCE.
      //
      // Matched in code, on a fact: an open item whose title names every firm in
      // the group. No fuzziness and no model — if the title does not contain all
      // three names it is a different task and both are shown, which is the safe
      // direction to be wrong in.
      itemId: (items.find((i) => !i.done && !i.split
        && firms.every((f) => String(i.title || "").toLowerCase().includes(f.toLowerCase())))
        || {}).id || null,
    });
  }

  // ---------------------------------------------------------------- tier 2
  // On-you items inside a week, oldest-CREATED first rather than soonest-due:
  // the thing that has been sitting longest is the thing that is stuck, and due
  // dates on these are self-imposed anyway.
  // A STALLED item is still eligible here, deliberately: the collapse on the
  // page is a display convenience and the ladder is what decides the day. A
  // display grouping must never hide something the ladder wants to show.
  //
  // The one exception is an item deferred three times. That is an answer, not a
  // backlog, and promoting it again would be the tool refusing to hear it.
  const dueItems = items
    .filter((i) => !i.done && !i.split && (i.deferrals || 0) < MAX_DEFERRALS
                && i.dueIn !== null && i.dueIn <= 7)
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))
                 || (a.dueIn ?? 9999) - (b.dueIn ?? 9999)
                 || String(a.id).localeCompare(String(b.id)));
  if (dueItems.length) {
    const it = dueItems[0];
    open.push({
      tier: 2,
      kind: "item",
      title: it.title,
      why: it.dueIn < 0
        ? `${-it.dueIn} days overdue. Nobody else is going to do it.`
        : `Due in ${it.dueIn} day${it.dueIn === 1 ? "" : "s"}. Nobody else is going to do it.`,
      detail: it.note || null,
      minutes: mins(it.minutes, "item"),
      href: null,
      itemId: it.id,
    });
  }

  // ---------------------------------------------------------------- tier 3
  // 16 windows have no date at all, and a missed one costs a cycle. It looks
  // like admin and it is not.
  //
  // BELOW the on-you items now, and that is a correction. Irreversibility is
  // the reason a window outranks a commitment — but that argument belongs to a
  // window that is CLOSING. An undated one is not closing, it is unknown, and
  // ranking it above a promise the owner made to themselves put admin at the top of
  // the page while four overdue items sat below it unreachable.
  //
  // COOLDOWN. A check that finds no date resets recency, so without one this
  // queue never empties and permanently occupies whatever slot it holds.
  // Simulated on real data: from 1 October it was selected every single day
  // and tiers below it were never reached once.
  const dueACheck = undated.filter(
    (w) => w.verifiedAgo === null || w.verifiedAgo >= STALE_DAYS);
  if (dueACheck.length) {
    const w = dueACheck[0];
    open.push({
      tier: 3,
      kind: "confirm_window",
      title: `Check ${w.firm}'s careers page for a ${CLASS_YEAR} date`,
      why: w.verifiedAgo === null
        ? `${undated.length} tracked windows have no date and ${dueACheck.length} are due a look. This one has never been checked.`
        : w.verifiedAgo === 0
          ? `${undated.length} tracked windows have no date. You checked this one today; it is the least recently checked of the rest.`
          : `${undated.length} tracked windows have no date and ${dueACheck.length} are due a look. This one was last checked ${w.verifiedAgo} days ago.`,
      detail: w.program,
      minutes: mins(w.minutes, "confirm_window"),
      href: w.source || "/forecast",
      firms: [w.firm],
      // The key the "checked it" control posts. Answering moves this window to
      // the back of the least-recently-checked queue, so the ladder asks about
      // the next one instead of naming the same firm every morning.
      windowKey: windowKey(w),
      // Sixteen of these at one a day is sixteen days. The batch view does
      // six in half an hour.
      batchHref: dueACheck.length > 1 ? "/forecast#confirm" : null,
      batchCount: dueACheck.length,
    });
  }

  // ---------------------------------------------------------------- tier 4
  // Networking, which is the highest-leverage activity in the search and has
  // zero rows. Named company, named count — "reach out to people" is not a task.
  // ON A CADENCE, not on emptiness. This fired only when nothing else did, which
  // after the consulting windows close means never — and networking is the tier
  // that decides whether this tool is still worth opening in December. It now
  // competes on being BEHIND FIVE NEW CONTACTS A WEEK, which is a fact about the
  // week rather than a fact about how quiet the page happens to be.
  const behind = Math.max(0, CONTACTS_PER_WEEK - (contactsThisWeek || 0));
  // UNDER the target, not at zero. One contact at a company is a single point
  // of failure — they change jobs, they never reply, they turn out to be in a
  // different part of the business — so a company with one name still has work
  // left. This used to be `!(c.contacts > 0)`, which declared a company done
  // after a single name and moved on.
  const target = [...companies]
    .filter((c) => (c.reachable40 || 0) > 0 && (c.contacts || 0) < NAMES_PER_COMPANY)
    .sort((a, b) => (b.reachable40 * (1 + (b.n2027 || 0))) - (a.reachable40 * (1 + (a.n2027 || 0)))
                 || String(a.name).localeCompare(String(b.name)))[0];
  if (target && behind > 0) {
    open.push({
      tier: 4,
      kind: "find_names",
      title: `Find ${NAMES_PER_COMPANY - (target.contacts || 0)} name${
        NAMES_PER_COMPANY - (target.contacts || 0) === 1 ? "" : "s"
      } at ${target.display_name} in the ${OWNER.schoolShort} directory`,
      // "You know nobody" was stated unconditionally and stopped being true the
      // moment the filter above started admitting companies with one contact.
      // A sentence that describes the wrong state is worse than a vaguer one.
      why: `${contactsThisWeek === 0
        ? `None added this week against a target of ${CONTACTS_PER_WEEK}.`
        : `${contactsThisWeek} of ${CONTACTS_PER_WEEK} added this week.`
      } ${target.reachable40} roles there fit you and you know ${
        (target.contacts || 0) === 0 ? "nobody" : "one person"
      } — a referral routes around the two biggest blockers in the gap data.`,
      detail: target.bestTitle || null,
      minutes: DEFAULT_MINUTES.find_names,
      // Lands on the form, with the company already filled in. This pointed at
      // /companies, which named the company again and then had nowhere to put a
      // name — the whole complaint about this tier being unactionable.
      href: `/people?co=${encodeURIComponent(target.name)}&add=1`,
      firms: [target.display_name],
    });
  }

  // ---------------------------------------------------------------- tier 5
  if (newRoles.length) {
    const r = newRoles[0];
    open.push({
      tier: 5,
      kind: "triage_role",
      title: `Save or dismiss ${r.display_name} — ${r.displayTitle || r.title}`,
      why: `New since your last visit, and it scores ${r.score}. One decision, then it stops asking.`,
      minutes: DEFAULT_MINUTES.triage_role,
      href: "/inbox?worth=1",
    });
  }

  // ---------------------------------------------------------------- tier 6
  // Never an empty top. If genuinely nothing is due, say so in those words and
  // still offer the maintenance action, so the page always ends in a verb.
  const chosen = open[0] || null;
  const short = open
    .filter((c) => c.minutes <= SHORT_SITTING)
    .sort((a, b) => a.minutes - b.minutes || a.tier - b.tier)[0] || null;

  return {
    today: chosen,
    // Only offered when the main item genuinely does not fit a short sitting,
    // and only when it is a different thing.
    alsoIfShort: chosen && chosen.minutes > SHORT_SITTING && short && short !== chosen
      ? short
      : null,
    nothingDue: !chosen,
    candidates: open,
  };
}

/**
 * Where this sits in the recruiting cycle: four computed facts, no score.
 *
 * Returns LABEL/VALUE PAIRS rather than sentences. The header rendered them as
 * a 9px mono string joined with dots, which is a shape you scan past; the rail
 * on a wide screen renders the same four facts as a small table, where a value
 * can be read without reading the label. Same numbers, same order, same module
 * — only the caller decides which shape to draw, and `frameSentences()` below
 * still produces the joined form for the narrow layout.
 *
 * There is no "on track" number and there will not be one. Nothing in this
 * repository knows what on track means, and a figure that cannot be derived is
 * a figure that was invented.
 */
export function cycleFrame({ windows = [], graduation = null, now = new Date() } = {}) {
  const rows = [];

  if (graduation) {
    // profile.json says a month and a year — a month, not a day. Anchoring to the 1st
    // understates the runway by half a month and the 31st overstates it, so a
    // month-only value anchors to the middle. It is the least-wrong single point
    // for a fact that genuinely has no day in it.
    const g = new Date(graduation + (graduation.length === 7 ? "-15" : "") + "T00:00:00Z");
    const months = Math.max(0, Math.round((g - now) / (30.44 * 86400000)));
    rows.push({
      key: "graduation",
      label: "Months to graduation",
      value: String(months),
      sentence: `${plural(months, "month")} to graduation`,
    });
  }

  const dated = windows
    .filter((d) => d.status === "open" && d.closeIn !== null && d.closeIn >= 0)
    .sort((a, b) => a.closeIn - b.closeIn
                 || String(a.firm).localeCompare(String(b.firm)));
  if (dated.length) {
    const soonest = dated[0];
    const n = dated.filter((d) => d.closes === soonest.closes).length;
    rows.push({
      key: "closing",
      label: `${pluralWord(n, "Window")} closing next`,
      value: inDays(soonest.closeIn),
      // WHICH windows. "Windows closing next — in 29 days" sat directly above
      // "Next window opens — in 29 days", and two identical values with no names
      // read as one number feeding two labels. It is a real coincidence — three
      // consulting windows shut on 2026-09-30 and Google APM opens that day —
      // but a coincidence that looks like a bug costs the same trust as a bug.
      aside: dated.filter((d) => d.closes === soonest.closes)
        .map((d) => d.firm).slice(0, 3).join(", "),
      count: n,
      sentence: `${plural(n, "window")} close${n === 1 ? "s" : ""} ${inDays(soonest.closeIn)}`,
    });
  }

  const opening = windows
    .filter((d) => d.status !== "closed" && d.status !== "wrong_class_year" && d.opens)
    .map((d) => ({ d, in: Math.round((Date.parse(d.opens + "T00:00:00Z") - now) / 86400000) }))
    .filter((x) => x.in > 0)
    .sort((a, b) => a.in - b.in
                 || String(a.d.firm).localeCompare(String(b.d.firm)))[0];
  if (opening) {
    rows.push({
      key: "opening",
      label: "Next window opens",
      value: inDays(opening.in),
      aside: opening.d.firm,
      sentence: `next opens ${inDays(opening.in)}`,
    });
  }

  // ONE DENOMINATOR. This was "N have no date at all" here and "N of M" in the
  // section below, against two different totals, and each read as correct beside
  // the other. `live` is the population the count is actually drawn from —
  // windows that are neither closed nor for another class year — and `tracked`
  // is every row in companies.yaml, which is a different and larger thing.
  const live = windows.filter(
    (d) => d.status !== "closed" && d.status !== "wrong_class_year");
  const undated = live.filter((d) => !d.closes).length;
  if (undated) {
    rows.push({
      key: "undated",
      label: "Windows with no date",
      value: `${undated} of ${live.length}`,
      aside: windows.length > live.length ? `${windows.length} tracked` : null,
      sentence: outOf(undated, live.length, "live window"),
    });
  }

  return rows;
}

/** The same four facts as sentences, for the narrow layout's joined line. */
export function frameSentences(frame = []) {
  return frame.map((f) => f.sentence);
}
