"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Track application" on a Forecast open-now row.
 *
 * The composite TODAY card covers the windows closing soonest. This covers
 * everything else on Forecast: a window the owner applied to last week, or one he
 * is about to, that the ladder has not surfaced. Without it the only way into
 * the tracker was to wait for the ladder to name that firm.
 *
 * Two answers, because there are two real states and they are not the same:
 * "I've applied" needs a date (it may have been days ago, and days-in-stage is
 * computed from it), and "I'm going to" records the intent at `saved` with no
 * date to invent.
 */
export default function TrackApplication({ window: w, tracked = false }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (tracked) {
    return (
      <span className="trackdone" title="Already in your tracker">
        tracking
      </span>
    );
  }

  async function create(status) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          firm_label: w.firm,
          program_name: w.program,
          class_year: w.class_year ? Number(w.class_year) : null,
          window_id: `window:${w.firm}|${w.program}`,
          source: "window",
          status,
          // A date only travels with an application that HAPPENED. `saved` is
          // an intention and gets today's timestamp like any other row.
          at: status === "applied" ? `${when}T12:00:00+00:00` : null,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Couldn't save — try again");
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="act" onClick={() => setOpen(true)}>
        Track application
      </button>
    );
  }

  return (
    <span className="trackform">
      <button type="button" disabled={busy} onClick={() => create("saved")}>
        Going to apply
      </button>
      <span className="dim">or applied on</span>
      <input
        type="date"
        value={when}
        disabled={busy}
        aria-label={`Date you applied to ${w.firm}`}
        onChange={(e) => setWhen(e.target.value)}
      />
      <button type="button" disabled={busy} onClick={() => create("applied")}>
        Save
      </button>
      <button type="button" className="linkish" onClick={() => setOpen(false)}>
        cancel
      </button>
      {err && <span className="acterr">{err}</span>}
    </span>
  );
}
