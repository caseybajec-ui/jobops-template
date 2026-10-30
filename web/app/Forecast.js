/* Forecast — two tables: what is open now, and when class-year roles tend to appear.
 *
 * This page rendered as running text for weeks because it was written against a
 * CSS vocabulary (.filters, .fc, .cbadge, .dl-*) that was never added to
 * globals.css, and it was never wrapped in .sheet, so it had no column limit
 * either. It now uses the same grid-row component as Companies and Inbox.
 *
 * Every company here is a display name. Reading j.company gave slugs on screen:
 * hadrian-automation, bvpanalyst, andurilindustries, trueanomalyinc.
 */

import { compareWindows, STALE_DAYS, windowKey, windowDateCell } from "@/lib/display";
import { VERIFICATION_LABEL } from "@/lib/chips";
import { USER_CLASS_YEAR } from "@/lib/constants";
import { VerificationChip, UrgencyChip } from "./Chip";
import {
  categoryOfFirm, categoryOfCompany, provenanceClass,
  urgencyClass, windowProgress, URGENCY_NOW_DAYS, URGENCY_SOON_DAYS,
} from "@/lib/palette";
import { CategoryDot, CategoryLegend, Meter } from "./Palette";
import WindowCheck from "./WindowCheck";
import ConfirmFocus from "./ConfirmFocus";
import TrackApplication from "./TrackApplication";
import Hint from "./Hint";
import Explainer from "./Explainer";

/* ONE VOCABULARY FOR ONE FACT.
 *
 * This page had its own confidence words — "from firm's site" / "secondary
 * source" / "estimate" — while Daily rendered the identical three states
 * through VerificationChip as "confirmed" / "2 trackers" / "estimated". Same
 * data, same three values out of companies.yaml, two sets of words on two
 * pages, and no way for a reader to know they were the same scale.
 *
 * The colour was already shared, which made it worse rather than better: the
 * two agreed on the hue and disagreed on the noun. The chip component is the
 * single renderer now, and the local table is gone.
 *
 * The wrong-class-year row below still needs a plain grey label — see the note
 * there — so the words it uses come from the chip's own map rather than a
 * second copy of them. */
const EVIDENCE = { good: "reliable", weak: "weak" };

function DeadlineRow({ d, tracked = false, explain = false }) {
  return (
    <div className="drow">
      <span className="co">
        <CategoryDot category={categoryOfFirm(d.firm)} />
        {d.firm}
      </span>
      <span className="title">{d.program}</span>
      {/* The firm's date, "rolling — no cutoff", or "not confirmed" — never a
          planning target, which has its own table below and its own words. */}
      <span className="mono">{windowDateCell(d).text}</span>
      {/* Three levels, from one shared rule. This was a hand-written `<= 21`
          that agreed with nothing else in the app: the horizon everywhere else
          is 45, so a window closing in 30 days rendered grey here and orange on
          Daily, off the same row of the same file. */}
      <span className={`mono days ${urgencyClass(d.closeIn)}`}>
        {d.closeIn === null
          ? "—"
          : d.closeIn < 0
            ? `${Math.abs(d.closeIn)}d ago`
            : `${d.closeIn}d left`}
      </span>
      <span>
        {/* The same component Daily uses, with the scale explained on the
            first row — the "?" was on Closing soon's chip and on nothing
            here, so the identical mark meant two different amounts of
            certainty depending on which page you were reading. */}
        <VerificationChip confidence={d.confidence} explain={explain} />
      </span>
      <span className="dnote">
        {d.note}
        {/* The only way into the tracker for a window the ladder has not
            surfaced. Without it, recording an application to a firm with no
            job board meant waiting for that firm to come up on Daily. */}
        <span className="trackwrap">
          <TrackApplication window={d} tracked={tracked} />
        </span>
      </span>
    </div>
  );
}

function ClosedRow({ d }) {
  const when =
    d.status === "closed"
      // A window can be closed without a recorded date — "the summer role
      // is no longer live" is a closure; "closed null" was what it rendered as.
      ? (d.closes ? `closed ${d.closes}` : "closed — no date recorded")
      : d.status === "wrong_class_year"
        ? `class of ${d.class_year}`
        : windowDateCell(d).text;
  return (
    <div className="drow">
      <span className="co dim">
        <CategoryDot category={categoryOfFirm(d.firm)} />
        {d.firm}
      </span>
      <span className="title dim">{d.program}</span>
      <span className="mono dim">{when}</span>
      <span className="mono dim">—</span>
      <span>
        {/* v-none, not the live chip colour. These windows are closed or for
            another class year; colouring their evidence would put four amber
            chips on the page for dates nobody is waiting on. */}
        {/* Deliberately NOT the chip: these windows are for another class
            year, so colouring their evidence would put amber on dates nobody
            is waiting for. The words still come from the chip's own map, so
            one table cannot start calling it something else. */}
        <span className="label v-none">
          {VERIFICATION_LABEL[d.confidence] || VERIFICATION_LABEL["historical-estimate"]}
        </span>
      </span>
      <span className="dnote">{d.note}</span>
    </div>
  );
}

/* A DATE THE OWNER SET, NOT ONE THE FIRM DID.
 *
 * ZS has no national date; his plan says materials ready by 15 September. That
 * is a real thing to track and a dangerous thing to render: put in the same
 * column as Analysis Group's 9 September it reads as a cutoff, gets a countdown,
 * and gets treated as the day the cycle is lost — or, worse, as the day it is
 * safe to wait for when the real posting lands earlier. So these rows never
 * share a table with deadlines. The date cell says "your target", the day
 * count is the OUTLINED chip the app already uses for self-imposed dates, and
 * the confidence chip says whose date it is rather than how sure anyone is. */
function TargetRow({ d, explain = false }) {
  return (
    <div className="drow">
      <span className="co">
        <CategoryDot category={categoryOfFirm(d.firm)} />
        {d.firm}
      </span>
      <span className="title">{d.program}</span>
      {/* Two short lines, not one long one: the full sentence from
          windowDateCell wraps to three lines in a 104px column. The word
          stays — a bare date in this column would look exactly like a close. */}
      <span className="mono" title={windowDateCell(d).text}>
        <span className="lvl">yours</span><br />{d.target}
      </span>
      <span className="mono days">
        <UrgencyChip days={d.targetIn} kind="self" />
      </span>
      <span>
        <VerificationChip confidence={d.confidence} explain={explain} />
      </span>
      <span className="dnote">{d.note}</span>
    </div>
  );
}

export default function Forecast({ rows, deadlines, undated = [], trackedWindows = [],
                                  surfacedCompany = null }) {
  const tracked = new Set(trackedWindows);
  const open = deadlines
    .filter((d) => d.status === "open")
    .sort(compareWindows);
  // Planning targets are their own list, sorted by HIS date. They are not
  // "closed, unconfirmed, or for another class year" and they are not open —
  // they are the third thing, and folding them into either list is the bug.
  const targets = deadlines
    .filter((d) => d.confidence === "planning-target")
    .sort((a, b) => (a.targetIn ?? 9999) - (b.targetIn ?? 9999)
                 || String(a.firm).localeCompare(String(b.firm))
                 || String(a.program).localeCompare(String(b.program)));
  const rest = deadlines.filter(
    (d) => d.status !== "open" && d.confidence !== "planning-target");
  const fromSite = deadlines.filter((d) => d.confidence === "verified").length;
  const progress = windowProgress(deadlines);
  // TODAY'S ONE WINDOW, CHOSEN BY THE SCHEDULER — not by a second eligibility
  // rule computed here.
  //
  // This used to filter `undated` by the 14-day cooldown and, finding nothing,
  // announce "Nothing is due a check for 6 days" while the rail said "Confirm
  // one now" and Daily had surfaced a child. Three surfaces, three answers to
  // one question, and the two rules cancelled to zero-per-day.
  //
  // The scheduler decides WHETHER something is offered; the cooldown only ever
  // decided WHICH one comes next. So this reads the scheduler's pick.
  const slug = (f) => String(f).toLowerCase().replace(/[^a-z0-9]+/g, "-")
                              .replace(/^-|-$/g, "");
  const dueACheck = surfacedCompany
    ? undated.filter((d) => slug(d.firm) === surfacedCompany)
    // No pick means the weekend, or every window is dated. Both are real
    // states; neither is "the cooldown says not yet".
    : [];

  return (
    <div className="sheet">
      {/* Five lines of standing caveat, re-read every visit. The caveat is
          real and stays one press away; what it must not be is the first thing
          between you and the page, every time, forever. */}
      <Explainer id="forecast-intro"
                 short={`When each company tends to post its ${USER_CLASS_YEAR} roles — a hint, not a schedule`}>
        This page guesses when each company will post its {USER_CLASS_YEAR} roles,
        so you can have a relationship there before the posting goes up. It&apos;s
        built from when {USER_CLASS_YEAR}-dated roles first appeared. With only a
        few days of history
        it&apos;s a hint, not a schedule — it gets useful after a season of daily
        runs. Only Ashby and Rippling report real publish dates; the rest are weak
        signals and are labeled as such.
      </Explainer>

      {/* SIXTEEN WINDOWS AT ONE A DAY IS SIXTEEN DAYS. The Daily ladder offers
          one, which is right for a four-minute Tuesday and wrong for a Sunday
          afternoon. This is the same control, sixteen times, least-recently
          checked first — sit down once and clear six of them.

          No fourth nav item: Forecast already owns "when do windows open and
          close", and a permanent tab for a job that finishes in sixteen days is
          a permanent cost for a temporary task. */}
      <section className="section" id="confirm">
        <h2>
          Confirm dates{" "}
          <span className="h2note">
            — {undated.length} tracked windows have no close date at all
          </span>
        </h2>
        <Explainer id="confirm-dates-why"
                   short="Open the firm's page, then answer here — about ten minutes each">
          This is the risk in the whole page: nobody is watching these, and a
          missed one costs a cycle. Open the firm&apos;s own careers page, then
          answer here — a date if you found one, or just &ldquo;checked it&rdquo;
          so it moves to the back of the queue. About ten minutes each.
        </Explainer>

        {/* The same bar as Daily, from the same function, so the two pages can
            never disagree about how much of this job is done. */}
        <Meter
          done={progress.done}
          total={progress.total}
          id="forecast-progress"
          label={
            <>
              <span className="mstrong">
                {progress.done} of {progress.total} live windows have a close date.
              </span>{" "}
              {/* The bar's remainder is the plain track now, not an amber fill —
                  so this sentence had to stop pointing at a colour that is no
                  longer there. A label describing a bar that changed is a label
                  that quietly becomes wrong. */}
              The empty part is what nobody is watching.
            </>
          }
        />
        {/* The work, one at a time. The list below stays as the OVERVIEW —
            seeing the whole risk at once is the point of it — but sixteen
            identical rows is the worst possible shape for actually doing the
            job, because none of them is the next one. */}
        <ConfirmFocus
          windows={dueACheck}
          total={undated.length}
          nextDueIn={undated.length && !dueACheck.length
            ? Math.min(...undated.map((d) => STALE_DAYS - (d.verifiedAgo ?? 0)))
            : null}
        />

        {/* ONE LINE PER WINDOW. Every row carried a date input and a button on
            a second line whether or not that row was due, so sixteen windows
            cost thirty-two lines and none of them looked more next than any
            other — which is the exact complaint the focus card above exists to
            answer, restated by the list underneath it.
            Today's pick keeps its controls inline. Every other row is one grey
            line with "answer anyway", because a Sunday afternoon spent clearing
            six of these is a real thing to want and refusing it would be a
            different kind of nag. */}
        {undated.length ? (
          <ul className="confirmlist">
            {undated.map((d) => {
              const isToday = surfacedCompany && slug(d.firm) === surfacedCompany;
              return (
              <li key={windowKey(d)} className={isToday ? "cdue" : "cwaiting"}>
                <span className="cfirm">
                  <CategoryDot category={categoryOfFirm(d.firm)} />
                  {d.source
                    ? <a href={d.source} target="_blank" rel="noreferrer">{d.firm}</a>
                    : d.firm}
                </span>
                <span className="cprog">{d.program}</span>
                {/* SHORT ENOUGH TO STAY ON THE LINE. This read "checked 4d ago
                    — not due yet", which wants 193px in a 150px column, so it
                    wrapped on every row — and a list of sixteen one-line rows
                    was thirty-two lines for that reason alone, before the
                    control underneath added sixteen more. The full sentence is
                    on the tooltip, where a phrase nobody needs to scan belongs. */}
                <span
                  className="cwhen"
                  title={d.verifiedAgo === null
                    ? "Never checked"
                    : `Last checked ${d.verifiedAgo} days ago`
                      + (d.verifiedAgo < STALE_DAYS
                          ? ` — not due again for ${STALE_DAYS - d.verifiedAgo} days`
                          : " — due a check")}
                >
                  {d.verifiedAgo === null
                    ? "never checked"
                    : d.verifiedAgo === 0
                      ? "today"
                      : `${d.verifiedAgo}d ago`}
                </span>
                <WindowCheck windowKey={windowKey(d)} firm={d.firm}
                             collapsed={!isToday} />
              </li>
              );
            })}
          </ul>
        ) : (
          <p className="nothing">
            Every tracked window has a date. Nothing to confirm.
          </p>
        )}
      </section>

      <section className="section">
        <h2>Open now</h2>
        <Explainer id="open-now-why"
                   short="Windows you open yourself — none of these reach the inbox">
          Application windows you have to open yourself. None of these ever show up
          in the inbox.
        </Explainer>

        {open.length ? (
          <>
            <div className="drow head">
              <span>firm</span>
              <span>program</span>
              <span>closes</span>
              <span>days left</span>
              <span>confidence</span>
              <span>note</span>
            </div>
            {open.map((d, i) => (
              <DeadlineRow key={d.firm + d.program} d={d} explain={i === 0}
                           tracked={tracked.has(`window:${d.firm}|${d.program}`)} />
            ))}
          </>
        ) : (
          <p className="nothing">
            Nothing has a confirmed open window. Check the firms below by hand and
            update the dates in companies.yaml.
          </p>
        )}

        {targets.length > 0 && (
          <>
            <p className="sub" style={{ marginTop: 18 }}>
              <strong>Your planning targets.</strong> Dates you set for yourself,
              for firms that have published none. Not deadlines: the firm can post
              earlier, and a target is yours to move.
            </p>
            <div className="drow head">
              <span>firm</span>
              <span>program</span>
              <span>your target</span>
              <span>days to it</span>
              <span>whose date</span>
              <span>note</span>
            </div>
            {targets.map((d, i) => (
              <TargetRow key={d.firm + d.program} d={d} explain={i === 0} />
            ))}
          </>
        )}

        {rest.length > 0 && (
          <details className="more">
            <summary>
              {rest.length} closed, unconfirmed, or for another class year
            </summary>
            <div style={{ marginTop: 8 }}>
              {rest.map((d) => <ClosedRow key={d.firm + d.program} d={d} />)}
            </div>
          </details>
        )}

        <p className="note">
          {fromSite} of {deadlines.length} dates were read from the firm&apos;s own
          site. The rest are prompts to check, not facts — one of them being wrong
          would cost a whole recruiting cycle.
        </p>
      </section>

      <section className="section">
        <h2>{USER_CLASS_YEAR} posting forecast</h2>
        <p className="sub">
          When each company first posted a {USER_CLASS_YEAR}-dated role. Reliable rows come from
          a real publish date; weak rows are the best the source gives.
          <Hint id="evidence">
            Only two of the four job boards report when a posting actually went
            up. Greenhouse reports the last time anyone EDITED it and Lever
            reports when the requisition was created — Palantir has some dating
            to 2017. A weak row is a date, just not the date you want.
          </Hint>
        </p>

        {rows.length ? (
          <>
            <div className="frow head">
              <span>company</span>
              <span>earliest {USER_CLASS_YEAR} posting</span>
              <span>roles</span>
              <span>evidence</span>
            </div>
            {rows.map((r) => {
              const label = EVIDENCE[r.quality] || "weak";
              return (
                <div className="frow" key={r.company + r.source}>
                  <span className="co">
                    <CategoryDot category={categoryOfCompany(r.company)} />
                    {r.display_name}
                  </span>
                  <span className="mono">
                    {r.month} {r.earliestDate.slice(0, 4)}
                  </span>
                  <span className="num">{r.n}</span>
                  <span className="fnote">
                    <span className={`label ${provenanceClass(r.quality)}`}>{label}</span>{" "}
                    {r.quality === "good"
                      ? "real publish date"
                      : r.provenance === "last edited"
                        ? "last edit, not the original posting"
                        : "requisition created, not posted"}
                  </span>
                </div>
              );
            })}
          </>
        ) : (
          <p className="nothing">
            No {USER_CLASS_YEAR}-dated roles seen yet. This fills in as companies
            open their {USER_CLASS_YEAR} hiring.
          </p>
        )}
      </section>

      <CategoryLegend
        only={new Set([
          ...deadlines.map((d) => categoryOfFirm(d.firm)).filter(Boolean),
          ...rows.map((r) => categoryOfCompany(r.company)),
        ])}
        note={`Days left: red inside ${URGENCY_NOW_DAYS} days, gold inside ${URGENCY_SOON_DAYS}. Green chips are read from a firm's own site.`}
      />
    </div>
  );
}
