"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Checked it" — the answer to tier 2.
 *
 * Without this the ladder names the same firm every morning and there is no way
 * to say "I looked, there is still no date". That is a nag, and a nag you cannot
 * answer is one you learn to skip — which is the failure this whole redesign
 * exists to fix. Answering pushes the window to the back of the
 * least-recently-checked queue, so tomorrow it asks about a different one.
 *
 * The date is OPTIONAL and skippable, and it is the point of the feature: 16 of
 * 25 tracked windows have no date at all, and this is how they get one — ten
 * minutes at a time, typed by the person who read the firm's own page. A date
 * entered here marks the window `verified`, which is what companies.yaml means
 * by the word and which currently applies to exactly one window in the set.
 */
export default function WindowCheck({ windowKey, firm, collapsed = false }) {
  const router = useRouter();
  const [closes, setCloses] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  /**
   * COLLAPSED, for every row that is not today's.
   *
   * The list rendered this control on all sixteen rows at once — a date input
   * and a button on a second line under each — so sixteen windows cost
   * thirty-two lines and no row looked more next than any other. That is the
   * same undifferentiated wall the focus card above exists to replace, printed
   * directly beneath it.
   *
   * It OPENS rather than disappears. Clearing six on a Sunday afternoon is a
   * real thing to want, and a queue that only ever offers one is the version of
   * this feature that gets abandoned in the other direction.
   */
  const [shown, setShown] = useState(false);
  // What was recorded, captured AT SUBMIT TIME. Recording a check moves that
  // window to the back of the queue and the card immediately shows the next
  // firm, so reading `firm` afterwards named the wrong one: "Recorded — Battery
  // / General Catalyst / a16z still has no date" for a check on Analysis Group.
  // The write was correct; only the sentence lied, which is the worse half.
  const [recorded, setRecorded] = useState(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/windows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: windowKey, closes: closes.trim() || null }),
      });
      if (!res.ok) {
        let msg = "Couldn't save — try again";
        try { const b = await res.json(); if (b?.error) msg = b.error; } catch { /* generic */ }
        throw new Error(msg);
      }
      setRecorded({ firm, closes: closes.trim() || null });
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (recorded) {
    return (
      <p className="todaycheck">
        <span className="dim">
          Recorded — {recorded.firm}{recorded.closes
            ? ` closes ${recorded.closes}`
            : " still has no date"}.
        </span>
      </p>
    );
  }

  if (collapsed && !shown) {
    return (
      <p className="todaycheck quiet">
        <button type="button" className="linkish" onClick={() => setShown(true)}>
          answer anyway
        </button>
      </p>
    );
  }

  return (
    <p className="todaycheck">
      <label>
        {/* Named, not just "Found a date?". This control sits under the TODAY
            card but belongs to the smaller line above it, and unlabelled it read
            as confirming the card's firm — the same lie as the confirmation that
            named the wrong firm, in the same place. */}
        <span className="dim">{firm} — found a date?</span>{" "}
        <input
          type="date"
          value={closes}
          disabled={busy}
          aria-label={`Close date for ${firm}, if you found one`}
          onChange={(e) => setCloses(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>
      <button type="button" onClick={submit} disabled={busy}>
        {closes ? "Save the date" : "Checked it — still none"}
      </button>
      {err && <span className="acterr">{err}</span>}
    </p>
  );
}
