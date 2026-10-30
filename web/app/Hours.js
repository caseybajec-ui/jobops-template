"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HOUR_CHOICES } from "@/lib/availability";

/**
 * "Hours today?" — asked once a day, in the rail.
 *
 * The ladder already knows what every task COSTS and has never known what the owner
 * HAS, so it offers a three-hour composite on a day with forty minutes in it.
 *
 * ASKED ONCE. Once answered it collapses to the answer and a way to change it;
 * unanswered, it never nags and nothing is trimmed. A question that reappears
 * is one you dismiss without reading, and this one has to still be worth
 * reading on the day it matters.
 */
export default function Hours({ hours = null, day }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState(null);

  async function set(h) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/hours", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ day, hours: h }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "could not save");
      setEditing(false);
      router.refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  if (hours !== null && !editing) {
    return (
      <p className="hoursset">
        <span className="dim">Today:</span>{" "}
        <strong>{hours} {hours === 1 ? "hour" : "hours"}</strong>{" "}
        <button type="button" className="linkish" onClick={() => setEditing(true)}>
          change
        </button>
      </p>
    );
  }

  return (
    <div className="hours">
      <p className="hoursq">Hours today?</p>
      <div className="hoursbtns">
        {HOUR_CHOICES.map((h) => (
          <button key={h} type="button" disabled={busy}
                  className="railbtn" onClick={() => set(h)}
                  /* The heading above says "Hours today?" and a screen reader
                     reaching this button hears "1" — the question is a sibling,
                     not a label. Four bare digits are also the least guessable
                     control on the page for anyone using a pointer. */
                  title={`${h} ${h === 1 ? "hour" : "hours"} today`}
                  aria-label={`I have ${h} ${h === 1 ? "hour" : "hours"} today`}>
            {h}
          </button>
        ))}
        {/* Only offered once there is an answer to remove. Before that, there
            is nothing to skip — the question already costs nothing to ignore. */}
        {hours !== null && (
          <button type="button" className="linkish" disabled={busy}
                  onClick={() => set(0).catch(() => {})}>
            cancel
          </button>
        )}
      </div>
      <p className="railnote">
        Answering trims the ladder to what fits and says what it moved. Ignoring
        it changes nothing.
      </p>
      {err && <span className="acterr" role="status">{err}</span>}
    </div>
  );
}
