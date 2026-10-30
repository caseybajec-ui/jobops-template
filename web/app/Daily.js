import Items from "./Items";
import { today as todayLocal, longDate, weekdayName } from "@/lib/day";
import RoleActions from "./RoleActions";
import PrimaryAction from "./PrimaryAction";
import WindowCheck from "./WindowCheck";
import TodayDone from "./TodayDone";
import OwedActions from "./OwedActions";
import CompositeToday from "./CompositeToday";
import { CategoryDot, CategoryLegend, Meter } from "./Palette";
import Band from "./Band";
import Retro from "./Retro";
import { PlaceTag, StartTag } from "./RoleTags";
import {
  horizon, accentedDeadlines, angleLead, roleWeight, openItems,
} from "@/lib/display";
import {
  bandClass, categoryOfCompany, categoryOfFirm, urgencyClass,
} from "@/lib/palette";
import { OWED_SHOWN } from "@/lib/people";
import { OWNER, USER_CLASS_YEAR } from "@/lib/constants";
import Hint from "./Hint";
import ConsultingBanner from "./ConsultingBanner";
import SubmissionCounter from "./SubmissionCounter";
import Explainer from "./Explainer";
import Section from "./Section";
import FirstFive from "./FirstFive";
import { LIFECYCLE_LABEL } from "@/lib/lifecycle";
import { UrgencyChip, VerificationChip, StatusChip } from "./Chip";
import { frameSentences } from "@/lib/today";
import TodaysFive from "./TodaysFive";
import { URGENCY_SENTENCE } from "@/lib/chips";
import { plural, pluralWord, inDays } from "@/lib/plural";

/* Daily — the hero, and a document rather than a dashboard.
 *
 * Opens like a dispatch: weekday, the date large, a hairline rule, one sentence
 * of plain status. Then sections in the order the work actually happens: what
 * you chose, what only you can do, what closes, who owes you a reply, and only
 * then what the tool found.
 *
 * Subtitles earn their place or they are not written. A heading that already
 * says what the section is does not get a sentence repeating it — "Saved" and
 * "Follow-ups owed" explain themselves from their contents.
 */

function Pay({ role }) {
  if (role.comp) return <span className="pay">{role.comp}</span>;
  return (
    <span className="pay unknown" title="this employer does not publish pay on any role">
      not published
    </span>
  );
}

function Where({ role }) {
  if (!role.locationLabel) return null;
  // A Daily row does not expand, so the full list has nowhere to go but the
  // tooltip. Inbox shows the same array under "Where" when a row is opened.
  const all = (role.locations || []).filter(Boolean);
  return (
    <span className="loc" title={all.length > 1 ? all.join(" · ") : undefined}>
      {role.locationLabel}
    </span>
  );
}

/**
 * One role row, used by every list here so the affordances never differ.
 *
 * The scorer's one-line angle sits under the title on the found list. It is the
 * only thing on the page that says why THIS role rather than the one below it,
 * which matters most where the fit numbers are tied.
 */
function Role({ j, actions, isNew, appliedAt, referrals = [], contactCounts = {},
                withAngle = false }) {
  return (
    <div className={`role ${roleWeight(j)} ${bandClass(j.score)}`}>
      {/* THE BAND IS BACK, and the reason it left no longer holds.
          It was removed when it was five near-identical GREY lengths, which
          differentiated nothing while taking the most valuable column on the
          row. It is not grey any more — green, blue, gold — and a 3px rule down
          the left edge turned out to be a colour nobody can see. So the exact
          component Inbox uses renders here too, and the two pages are now
          identical in their band treatment rather than each making its own case.

          The class-year / open-now distinction keeps its column. It is still the
          thing that changes what the owner DOES, and the band is what ranks the rows; they
          answer different questions and neither replaces the other. */}
      <Band score={j.score} />
      <span className={`when2027${j.entry_level === "program" ? " program" : ""}`}>
        {j.entry_level === "program" ? String(USER_CLASS_YEAR) : "open now"}
      </span>
      <span className="who">
        <span className="co">
          <CategoryDot category={categoryOfCompany(j.company)} />
          {j.display_name}
        </span>
        <span className="sep">·</span>
        <a href={j.url} target="_blank" rel="noreferrer">
          {j.displayTitle || j.title}
        </a>
        <Where role={j} />
        <PlaceTag role={j} />
        <StartTag role={j} />
        {isNew && <span className="tag-open">new</span>}
        {appliedAt && <span className="tag-open faint">applied</span>}
        {/* ONE LINE, EVERY ROW.
            The top three showed the full angle and the rest showed its opening
            clause, so a row was three lines or one depending on where it landed
            — and the list you scan for "which of these" had rows varying 3x in
            height for a reason that has nothing to do with the roles. The
            argument for the long form was that the top three are where fit
            numbers tie and the angle is the only separator; that is true, and it
            is still true at 110 characters, which is where the opening clause
            ends. The whole text is on the tooltip. */}
        {withAngle && j.angle && (
          <span className="angle" title={j.angle}>
            {angleLead(j.angle)}
          </span>
        )}
      </span>
      <span className="payacts">
        {/* The verb first, then the rest. What the row is ASKING for is the
            thing to read; Save and Hide are what you do about it. */}
        <PrimaryAction role={j} contactCounts={contactCounts} />
        <RoleActions role={j} state={actions} referrals={referrals} />
        <Pay role={j} />
      </span>
    </div>
  );
}

/**
 * The one thing to do right now.
 *
 * This is the only element on the page phrased as an instruction. Everything
 * below it is reference. The rules that pick it are in lib/today.js; all this
 * does is render the choice, the reason, and the honest time cost.
 *
 * `alsoIfShort` appears only when the chosen item genuinely does not fit a short
 * sitting. Four minutes on a Tuesday buys one phone call or five directory
 * searches, and every item on the old page cost more than the session — so the
 * page offers the small real thing rather than pretending the big one is quick.
 */
function Today({ today, alsoIfShort, nothingDue, horizonDays, appliedWindows = {},
                 hours = null }) {
  const time = (m) => (m >= 120 ? `${Math.round(m / 60)} hours` : `${m} min`);
  // More than one firm behind one instruction. Detected from the windows the
  // ladder attached, not from parsing the title.
  const composite = !!(today && today.kind === "apply"
                       && (today.windows || []).length > 1);
  if (nothingDue || !today) {
    return (
      <section className="today quiet" id="today">
        <h2 className="todaylabel">Today</h2>
        <p className="todaytitle">Nothing is due.</p>
        <p className="todaywhy">
          No window closes inside {horizonDays} days, nothing is on you this week, and there
          is nobody waiting on a reply. This is a real state, not a broken page.
        </p>
      </section>
    );
  }
  return (
    <section className="today" id="today">
      <h2 className="todaylabel">Today</h2>
      <p className="todaytitle">
        {today.href
          ? <a href={today.href} target={today.href.startsWith("http") ? "_blank" : undefined}
               rel="noreferrer">{today.title}</a>
          : today.title}
        <span className="todaytime">{time(today.minutes)}</span>
      </p>
      <p className="todaywhy">{today.why}</p>
      {today.detail && <p className="todaydetail">{today.detail}</p>}
      {/* A composite card is a CHECKLIST, not a tick box. One row per firm,
          each recording a real application, because "apply to three firms"
          had one checkbox and no way to say two of them were done. */}
      {composite
        ? <CompositeToday windows={today.windows} applied={appliedWindows} hours={hours} />
        : today.itemId && <TodayDone itemId={today.itemId} />}
      {today.batchHref && (
        <p className="todaybatch">
          Sixteen of these at one a day is sixteen days.{" "}
          <a href={today.batchHref}>Do several at once</a> — {today.batchCount} are
          due a look.
        </p>
      )}
      {today.windowKey && (
        // key= remounts the control when the ladder moves on to a different
        // window, so a fresh one is offered instead of the previous answer
        // sitting over the next firm's name.
        <WindowCheck key={today.windowKey} windowKey={today.windowKey}
                     firm={today.firms?.[0] || "it"} />
      )}
      {alsoIfShort && (
        <p className="todayshort">
          Only got a few minutes?{" "}
          {alsoIfShort.href
            ? <a href={alsoIfShort.href}
                 target={alsoIfShort.href.startsWith("http") ? "_blank" : undefined}
                 rel="noreferrer">{alsoIfShort.title}</a>
            : alsoIfShort.title}
          {" — "}{time(alsoIfShort.minutes)}.
        </p>
      )}
      {alsoIfShort?.batchHref && (
        <p className="todaybatch">
          <a href={alsoIfShort.batchHref}>Do several at once</a> —{" "}
          {alsoIfShort.batchCount} windows are due a look.
        </p>
      )}
      {alsoIfShort?.windowKey && (
        <WindowCheck key={alsoIfShort.windowKey} windowKey={alsoIfShort.windowKey}
                     firm={alsoIfShort.firms?.[0] || "it"} />
      )}
    </section>
  );
}

export default function Daily({
  counter = null,
  items = [], deadlines = [], owed = [], cold = [], pulse = null, inFlight = [],
  worthALook = [], worthTotal = 0,
  savedRoles = [], actions = {}, appliedAt = {}, newSince = null, referrals = [],
  contactCounts = {},
  // From consultingBanner() in lib/consulting.js. Null renders nothing.
  consulting = null,
  contacts = 0, deadlineTotal = 0, verifiedTotal = 0, lowPayCount = 0,
  appliedWindows = {},
  today = null, alsoIfShort = null, nothingDue = false, frame = [],
  // From lib/ontrack.js. Beside the frame, because the frame says what the
  // CALENDAR is doing and this says what the owner is doing against it. Null when
  // the counts could not be read, which renders nothing rather than zeroes.
  onTrack = null,
  // The five people to write to today. Above everything else on the
  // page, because a person waiting is more time-sensitive than a role.
  five = [],
  horizonDays = 45,
  // { done, total, pct } over the windows still ahead of him — see
  // windowProgress() in lib/palette.js for why closed windows are excluded.
  windows = { done: 0, total: 0, pct: 0 },
  // How far along the multi-week projects are, keyed by the page that holds
  // them. Feeds the on-you rows that are really whole projects.
  progress = {},
  nextUp = {},
  startWith = null,
  firstFive = null,
  updated = { hoursAgo: null },
  // Rendered by the page, not here: it is an async server component and Daily
  // is called from one, so passing the element in keeps this a plain function
  // of its props and keeps `page.js` the only place that touches the database.
  rail = null,
  // Last week, on a Monday only. Null every other day — see lib/pulse.js.
  retro = null, weekOf = null,
  // Hours he has today, or null. Null means no trimming and no nagging.
  hours = null,
  // What the last cron run did. Null before the first one writes a row.
  run = null,
}) {
  // WHAT IS ACTUALLY ON HIM TODAY, not every row in the table.
  //
  // Splitting the two projects into 24 children turned "4 on you" into "28 on
  // you" overnight — a number that is true of the database and false about the
  // day. A child that has not been surfaced is explicitly NOT on him; that is
  // the entire point of surfacing one at a time.
  // the owner's date, not the server's. This was toISOString(), i.e. UTC, while
  // page.js wrote surfaced_on in Pacific — so from 5pm every evening the two
  // disagreed and every surfaced child vanished from the page.
  const todayStr = todayLocal();
  // ONE DEFINITION, in lib/display.js, shared with the list that renders it.
  //
  // This was a near-copy of the filter inside Items — and near is the problem:
  // it was missing `stalled`, so the header counted an item that the list had
  // already moved into its collapsed "1 stalled" group. "4 things on you" over
  // three visible rows, with the fourth reachable only by opening a <details>.
  // Two populations, one sentence about them, which is the exact shape the
  // Companies row taught this codebase to look for.
  const onYou = openItems(items, todayStr);
  const isNew = (r) =>
    newSince && r.first_seen && Date.parse(r.first_seen) > Date.parse(newSince);
  const newCount = [...savedRoles, ...worthALook].filter(isNew).length;

  // THE SERVER'S TIMEZONE IS NOT A DAY. Vercel runs in UTC, so the header read
  // "1 September" while the Monday retro — which correctly asked Pacific — was
  // still showing. One instant, two timezones, two answers on one screen.
  const now = new Date();
  const weekday = weekdayName(now);
  const date = longDate(now);

  // One line of plain status. Not four stat tiles.
  //
  // "Nothing saved yet" is gone from here. It described an empty table as though
  // it were today's news, and it was the first thing on the page every single
  // visit. What is left is only what changed.
  const bits = [];
  if (newCount) bits.push(`${newCount} new since your last visit`);
  // (a count with no noun needs no plural — "3 new" and "1 new" both read.)
  if (savedRoles.length) bits.push(`${savedRoles.length} saved`);
  // "4 on you" was guilt with no handle: a count that names nothing and offers
  // nothing. If it is going to sit there it has to say which one is rotting.
  const oldest = onYou
    .filter((i) => i.dueIn !== null && i.dueIn < 0)
    .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0)
                 || String(a.id).localeCompare(String(b.id)))[0];
  if (onYou.length) {
    // "4 on you" counted the item the ladder had ALREADY promoted to the top of
    // this page, so the number disagreed with the list directly beneath it: he
    // could clear every row and still be told four things were on him. The
    // ladder's pick is named separately because it is not waiting — it is the
    // thing he is being asked to do right now.
    const promoted = today?.itemId
      && onYou.some((i) => String(i.id) === String(today.itemId));
    const waiting = onYou.length - (promoted ? 1 : 0);
    const head = waiting === 0
      ? "just today's one thing"
      : `${plural(waiting, "thing")} on you${promoted ? ", plus the one above" : ""}`;
    bits.push(oldest && oldest.ageDays >= 1
      ? `${head} · oldest untouched ${plural(oldest.ageDays, "day")}`
      : head);
  }

  // One accent per close date. Three firms sharing 2026-09-30 is one fact.
  const accented = accentedDeadlines(deadlines);

  return (
    <div className="withrail">
    <div className="brief">
      <header className="dateline">
        <span className="weekday">{weekday}</span>
        <h1 className="date">{date}</h1>
        <hr />
        {/* Freshness, stated. The cron runs at 07:10 and fails quietly, so the
            failure mode is silently old data — which must never look current. */}
        {/* A FAILED RUN MUST NOT READ AS CALM. The freshness stamp is computed
            from the newest job row, which answers "is the data fresh" and
            cannot answer "did this morning's run fail" — a failure leaves
            yesterday's data looking exactly like a run with nothing new to
            fetch. `run` is written by the workflow at the end of its own run,
            so this line can say so and link to the log. */}
        <p className={`freshness${
          updated.hoursAgo === null || updated.hoursAgo > 36 ? " stale" : ""}${
          run && run.status && run.status !== "success" ? " failed" : ""}`}>
          {run && run.status && run.status !== "success" ? (
            <a href={run.run_url || "#"} target="_blank" rel="noreferrer">
              Last update failed — click to see why
            </a>
          ) : (
            <>
              {updated.hoursAgo === null
                ? "Never updated — run daily_run.ps1"
                : updated.hoursAgo < 2
                  ? "Updated just now"
                  : updated.hoursAgo < 36
                    ? `Updated ${updated.hoursAgo} hours ago`
                    : `LAST UPDATED ${Math.floor(updated.hoursAgo / 24)} DAYS AGO — the daily run has not fired`}
              {/* THE DOT AND THE WORDS MUST AGREE. The link read "the run"
                  beside a green dot, and the whole line uppercases, so the
                  freshness stamp rendered as "UPDATED JUST NOW ● THE RUN" —
                  which reads as truncated copy rather than as a status. The dot
                  was already carrying the verdict; the words now carry the same
                  one, and the tick means the reader does not have to know that
                  a green dot is good. */}
              {run && run.run_url && (
                <>
                  <span className="runsep" aria-hidden="true"> · </span>
                  <a className="runlink" href={run.run_url} target="_blank" rel="noreferrer"
                     title="Open this morning's run log on GitHub">
                    <span className="rundot ok" aria-hidden="true" />
                    last run <span className="runtick" aria-hidden="true">✓</span>
                    <span className="visually-hidden"> succeeded</span>
                  </a>
                </>
              )}
            </>
          )}
        </p>
        {/* Where this sits in the cycle. Every figure is computed — months to
            graduation, what closes, what opens, and how many windows have no
            date at all. There is no "on track" score and there will not be one:
            nothing here knows what on track means, and a number that cannot be
            derived is a number that was invented. */}
        {/* AHEAD OR BEHIND, above the frame. The frame is four computed facts
            about the calendar; this is three counts against targets the owner
            set. No score, no encouragement -- "Behind on all three" said
            flatly is the whole value of it. */}
        {onTrack?.line && (
          <p className={onTrack.red ? "frame alert" : "frame"}>
            {onTrack.line}
          </p>
        )}

        {/* ALWAYS RENDERED, including empty. TodaysFive has an empty
            state that names the two ways to stage someone, and gating
            it on five.length meant that state could never appear --
            an empty section written and then made unreachable. */}
        <TodaysFive people={five} />

        {frame.length > 0 && (
          <p className="frame">
            {/* The separator trails its own fact rather than leading the next
                one, so a wrap leaves "... 33 days ·" at the end of a line
                instead of starting the next with a stray dot. */}
            {frameSentences(frame).map((b, i) => (
              <span className="framebit" key={i}>
                {b}
                {i < frame.length - 1 && <span className="sep">·</span>}
              </span>
            ))}
          </p>
        )}
        {bits.length > 0 && (
          <p className="status">
            {bits.map((b, i) => (
              <span key={i}>
                {i > 0 && <span className="sep">·</span>}
                {b}
              </span>
            ))}
          </p>
        )}
        {/* THE THREE ROLLING CONSULTING WINDOWS, above the ladder rather than
            in it. They cannot reach the ladder's window tier: that tier ranks
            on a close date and these carry an estimate on a window whose own
            note says roles close as they fill. Same component and same
            function as the digest uses, so the page and the email cannot
            disagree about whether a firm is still outstanding. */}
        {/* THE COUNTER, above the ladder and above the banner. Everything
            else on this page measures what the pipeline found; this measures
            what the owner did with it, which is the only number that changes the
            outcome. Same function as the digest, so the page and the email
            cannot disagree. It reads zero today, and saying so plainly is the
            point rather than an embarrassment. */}
        <SubmissionCounter counter={counter} />
        <ConsultingBanner consulting={consulting} />
      </header>

      {/* ABOVE the day's task, because it is context for choosing, not a
          thing to do. Below it, it would be a report you scroll past. */}
      <Retro retro={retro} weekOf={weekOf} />

      {/* ABOVE the TODAY card and quieter than it. This is setup that finishes;
          the card is the thing that comes back every morning. It shows only
          what is not already done — see lib/firstfive.js — so it shortens by
          itself and disappears when the work is over. */}
      {firstFive && <FirstFive state={firstFive} />}

      <Today hours={hours} today={today} alsoIfShort={alsoIfShort} nothingDue={nothingDue}
             horizonDays={horizonDays} appliedWindows={appliedWindows} />

      {savedRoles.length > 0 && (
        <Section id="saved" title="Saved">
          <div>
            {savedRoles.map((j) => (
              <Role key={j.groupKey} j={j} actions={actions} isNew={isNew(j)}
                    appliedAt={appliedAt[j.groupKey]} referrals={referrals}
                    contactCounts={contactCounts} />
            ))}
          </div>
        </Section>
      )}

      <Section id="onyou" title="On you">
        <Explainer id="on-you-why" short="Things the tool can't do for you">
          Things the tool can&apos;t do for you. Check them off as you go.
        </Explainer>
        {/* The ladder's pick stays in the open list even when the stall rule
            would collapse it — see Items for why. */}
        <Items items={items} promotedId={today?.itemId || null} progress={progress}
               nextUp={nextUp} />
      </Section>

      <Section id="closing" title="Closing soon">
        {/* Full paragraph the first time, one line and an expander after he
            says he has read it. A standing explanation on a page opened every
            morning is what the eye learns to jump over — and once it jumps, it
            jumps over the rows underneath too. */}
        <Explainer id="closing-soon-why" short="Consulting, VC and APM never appear here">
          Application windows inside {horizonDays} days. The three categories below
          never appear in the inbox — you check them yourself. An
          &ldquo;estimated&rdquo; chip means nobody has read that date off the
          firm&apos;s own site; it came from a tracker or from last year. One was
          wrong by seven weeks once, which would have cost a whole recruiting cycle.
        </Explainer>
        {deadlines.length ? (
          <ol className="items">
            {deadlines.map((d, i) => {
              const h = horizon(d.closeIn, "deadline");
              // THREE levels now, not one orange. accentedDeadlines still picks
              // the single row per close date that earns extra weight — Deloitte,
              // Accenture and EY-Parthenon all close 2026-09-30 and that is one
              // fact — but the level itself is shown on every row, because
              // "closes in 33 days" and "closes in 3 days" are not the same news
              // and used to be the same colour.
              const loud = h.urgent && accented.has(`${d.firm}|${d.program}`);
              return (
                <li className="item" key={d.firm + d.program}>
                  <span className="ord" />
                  <span className="what">
                    <CategoryDot category={categoryOfFirm(d.firm)} />
                    {d.firm}
                    {/* Amber outline, because an unconfirmed date is the whole
                        risk on this page and a faint grey tag said the opposite. */}
                    {/* The one chip component. It carries its own 8px gap, so
                        this can never again sit flush against the firm name and
                        read as part of it. */}
                    <VerificationChip confidence={d.confidence} />
                  </span>
                  <span className={`when${loud ? " lead" : ""}`}>
                    <UrgencyChip
                      days={d.closeIn}
                      kind={d.deadline_kind === "self" ? "self" : "external"}
                      label={h.label}
                      explain={i === 0}
                    />
                  </span>
                  <span className="why">{d.program}. {d.note}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="nothing">Nothing closing inside {horizonDays} days.</p>
        )}
        {/* The four windows that HAVE a date are the reassuring half. Showing
            only those tells the owner the opposite of the truth: the risk is the
            ones nobody is watching, and a missed one costs a cycle. */}
        {/* The tool's own stated biggest risk, drawn rather than asserted.
            ONE POPULATION on both ends: `windows` counts only windows still
            ahead of him — a closed one and one for another graduating class are
            not dates anybody is waiting on. The sentence this replaces read
            "{undated} of {total}" where undated excluded those and total counted
            them, so the two halves of one sentence came from different sets. */}
        {windows.total > 0 && windows.done < windows.total && (
          <>
            <Meter
              done={windows.done}
              total={windows.total}
              id="window-progress"
              label={
                <>
                  <span className="mstrong">
                    {windows.total - windows.done} of {windows.total} live windows
                    still have no close date.
                  </span>{" "}
                  Confirming one takes about ten minutes, and it is what the top of
                  this page keeps asking for until they are done.{" "}
                  <a href="/forecast#confirm">Confirm dates</a>.
                </>
              }
            />
          </>
        )}
        {/* Four lines of standing explanation directly under a section whose
            own Explainer already says the short version. Folded for the same
            reason as the rest: it is true every day and reads the same every
            day, and a paragraph you have read forty times is one your eye
            learns to jump — taking the rows under it along. */}
        <Explainer id="three-categories" className="note"
                   short={`All ${deadlineTotal} windows are on Forecast — you apply to these directly`}>
          <strong>Three categories never appear in the inbox</strong> and never will:
          consulting, VC and growth equity, and big-tech APM programmes. All run
          Workday or custom systems this tool cannot read. Google&apos;s APM window
          last cycle was 28 days long. <strong>You apply to these directly.</strong>{" "}
          All {deadlineTotal} are on <a href="/forecast">Forecast</a>;{" "}
          {/* COMPUTED. This read "only one date in the whole set has been read
              from a firm's own site" as a literal, so the first date the owner
              confirms by hand would have made the page state a falsehood — the
              same shape as the nav badge that said "inside 21 days" after the
              horizon moved to 45. */}
          {verifiedTotal === 0
            ? "not one date in the set has been read from a firm's own site"
            : verifiedTotal === 1
              ? "only one date in the whole set has been read from a firm's own site"
              : `${verifiedTotal} of them have been read from a firm's own site`}.
        </Explainer>
      </Section>

      {/* NETWORKING. Two sections that were structurally impossible until the
          people tables existed: "Follow-ups owed" read an empty source and
          rendered "None owed" forever, which looks exactly like a quiet day.
          A section backed by a never-populated table is not a quiet day, it is
          a feature nobody has started — so with nobody on the list it becomes
          the setup action instead of a headstone. */}
      {contacts === 0 ? (
        <Section id="people" title="People">
          {/* FOUR LINES OF ARGUMENT WHERE ONE ACTION BELONGS.
              The referral thesis is right, and it is on /about twice already —
              repeating it here every morning is asking the owner to re-read the
              case for a thing he has already decided to do. What an empty
              section needs is the smallest next step and how long it takes.
              The name comes from the Companies "start here" ranking, so this
              and that queue can never point at different companies. */}
          <p className="nothing">
            Nobody yet.{" "}
            {startWith
              ? <>Start with <strong>{startWith}</strong> — two names, about ten minutes.</>
              : <>Two names at one company is the whole first step.</>}{" "}
            <a className="railbtn" href="/people?add=1">Add the first name</a>
          </p>
          <Explainer id="why-people" short="Why people, and not more applications?">
            A referral is what your own gap data says gets past a CS-degree
            screen and a clearance requirement — the two blockers that appear in
            nearly every set of gaps the scorer writes. Names go in by hand,
            from the {OWNER.schoolShort} alumni directory and warm intros.{" "}
            <a href="/about">The rest of the reasoning is on /about</a>.
          </Explainer>
        </Section>
      ) : (
      <Section
        id="people"
        title="Follow-ups owed"
        note={owed.length > OWED_SHOWN && (
          <span className="h2note"> — showing {OWED_SHOWN} of {owed.length}, oldest first</span>
        )}
      >
        <Explainer id="owed-why" short="Two follow-ups, then it stops asking">
          Worked out from what actually happened, not from a list anyone keeps up
          to date. Two follow-ups, then it stops asking.
        </Explainer>
        {owed.length ? (
          <ol className="items">
            {owed.slice(0, OWED_SHOWN).map((o) => (
              <li className="item" key={o.id + o.what}>
                <span className="ord" />
                <span className="what">
                  <a href={`/people?open=${encodeURIComponent(o.id)}`}>{o.what}</a>
                  <span className="sep"> · </span>
                  <span className="dim">{o.display_name}</span>
                </span>
                {/* NO urgency colour here, deliberately. Everything in this
                    list is already owed, so painting them all red would make
                    red mean "is in this list" — and red is spent on a window
                    closing, which is the unrecoverable thing. The order is the
                    priority: oldest first, and the day count says how long. */}
                <span className="when">
                  {o.days === 0 ? "today" : `${o.days}d`}
                </span>
                <span className="why">
                  {o.why}
                  <OwedActions item={o} />
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="nothing">
            Nobody is waiting on you. {plural(contacts, "person", "people")} on
            the list. <a href="/people">See them</a>.
          </p>
        )}

        {/* Informational, never a task. There is no action attached to somebody
            going cold — either the cadence has correctly stopped asking, or the
            ball is with them — and putting it in a to-do list makes the list
            unfinishable. */}
        {cold.length > 0 && (
          <p className="warn">
            <strong>{cold.length} going cold.</strong>{" "}
            {cold.slice(0, 4).map((c, i) => (
              <span key={c.id}>
                {i > 0 && <span className="sep"> · </span>}
                {c.name} ({c.coldFor}d)
              </span>
            ))}
            {cold.length > 4 && <span className="dim"> and {cold.length - 4} more</span>}
            . Nothing to do about it — it is here so it is not a surprise.
          </p>
        )}
      </Section>
      )}

      {/* THE WEEK, in three numbers. No streaks and no badges: a streak turns a
          missed week into a reason to stop opening the page, and an empty
          "0 of 5" on a Tuesday is its own motivation. */}
      {pulse && (
        <Section id="thisweek" title="This week">
          <Meter
            done={pulse.sent}
            total={pulse.target}
            id="daily-pulse"
            label={
              <>
                <span className="mstrong">
                  {pulse.sent} of {pulse.target} messages sent this week.
                </span>{" "}
                {plural(pulse.replies, "reply", "replies")} back
                {" · "}{plural(pulse.calls, "call")} booked.
                Resets Monday. <a href="/people">People</a>.
              </>
            }
          />
        </Section>
      )}

      {/* IN FLIGHT. What happened after "worth a look" — the half of the search
          this tool could not see at all, because a role was either visible or
          not and there was nowhere to record that anything came of it.
          Longest-waiting first: the thing that has not moved is the thing that
          needs a decision, and sorting by stage buries it under whatever
          happens to be furthest along. */}
      {/* The empty state is a NEXT ACTION, and only when there is one.
          A section reading "no applications yet" on a page where nothing has
          been saved either is a headstone — the same thing three sections of
          this page used to be, which is why it got closed. It appears once
          there is something saved to apply TO, and says so. */}
      {inFlight.length === 0 && (
        <Section id="inflight" title="In flight">
          <p className="nothing">
            Nothing in flight yet. Applications appear here once you mark one
            submitted — including the consulting ones the tool cannot see, from
            the checklist above.
          </p>
        </Section>
      )}

      {inFlight.length > 0 && (
        <Section
          id="inflight"
          title="In flight"
          note={<span className="h2note">
            {" "}— {plural(inFlight.length, "application")} still live
          </span>}
        >
          <ol className="items">
            {inFlight.map((f) => (
              <li className="item" key={f.id}>
                <span className="ord" />
                <span className="what">
                  <CategoryDot category={categoryOfCompany(f.company)} />
                  {f.display_name}
                  <span className="sep"> · </span>
                  {f.title}
                  {/* Only so he knows this one will never move on its own —
                      no board reports back on a Workday form. */}
                  {f.kind === "manual" && (
                    <span className="tag-open faint"
                          title="Recorded by you. Nothing fetches updates for this one.">
                      manual
                    </span>
                  )}
                </span>
                {/* Counts UP. A countdown implies progress; days-in-stage is
                    the honest number for something nobody has answered. */}
                <span className="when">{LIFECYCLE_LABEL[f.status]}</span>
                <span className="why">
                  {plural(f.daysInStage, "day")} in this stage
                  {f.withReferral === true && " · a referral got you in"}
                  {f.withReferral === false && " · applied cold"}
                  {/* Graphite, never accented. A stalled application is not a
                      deadline; nothing is running out, it is just quiet. */}
                  {f.nudge && (
                    <span className="lifenudge">
                      {" "}— {f.daysInStage} days without a response, consider a nudge.
                      {/* A deadline firm has no slug and therefore no contacts
                          page to point at. Say the thing, drop the link. */}
                      {f.company ? (
                        <>
                          {" "}
                          <a href={`/people?co=${encodeURIComponent(f.company)}`}>
                            Who do you know at {f.display_name}?
                          </a>
                        </>
                      ) : null}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {/* ONE list, replacing "Strong on both" and "Highest fit". Those two
          answered nearly the same question and disagreed about the answer. */}
      <Section id="worth" title="Worth a look today">
        {/* THE FACT AND THE EXPLANATION ARE DIFFERENT THINGS and only one of
            them repeats. "Saved first, then new, then by fit" is true every day
            and reads the same every day; "showing 8 of 34" changes with the
            data and is the reason to click. Folding both would hide a live
            number behind a "why?", so only the ordering rule folds. */}
        <Explainer id="worth-order" short="Saved first, then new, then by fit">
          Saved first, then new, then by fit. Click a row for why.
        </Explainer>
        {worthTotal > worthALook.length && (
          <p className="sub">
            Showing {worthALook.length} of {worthTotal} that fit — the ones below
            the line aren&apos;t worse, just further down the tie-break.{" "}
            <a href="/inbox?worth=1&amp;min=40&amp;cap=2">See all {worthTotal}</a>.
          </p>
        )}
        {worthALook.length ? (
          <div>
            {/* The opening clause on every row, so every row is the same
                height. `fullAngle` is gone rather than defaulted to false: a
                prop nothing passes is a prop somebody sets again by accident. */}
            {worthALook.map((j) => (
              <Role key={j.groupKey} j={j} actions={actions} isNew={isNew(j)}
                    appliedAt={appliedAt[j.groupKey]} referrals={referrals}
                    contactCounts={contactCounts}
                    withAngle />
            ))}
          </div>
        ) : (
          <p className="nothing">
            Nothing qualifies today. If that keeps happening the filters are too
            tight — start from <a href="/inbox?min=0">the inbox</a>.
          </p>
        )}
      </Section>

      {/* The pay caveat is four lines of standing disclaimer at the foot of a
          page opened every morning. It is worth saying once and worth keeping
          one press away; it is not worth re-reading daily. */}
      <Explainer id="pay-caveat" className="note"
                 short="Pay shown is base salary only — equity is not captured">
          Pay is <strong>base salary only</strong>.{" "}
          {/* THE ONE NUMBER ON THIS PAGE THAT WENT NOWHERE. It states a fact
              about the corpus and offers no way to see what it is describing,
              which makes it a caveat rather than a finding. The link carries
              the same predicate the count uses — comp_min published AND under
              90000, no score floor, no per-company cap — so the list is the
              rows the sentence is about rather than a near-miss. */}
          <a href="/inbox?min=0&amp;maxpay=90000&amp;cap=0"
             /* THE TWO NUMBERS WILL NOT MATCH EXACTLY, and the link says so
                rather than letting you discover it. This counts POSTINGS; the
                inbox groups a role posted in several cities into one row, so it
                lands on fewer. Same population, two ways of counting it — which
                is the one case where the rule is satisfied by saying which. */
             title={`${lowPayCount} postings. The inbox groups a role listed in `
                    + "several cities into one row, so it shows fewer rows than that."}>
            {lowPayCount} reachable roles
          </a>{" "}
          publish a base under $90K. Equity is not captured: 457 of 706 postings
          mention it and exactly one attaches a number. Palantir and Saronic publish
          no pay on any role, so &ldquo;not published&rdquo; there is policy, not
        missing data. <a href="/about">How all of this works</a>.
      </Explainer>

      <CategoryLegend
        only={new Set([
          ...worthALook.map((j) => categoryOfCompany(j.company)),
          ...savedRoles.map((j) => categoryOfCompany(j.company)),
          ...deadlines.map((d) => categoryOfFirm(d.firm)).filter(Boolean),
        ])}
        note={URGENCY_SENTENCE}
      />
    </div>
    {/* Below 1200px this renders nothing and every piece of it falls back to
        where it already lived further down the page. Nothing is lost on a
        phone; it is re-flowed. */}
    {rail}
    </div>
  );
}
