"use client";

import { useState, useTransition } from "react";
import { addNoteAction } from "./actions";
import Band from "./Band";
import RoleActions from "./RoleActions";
import PrimaryAction from "./PrimaryAction";
import JobUrl from "./JobUrl";
import { PlaceTag, StartTag } from "./RoleTags";
import InterviewNote from "./InterviewNote";
import { CategoryDot } from "./Palette";
import LifecycleControl from "./LifecycleControl";
import WhyThisFit from "./WhyThisFit";
import { bandOf } from "@/lib/display";
import { PREFS } from "@/lib/config.generated";
import { bandClass, categoryOfCompany } from "@/lib/palette";

/**
 * Under the owner's pay floor, when one is set and the posting publishes a
 * maximum. DISPLAY ONLY: nothing filters or re-ranks on it, for the reason
 * config.yaml gives beside salary_min -- a preference decides WITH the owner,
 * never for them, and the best-fit role on the board may well be under it.
 */
function underFloor(job) {
  return Number.isFinite(PREFS.salaryMin) && PREFS.salaryMin > 0
    && Number.isFinite(job.comp_max) && job.comp_max > 0
    && job.comp_max < PREFS.salaryMin;
}

const PAY_SOURCE = {
  structured: "published by the employer",
  parsed: "parsed from the posting",
  none: "not published",
};

const CLEARANCE = {
  required_active: "needs a clearance you don't have",
  sponsorable: "the employer sponsors the clearance",
  eligibility_only: "needs eligibility, not a clearance you already hold",
};

/**
 * The dot after a company name: the board has not touched this posting in a
 * week or more.
 *
 * IT USED TO BE A PSEUDO-ELEMENT — `.row.stale .co::after`, an --alert-coloured
 * disc with no tooltip, no accessible name and no legend entry. It appeared
 * after Saronic, Palantir and Databricks but not Roblox or Stripe, and there
 * was no way to find out why, because a ::after cannot carry a title attribute
 * and hands a screen reader nothing whatsoever. Read on the page it looked like
 * a tier marker, or like the category dot drawn twice.
 *
 * Two things changed and neither is the threshold. It is a real element, so it
 * can say what it means and say how long — the number is already on the row
 * object, so the tooltip states the actual age rather than repeating "stale".
 * And it is graphite rather than --alert: a posting nobody has edited is ageing,
 * not urgent, and --alert is spent on time-critical everywhere else in this app.
 */
function AgeDot({ role }) {
  if (!role.stale) return null;
  const d = role.daysSinceTouch;
  const said = d === null ? "in a while" : `in ${d} day${d === 1 ? "" : "s"}`;
  const text = `The board has not updated this posting ${said}`;
  return <span className="agedot" role="img" aria-label={text} title={text} />;
}

export default function JobRow({
  job, expanded, onToggle, actions = {}, appliedAt = null, isNew = false,
  referrals = [], lifecycle = null, contactCounts = {},
}) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();

  const stop = (e) => e.stopPropagation();
  const dates = [
    job.posted_at && `posted ${String(job.posted_at).slice(0, 10)}`,
    job.first_seen && `first seen ${String(job.first_seen).slice(0, 10)}`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <div
        /* No " stale" class any more. It existed solely to hang the
           pseudo-element dot off, and a class with no rule behind it is the
           thing test_classes.mjs was written to catch — it survived only
           because "stale" is on that test's allow-list from an earlier use. */
        className={`row ${bandClass(job.score)}${expanded ? " open" : ""}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        {/* Clickable, and it says so. The band is the most-read thing on the
            row and there was no way to ask it anything; opening the row is
            where the answer lives, so the band opens the row. */}
        <Band score={job.score} why />
        <span className="co">
          <CategoryDot category={categoryOfCompany(job.company)} />
          {job.display_name}
          <AgeDot role={job} />
        </span>
        <span className="title">
          {job.displayTitle || job.title}
          <StartTag role={job} />
          {isNew && <span className="tag-open">new</span>}
          {appliedAt && <span className="tag-open faint">applied</span>}
        </span>
        <span className="loc">
          {/* The tag answers what the column cannot: this cell truncates, so
              "Colorado Springs, ..." required a hover to read and still did not
              say whether it was one of the two cities he wants.
              
              AND FOR MONTHS IT ANSWERED NOTHING, because it sat INSIDE the
              truncating cell. `.loc` is overflow:hidden with an ellipsis, so
              the chip was pushed past the clip edge by the very text it was
              there to make unnecessary — measured at 27 of 32 rows invisible,
              and invisible on exactly the long-location rows that are the
              entire reason it exists. It rendered, it had a tooltip, it passed
              every test, and you could not see it.
              
              The text is its own element now and takes the truncation; the chip
              is a flex sibling that does not shrink. */}
          <span className="loctext">{job.locationLabel || job.location}</span>
          <PlaceTag role={job} />
        </span>
        <span>
          {/* Label only what differs from the default — "open to new grads" on
              every row is noise when the filter already guarantees it. */}
          <span className={`lvl${job.entry_level === "program" ? " program" : ""}`}>
            {job.entry_level === "program" ? "new-grad program"
              : job.entry_level === "experienced" ? "wants experience" : ""}
          </span>
        </span>
        <span className="num"
              title={underFloor(job) ? `Published maximum is under your floor of $${Math.round(PREFS.salaryMin / 1000)}K (config.yaml preferences.salary_min). Shown, not hidden: a floor is a preference, not a score.` : undefined}>
          {job.comp || <span className="lvl">not published</span>}
          {underFloor(job) ? <span className="lvl"> under floor</span> : null}
        </span>
        <span className="rowend">
          <PrimaryAction role={job} contactCounts={contactCounts} />
          <RoleActions role={job} state={actions} referrals={referrals} />
          {/* aria-hidden AND titled. The row itself is the button and already
              announces its own name, so a screen reader must not hear a stray
              "›" — but a pointer has no other way to learn that this row opens.
              A title on a decorative glyph is for the eye, not the reader. */}
          <span className="chev" aria-hidden="true"
                title="Open this role — why it fits, pay, dates, and what to lead with">›</span>
        </span>
      </div>

      {expanded && (
        <div className="detail" onClick={stop}>
          {/* WHY THIS BAND. No new scoring — every line is read off a column
              the pipeline already wrote. A band is a one-word summary of a
              model's judgement behind four deterministic gates, and the only
              thing on screen was the word; a central number that cannot be
              interrogated is one you either trust blindly or stop using, and
              "read the scorer" is not available to somebody who does not write
              code. */}
          <div className="full">
            <WhyThisFit job={job} />
          </div>

          {/* Rendered whether or not he has applied. Before, it is what the
              role is actually asking of him; after, it is the prep. */}
          <div className="full">
            <InterviewNote role={job} />
          </div>

          <JobUrl job={job} />

          <div className="full">
            <h4>Your angle</h4>
            <p className="pitch">{job.angle || "—"}</p>
          </div>

          <div className="full">
            <h4>Lead with</h4>
            <ul>
              {(job.evidence || []).length
                ? job.evidence.map((e, i) => <li key={i}>{e}</li>)
                : <li className="dim">—</li>}
            </ul>
          </div>

          <div className="full">
            <h4>Where</h4>
            <p className="dim" style={{ margin: "0 0 12px" }}>
              {((job.locations && job.locations.length ? job.locations : [job.location])
                .filter(Boolean).join(" · ")) || "—"}
              {job.all && job.all.length > 1 && (
                <span className="faint"> — {job.all.length} postings</span>
              )}
            </p>
          </div>

          <div className="full">
            <h4>Pay and dates</h4>
            <p className="dim" style={{ margin: "0 0 12px" }}>
              {job.comp || "no pay published"} ·{" "}
              {PAY_SOURCE[job.comp_source] || "not published"}
              {job.yoe ? ` · posting asks for ${job.yoe}+ years` : ""}
              {CLEARANCE[job.clearance_status] ? ` · ${CLEARANCE[job.clearance_status]}` : ""}
              {dates ? ` · ${dates}` : ""}
            </p>
          </div>

          {/* The lifecycle, replacing the per-posting stage select that used to
              sit in the actions row. See LifecycleControl for why: that one was
              keyed by JOB key, so it forgot which role it was about whenever a
              requisition churned, and it held no history — which is the only
              thing that says whether an application has stalled. */}
          <div className="full">
            <LifecycleControl role={job} status={lifecycle} />
          </div>

          <div className="full actions">
            <input
              className="note-input"
              placeholder="Add a note…"
              value={note}
              disabled={pending}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && note.trim()) {
                  const t = note;
                  setNote("");
                  start(() => addNoteAction(job.key, t));
                }
              }}
            />
            <button
              disabled={pending || !note.trim()}
              onClick={() => {
                const t = note;
                setNote("");
                start(() => addNoteAction(job.key, t));
              }}
            >
              Note
            </button>

            <a href={job.url} target="_blank" rel="noreferrer">Open the posting ↗</a>
          </div>

          {job.notes && (
            <div className="full">
              <h4>Notes</h4>
              <div className="notes">{job.notes}</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
