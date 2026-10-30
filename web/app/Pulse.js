import { MIN_N } from "@/lib/pulse";
import { SOURCE_LABEL } from "@/lib/people";
import { plural } from "@/lib/plural";
import { Meter } from "./Palette";
import Ask from "./Ask";

/**
 * Whether any of this is working.
 *
 * EVERY RATE HERE CAN REFUSE TO EXIST. One reply out of one message is not a
 * 100% reply rate, it is one reply, and a page that prints "100%" beside it
 * invites a decision the data cannot support. Below three, the rate is replaced
 * by its raw counts, which are true at any n.
 *
 * That is not caution for its own sake. This page's whole purpose is to tell
 * the owner whether alumni outreach beats cold outreach, and the temptation to read
 * a verdict out of four data points is exactly what it has to resist — the same
 * instinct as the deadline confidence labels, on a different surface.
 */

/** A rate, or the honest refusal to give one. */
function Rate({ r, unit = "" }) {
  if (!r.enough) {
    return (
      <span className="pnum">
        <span className="pfig dim">{r.hits}/{r.total}</span>
        <span className="pnote">too few to say — {MIN_N} needed</span>
      </span>
    );
  }
  return (
    <span className="pnum">
      <span className="pfig">{r.label}</span>
      <span className="pnote">{r.hits} of {r.total}{unit ? ` ${unit}` : ""}</span>
    </span>
  );
}

function Fig({ n, label, note = null }) {
  return (
    <span className="pnum">
      <span className={`pfig${n ? "" : " zero"}`}>{n}</span>
      <span className="pnote">{label}</span>
      {note && <span className="pnote dim">{note}</span>}
    </span>
  );
}

export default function Pulse({ pulse, ready = true }) {
  if (!ready) {
    return (
      <div className="sheet">
        <p className="nothing">
          The people tables are not in this database yet. They arrive with the
          next daily run.
        </p>
      </div>
    );
  }

  const { week, totals, applications: a } = pulse;
  const nothingYet = totals.sent === 0 && a.submitted === 0;

  return (
    <div className="sheet">
      <p className="page-intro">
        Whether the outreach and the applications convert. Every rate here needs{" "}
        {MIN_N} data points before it will show a percentage — under that it
        shows the counts instead, because one reply out of one is not a 100%
        reply rate.
      </p>

      {nothingYet && (
        <p className="nothing">
          Nothing logged yet. Two names on the People page and one application
          marked submitted will start filling this in — and until then there is
          genuinely nothing here to read, which is different from a broken page.
        </p>
      )}

      <section className="section">
        <h2>
          This week
          <span className="h2note"> — week of {pulse.weekOf}</span>
        </h2>
        <div className="pgrid">
          <Fig n={week.sent} label="messages sent" />
          <Fig n={week.replies} label="replies" />
          <Fig n={week.callsDone} label="calls done" />
          <Fig n={week.referralsAsked} label="referrals asked" />
          <Fig n={week.referralsReceived} label="referrals received" />
        </div>
      </section>

      <section className="section">
        <h2>Since the beginning</h2>
        <div className="pgrid">
          <Fig n={totals.sent} label="messages sent" />
          <Rate r={pulse.replyRate} unit="answered" />
          <Fig
            n={pulse.medianDays === null ? "—" : pulse.medianDays}
            label="median days to a reply"
            note={pulse.answered
              ? `over the ${plural(pulse.answered, "message")} that got one`
              : "nothing has been answered yet"}
          />
          <Fig n={totals.callsDone} label="calls done" />
          <Fig n={totals.referralsReceived} label="referrals received" />
        </div>
        {/* The exclusion, stated. A message that was never answered belongs in
            the RATE and not in the median: folding "never replied" in as a
            large number would be inventing an observation, and folding it in as
            zero would be worse. */}
        <p className="note">
          The median covers only messages that got a reply. One that never did
          counts against the reply rate and is left out of the timing, because a
          silence is not a duration.
        </p>
      </section>

      <section className="section">
        <h2>
          Reply rate by where the name came from
          <span className="h2note"> — the one breakdown that changes what you do next</span>
        </h2>
        {pulse.sources.length === 0 ? (
          <p className="nothing">
            Nothing sent yet, so there is nothing to compare.
          </p>
        ) : (
          <div className="row head srow">
            <span>source</span>
            <span className="num">sent</span>
            <span className="num">replied</span>
            <span className="num">rate</span>
            <span className="num">median days</span>
          </div>
        )}
        {pulse.sources.map((s) => (
          <div className="row srow" key={s.key}>
            <span>{SOURCE_LABEL[s.key] || s.key}</span>
            <span className="num mono">{s.total}</span>
            <span className="num mono">{s.hits}</span>
            <span className={`num${s.enough ? "" : " dim"}`}>{s.label}</span>
            <span className="num mono">
              {s.medianDays === null ? "—" : s.medianDays}
              {s.answered > 0 && s.answered < s.hits ? "" : ""}
            </span>
          </div>
        ))}
      </section>

      <section className="section">
        <h2>Applications</h2>
        <div className="pgrid">
          <Fig n={a.submitted} label="submitted" />
          <Fig n={a.screens} label="screens" />
          <Fig n={a.interviews} label="interviews" />
          <Fig n={a.offers} label="offers" />
          <Fig n={a.rejected} label="rejected" />
        </div>

        <h3 className="railhead">With a referral, and without</h3>
        <div className="pgrid">
          <Fig n={a.withRef} label="with a referral" />
          <Fig n={a.withoutRef} label="applied cold" />
          {/* NULL IS NEITHER, and it is shown rather than folded. "He did not
              answer the question" and "he applied cold" are different facts,
              and merging them would invent evidence against the thesis this
              section exists to test. */}
          <Fig n={a.unknownRef} label="not answered" note="neither, and not counted as cold" />
        </div>
        <div className="pgrid">
          <span className="pnum">
            <span className="plabel">Referred, and moved past applied</span>
            <Rate r={a.referredRate} />
          </span>
          <span className="pnum">
            <span className="plabel">Cold, and moved past applied</span>
            <Rate r={a.coldRate} />
          </span>
        </div>
        <p className="note">
          This comparison is the bet the whole networking half of the tool is
          making. It will not say anything until each side has {MIN_N}
          applications behind it, and it should not.
        </p>
      </section>

      <section className="section">
        <h2>This week against the target</h2>
        <Meter done={week.sent} total={5} id="pulse-week" label={
          <>
            <span className="mstrong">{week.sent} of 5 messages this week.</span>{" "}
            Five new tier-1 contacts a week is the cadence. Resets Monday.{" "}
            <a href="/people">People</a>.
          </>
        } />
      </section>

      {/* LAST, and on Pulse rather than Daily. Daily is for doing; this is for
          asking, and a box inviting a question at the top of the page whose job
          is to name one task would compete with it every morning. Here it sits
          under the numbers it answers questions about. */}
      <Ask />
    </div>
  );
}
