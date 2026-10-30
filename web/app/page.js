import Rail from "./Rail";
import { pulseRows } from "@/lib/contacts";
import { computePulse, mondayRetro } from "@/lib/pulse";
import { USER_TZ } from "@/lib/constants";
import {
  curatedJobs, payShape, lastUpdated, listCompanies, windowChecks, contactsAddedSince,
  groupRoles, listItems, actionState, actionDates, lastVisit, recordVisit,
  surfaceItems, hoursToday, pipelineStatus, onTrackCounts } from "@/lib/db";
import { getDeadlines, undatedWindows, applyChecks } from "@/lib/deadlines";
import { getPeople, referralCompanies, getSf86 } from "@/lib/contacts";
import { completeness as sf86Completeness } from "@/lib/sf86";
import { chooseToday, cycleFrame } from "@/lib/today";
import { owedFollowUps, goingCold, weeklyPulse } from "@/lib/people";
import {
  WINDOW_HORIZON_DAYS, capPerCompany, compareWindows, windowKey,
} from "@/lib/display";
import { windowProgress } from "@/lib/palette";
import { listInFlight, windowsApplied, submissionSnapshot } from "@/lib/applications";
import { submissionCounts } from "@/lib/submissions";
import { consultingBanner } from "@/lib/consulting";
import { planToday, todayIn } from "@/lib/scheduler";
import { GRADUATION } from "@/lib/config.generated.js";
import Daily from "./Daily";
import { resolved } from "@/lib/assert";

import { onTrackLine } from "@/lib/ontrack";
import { todaysFive } from "@/lib/db";

export const dynamic = "force-dynamic";

const WORTH_A_LOOK = 8;

export default async function Page() {
  // People, with everything that has happened attached. What is owed is
  // COMPUTED from those interactions rather than read from a next_touch column,
  // so it cannot go stale and there is no second list to keep up to date.
  const { people } = resolved(await getPeople(), "getPeople");

  // Read the PREVIOUS visit before recording this one, or every role would be
  // "already seen" the moment the page rendered.
  // Independent calls run TOGETHER. On SQLite these were in-process and free;
  // against Neon each await is a network round trip, and this page made eight of
  // them in a row for no reason — about a second of nothing but latency.
  // Three stages now, ordered only where there is a real dependency.
  // ONE implementation of "is a referral in motion here", shared with Inbox,
  // so the shield cannot fire on one page and stay quiet on the other.
  const [since, state, referrals] = await Promise.all([
    lastVisit(), actionState(), referralCompanies(),
  ]);

  // LAST WEEK, and only on a Monday. mondayRetro returns null on every other
  // day, so six days a week this costs one query and renders nothing.
  //
  // Applications are deliberately not passed: the retro reports messages,
  // replies and slipped tasks, and nothing else.
  const { contacts: pContacts, interactions: pInteractions } = await pulseRows();
  const pulse = computePulse({
    interactions: pInteractions, contacts: pContacts, tz: USER_TZ,
  });

  resolved(since, "lastVisit");
  resolved(state, "actionState");
  const sortCtx = { saved: state.saved, newSince: since };

  const drop = (rows) => rows.filter((r) => !state.hidden.has(r.groupKey));

  // Everything Daily is allowed to show, in the one shared order. Grouped by
  // location so a role in six cities is one row, then cut to a readable length.
  // The page states how many are below the line rather than implying none are.
  // cap 0 here, then group, then cap — the same order Inbox uses. Capping inside
  // the query counts POSTINGS, so one Palantir role listed in six cities could
  // consume both of Palantir's slots, and Daily's "See all 26" landed on 27.
  const curated = capPerCompany(drop(groupRoles(
    resolved(await curatedJobs({ minScore: 40, cap: 0, limit: 2000, sortCtx }), "curatedJobs")
  )), 2);
  const saved = curated.filter((r) => state.saved.has(r.groupKey));
  const savedKeys = new Set(saved.map((r) => r.groupKey));
  const worth = curated.filter((r) => !savedKeys.has(r.groupKey));

  const [pay, updated, items, appliedDates, companies, checks] =
    await Promise.all([
      payShape(), lastUpdated(), listItems(), actionDates("applied"),
      listCompanies({}), windowChecks(),
    ]);
  // The UNION: role applications and the manual ones together. Every place
  // that counts applications reads this one query, so In flight, the header
  // and the Companies tally cannot disagree about how many there are.
  const [live, appliedWins] = await Promise.all([listInFlight(), windowsApplied()]);
  const sf86 = await getSf86();
  const contactsThisWeek = await contactsAddedSince(7);
  resolved(pay, "payShape");
  resolved(updated, "lastUpdated");
  resolved(items, "listItems");

  // The retro needs `items` for the slipped count, so it is built here rather
  // than beside the pulse above — `items` is a const and consts are not
  // hoisted.
  const retro = mondayRetro(pulse, items, new Date(), USER_TZ);

  // HOURS TODAY, and the trim it produces. Unanswered is the common state and a
  // real one: no answer means no trimming and no nagging.
  const todayLocal = todayIn(USER_TZ);
  const hoursAnswer = await hoursToday(todayLocal);
  const run = await pipelineStatus();
  // AHEAD OR BEHIND. Fails to null rather than to zeroes: a failed read
  // rendering as "0 of 3" is indistinguishable from a real month with
  // nothing in it, and only one of those is worth an afternoon.
  // TODAY'S FIVE. Fails to an empty list rather than blanking the page:
  // a sourcing table that cannot be read is a bad night, not a reason
  // to lose the rest of Daily.
  let five = [];
  try { five = await todaysFive(5); } catch { five = []; }

  let onTrack = null;
  try {
    onTrack = onTrackLine(await onTrackCounts(), { now: new Date() });
  } catch { onTrack = null; }
  resolved(companies, "listCompanies");

  // companies.yaml is the seed; the actions table records every check made
  // since. A deployed app cannot write to the repo, so this is the only way
  // "checked it, still no date" can go anywhere — and the only way a window
  // in this system ever becomes `verified`. Computed here rather than below
  // because the scheduler needs each window's staleness to pick the next one.
  const windowsForStaleness = applyChecks(getDeadlines(), checks);

  await recordVisit();

  // ONE child of each kind per day. The scheduler is pure and returns a plan;
  // this writes it. Idempotent — a second load finds today's item already
  // surfaced and returns nothing to write, so opening Daily twice cannot put
  // two confirm-date tasks in front of him.
  const day = todayIn(USER_TZ);
  const contactCounts = Object.fromEntries(
    companies.map((c) => [c.name, c.contacts || 0]));
  const ranking = [...companies]
    .filter((c) => (c.reachable40 || 0) > 0)
    .sort((a, b) => (b.reachable40 * (1 + (b.n2027 || 0))) - (a.reachable40 * (1 + (a.n2027 || 0)))
                 || String(a.name).localeCompare(String(b.name)))
    .map((c) => c.name);
  const staleness = Object.fromEntries(
    windowsForStaleness.map((w) => [
      String(w.firm).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      w.verifiedAgo ?? null,
    ]));
  const plan = planToday({
    children: items.filter((i) => i.unit_kind),
    ranking, contactCounts, windowStaleness: staleness, today: day,
  });
  // KEPT ITEMS ARE ROLLED FORWARD, not just newly surfaced ones.
  //
  // `surfaced_on` means "the day this is currently assigned to", so an
  // unfinished pick from yesterday becomes today's. Writing only `surface`
  // left yesterday's date on it, and every render then looked for today's and
  // found nothing — which is how two uncompleted tasks disappeared overnight.
  const assign = [...plan.surface, ...plan.keep];
  if (assign.length) {
    await surfaceItems(assign, day);
    for (const id of assign) {
      const it = items.find((i) => i.id === id);
      if (it) it.surfaced_on = day;
    }
  }

  // Every person carries their company's DISPLAY name, or the follow-up rows
  // read "hadrian-automation" where they should read "Hadrian". The slug is the
  // key everywhere in this schema; it has never been the label.
  const coLabel = new Map(companies.map((c) => [c.name, c.display_name]));
  const namedPeople = people.map((p) => ({
    ...p,
    display_name: coLabel.get(p.company) || p.company,
  }));

  const windows = windowsForStaleness;
  const undated = undatedWindows(windows);
  const isNew = (r) =>
    since && r.first_seen && Date.parse(r.first_seen) > Date.parse(since);

  // ONE thing to do, chosen by rules. Everything it reads is a stored fact or a
  // date subtraction — see lib/today.js for why irreversibility outranks urgency
  // and why an estimated date still counts.
  const ladder = chooseToday({
    windows,
    undated,
    items,
    companies,
    contactsThisWeek,
    newRoles: worth.filter(isNew),
    updated,
    horizonDays: WINDOW_HORIZON_DAYS,
  });

  // The three rolling consulting windows, from the SAME function the digest
  // uses. Two implementations of "is Accenture still outstanding" is how the
  // email and the page end up disagreeing.
  const consulting = consultingBanner(windowsForStaleness, appliedWins);

  // THE SUBMISSIONS COUNTER, from the same functions the digest uses so the
  // page and the email cannot disagree about how many applications went in.
  // A failed read passes null, which renders as missing data rather than as a
  // week with nothing in it.
  let counter = null;
  try {
    const snap = await submissionSnapshot();
    counter = submissionCounts({
      submissions: snap.submissions,
      interviews: snap.interviews,
      outstanding: consulting?.outstanding?.length || 0,
    });
  } catch { counter = null; }

  return (
    <Daily
      counter={counter}
      consulting={consulting}
      today={ladder.today}
      alsoIfShort={ladder.alsoIfShort}
      nothingDue={ladder.nothingDue}
      frame={cycleFrame({ windows, graduation: GRADUATION })}
      onTrack={onTrack}
      five={five}
      run={run}
      retro={retro}
      weekOf={pulse.weekOf}
      hours={hoursAnswer}
      rail={
        <Rail
          hours={hoursAnswer}
          day={todayLocal}
          frame={cycleFrame({ windows, graduation: GRADUATION })}
          onTrack={onTrack}
          five={five}
          windows={windowProgress(windows)}
          pulse={people.length ? weeklyPulse(namedPeople) : null}
          inFlight={live}
        />
      }
      savedRoles={saved}
      worthALook={worth.slice(0, WORTH_A_LOOK)}
      worthTotal={worth.length}
      deadlineTotal={windows.length}
      windows={windowProgress(windows)}
      verifiedTotal={windows.filter((d) => d.confidence === "verified").length}
      lowPayCount={pay.under90}
      updated={updated}
      referrals={[...referrals]}
      contactCounts={contactCounts}
      inFlight={live}
      appliedWindows={Object.fromEntries([...appliedWins].map((k) => [k, true]))}
      progress={{ "/sf86": sf86.ready ? sf86Completeness(sf86.rows).pct : null }}
      owed={owedFollowUps(namedPeople)}
      cold={goingCold(namedPeople)}
      pulse={people.length ? weeklyPulse(namedPeople) : null}
      contacts={people.length}
      items={items}
      /* What the scheduler would pick next, so a collapsed parent row can say
         "next up: Anduril" instead of "Nothing surfaced today". Named, never
         surfaced — it becomes today's only when today's is done. */
      nextUp={plan.next}
      /* The head of the Companies "start here" ranking, so Daily's empty People
         section and that queue can never name different companies. */
      startWith={ranking.length ? (coLabel.get(ranking[0]) || ranking[0]) : null}
      actions={{
        saved: [...state.saved],
        hidden: [...state.hidden],
        applied: [...state.applied],
      }}
      appliedAt={Object.fromEntries(appliedDates)}
      newSince={since}
      horizonDays={WINDOW_HORIZON_DAYS}
      /* "What do I do first?" — every value below is derived from rows this
         page already loaded, so the panel costs no query. The DECISIONS live in
         lib/firstfive.js, which is pure and tested; this only supplies facts.
         The window set is the SAME filter the Closing-soon list uses, so the
         two cannot disagree about what is open. */
      firstFive={{
        startCompany: ranking.length
          ? { slug: ranking[0], label: coLabel.get(ranking[0]) || ranking[0] }
          : null,
        contactsAt: ranking.length ? (contactCounts[ranking[0]] || 0) : 0,
        openWindows: windows
          .filter((d) => d.status === "open" && d.closeIn !== null
                      && d.closeIn <= WINDOW_HORIZON_DAYS)
          .map((d) => ({ id: windowKey(d), firm: d.firm })),
        appliedWindows: [...appliedWins],
        outreachSent: pInteractions.filter((i) => i.type === "outreach_sent").length,
        confirmToday: (() => {
          const kid = items.find(
            (i) => i.unit_kind === "confirm_date" && i.surfaced_on === day);
          return { surfaced: !!kid, done: !!kid?.done };
        })(),
        sf86Contact: {
          pct: sf86.ready ? (sf86Completeness(sf86.rows).per.contact?.pct || 0) : 0,
          ready: sf86.ready,
        },
      }}
      deadlines={windows.filter(
        (d) => d.status === "open" && d.closeIn !== null && d.closeIn <= WINDOW_HORIZON_DAYS
      ).sort(compareWindows)}
    />
  );
}
