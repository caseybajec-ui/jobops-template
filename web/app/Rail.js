import { Meter } from "./Palette";
import Hours from "./Hours";
import { monthToDate } from "@/lib/cost";
import { plural, pluralWord, outOf } from "@/lib/plural";
import { LIFECYCLE_LABEL } from "@/lib/lifecycle";
import SectionNav from "./SectionNav";

/**
 * The state of the search, on the right, on a wide screen.
 *
 * WHY IT EXISTS. Daily was a phone column blown up onto a desktop canvas: a
 * 1100px measure down the middle with 300px of empty page either side, and the
 * four facts that frame the whole cycle crushed into a 9px mono line joined
 * with dots — a shape the eye skips. Everything that answers "where am I" was
 * BELOW the fold, so the page opened on one task with no context and the
 * context was three scrolls away, which is to say it was never read.
 *
 * The rail is not new information. It is the same numbers, computed by the same
 * functions, moved into the space that was already empty and given labels. On a
 * 1440px screen the date, the day's one task, and the whole of this are visible
 * without scrolling; below 1200px it disappears entirely and every piece falls
 * back to where it already lived, so nothing is lost on a phone.
 *
 * ORDER IS ARGUED, not decorative. Cycle position first, because it is the only
 * thing here that answers "should I be worried"; then the one piece of work
 * that moves the biggest number (16 windows with no date); then the two
 * measures of whether the search is actually running — messages this week, and
 * applications still alive. Cost is last because it is an implementation detail
 * he checks monthly, and it has already sat too loud once.
 */
export default async function Rail({
  frame = [], windows = { done: 0, total: 0 }, pulse = null, inFlight = [],
  hours = null, day = null,
}) {
  const { spent, cap, measured, since } = await monthToDate();
  // The window this figure covers, said out loud. It used to sum from a fixed
  // reset date forever under a heading reading "This month", so on 1 September
  // it was still counting August.
  const windowFrom = String(since).slice(0, 10);
  const over = spent >= cap;

  // Counts by stage, in lifecycle order rather than by size, so the shape of
  // the funnel is readable: three applied and no screens says something a
  // sorted list would hide.
  const byStage = new Map();
  for (const f of inFlight) byStage.set(f.status, (byStage.get(f.status) || 0) + 1);

  return (
    <aside className="rail" aria-label="Where the search stands">
      {frame.length > 0 && (
        <section className="railblock">
          <h2 className="railhead">Where you are</h2>
          <dl className="railstats">
            {frame.map((f) => (
              <div className={`railstat${f.aside && f.aside.length > 12 ? " wide" : ""}`} key={f.key}>
                <dt>{f.label}</dt>
                <dd>
                  {f.value}
                  {/* The wider total as an ASIDE, never as a second
                      denominator. "16 of 21" and "16 of 25" were both on this
                      page, each correct beside the other. */}
                  {f.aside && <>{" "}<span className="railaside">{f.aside}</span></>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {day && (
        <section className="railblock">
          <h2 className="railhead">Today</h2>
          {/* The ladder knows what every task COSTS and has never known what he
              HAS, so it offers a three-hour composite on a forty-minute day. */}
          <Hours hours={hours} day={day} />
        </section>
      )}

      {windows.total > 0 && windows.done < windows.total && (
        <section className="railblock">
          <h2 className="railhead">Dates nobody is watching</h2>
          <Meter done={windows.done} total={windows.total} id="rail-windows" />
          <p className="railnote">
            {outOf(windows.total - windows.done, windows.total, "live window")}{" "}
            {pluralWord(windows.total - windows.done, "has", "have")} no close date.
            About ten minutes each.
          </p>
          <a className="railbtn" href="/forecast#confirm">Confirm one now</a>
        </section>
      )}

      {pulse && (
        <section className="railblock">
          <h2 className="railhead">This week</h2>
          <Meter done={pulse.sent} total={pulse.target} id="rail-pulse" />
          <p className="railnote">
            {pulse.sent === 0 && pulse.replies === 0 && pulse.calls === 0
              ? "Nothing logged yet. Two messages and one application will start filling this in."
              : `${outOf(pulse.sent, pulse.target)} messages · `
                + `${plural(pulse.replies, "reply", "replies")} · `
                + `${plural(pulse.calls, "call")} booked`}
          </p>
          <a className="railbtn" href="/people">
            {pulse.sent === 0 ? "Add the first person" : "People"}
          </a>
        </section>
      )}

      <section className="railblock">
        <h2 className="railhead">In flight</h2>
        {inFlight.length === 0 ? (
          <p className="railnote">
            Nothing in flight yet. Applications appear here once you mark one
            submitted.
          </p>
        ) : (
          <ul className="railflight">
            {[...byStage].map(([stage, n]) => (
              <li key={stage}>
                <span className="railflightlabel">{LIFECYCLE_LABEL[stage] || stage}</span>
                <span className="railflightn">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The same number the topbar shows, from the same function — and the
          topbar's copy is hidden while this is on screen, because one figure
          rendered twice on one page is a figure you check twice and trust once.
          The "~" is load-bearing: the meter prices stored request counts and
          ignores cache-write tokens, so it is a FLOOR, and saying so is the
          difference between a number and a guess. */}
      <section className="railblock railcost">
        <h2 className="railhead">
          {windowFrom.endsWith("-01") ? "This month" : "Since the reset"}
        </h2>
        <div className={`costwrap${over ? " over" : ""}`}>
          <span className="mono railspend">
            {measured ? "" : "~"}${spent.toFixed(2)}
            <span className="railcap"> of ${cap.toFixed(2)}</span>
          </span>
          <span className={`costbar${over ? " over" : ""}`} aria-hidden="true">
            <span className="costfill"
                  style={{ width: `${cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0}%` }} />
          </span>
        </div>
        <p className="railnote">
          <span title={`Counted from ${windowFrom}. The cap is monthly; the `
            + "window starts on the 1st, or at the cap reset when that is later."}>
            from {windowFrom}
          </span>{" · "}
          {over ? "Over the hard cap. Nothing more will score." : null}
          {!over && !measured
            ? "A floor — some batches have no measured usage yet and price low."
            : null}
          {!over && measured ? "Measured from actual token usage." : null}
        </p>
      </section>

      {/* LAST, under the cost block, because everything above it is a fact
          about the search and this is a fact about the page. It renders after
          mount from what is actually on screen — see SectionNav for why a
          hand-kept list here would eventually link to a section that is not
          there. */}
      <SectionNav />
    </aside>
  );
}
