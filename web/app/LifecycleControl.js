"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  LIFECYCLE, LIFECYCLE_LABEL, LIFECYCLE_BLURB, PREPPING, PREP_CHECKLISTS,
  NUDGE_AFTER_DAYS,
} from "@/lib/lifecycle";
import { roleFamilyOf } from "@/lib/people";

/**
 * Where this role got to, and what to do about it.
 *
 * REPLACES the per-posting stage select that used to sit here. That control
 * wrote `applications.stage`, one value keyed by a JOB key — so it forgot which
 * role it was about every time Palantir re-ids a requisition, and it held no
 * history, which meant "applied three weeks ago and heard nothing" and "applied
 * yesterday" looked identical everywhere in the app.
 *
 * This writes an insert-only event keyed by the role's GROUP key, the same
 * identity Save, Hide and Applied already use. recordRoleEvent keeps
 * applications.stage in step for the statuses that have an equivalent there, so
 * nothing that reads the old column goes stale.
 */
export default function LifecycleControl({ role, status = null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function move(next) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: role.groupKey, status: next }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Couldn't record that");
      }
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const family = roleFamilyOf(role.displayTitle || role.title);
  const checklist = family ? PREP_CHECKLISTS[family] : null;

  return (
    <div className="lifecycle">
      <h4>Where it got to</h4>
      <p className="lifebtns">
        {LIFECYCLE.map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`act${status?.status === k ? " on" : ""}`}
            disabled={busy}
            title={LIFECYCLE_BLURB[k]}
            onClick={() => move(k)}
          >
            {label}
          </button>
        ))}
        {err && <span className="acterr">{err}</span>}
      </p>

      {status && (
        <p className="lifewhen">
          {LIFECYCLE_LABEL[status.status]} for {status.days} day
          {status.days === 1 ? "" : "s"}
          {status.referral === true && " · a referral got you in"}
          {status.referral === false && " · applied cold"}
          {/* COUNTS UP. A countdown implies progress; for something that has
              not moved in three weeks, age is the honest number. */}
          {status.status === "applied" && status.days >= NUDGE_AFTER_DAYS && (
            <span className="lifenudge">
              {" "}— nothing for {status.days} days.{" "}
              <a href={`/people?co=${encodeURIComponent(role.company)}`}>
                Who do you know at {role.display_name || role.company}?
              </a>
            </span>
          )}
        </p>
      )}

      {/* From the phone screen on. A checklist on every applied role is a
          checklist you stop reading, and before a screen there is nothing to
          prepare for. */}
      {status && PREPPING.has(status.status) && (
        checklist ? (
          <div className="prepkit">
            <h4>Before the {LIFECYCLE_LABEL[status.status].toLowerCase()}</h4>
            <p className="dim">{checklist.label}</p>
            <p className="prepsub">Research</p>
            <ul>{checklist.research.map((r, i) => <li key={i}>{r}</li>)}</ul>
            <p className="prepsub">Expect to be asked</p>
            <ul>{checklist.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            {role.angle && (
              <>
                <p className="prepsub">The line you already have for this role</p>
                <p className="pitch">{role.angle}</p>
              </>
            )}
          </div>
        ) : (
          <p className="dim">
            No prep checklist for this title — it does not read as any of the four
            families, and the wrong checklist is worse than none.
          </p>
        )
      )}
    </div>
  );
}
