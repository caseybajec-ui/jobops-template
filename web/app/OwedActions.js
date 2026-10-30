"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { INTERACTION_LABEL } from "@/lib/people";

/**
 * The two things you can do with an owed follow-up without leaving Daily.
 *
 * "Draft message" opens the person on the People page with the composer already
 * showing and the right template picked — one tap, not "go to People, find
 * them, open the draft, choose the template".
 *
 * "Done" does NOT set a done flag. There is no task table here and there should
 * not be one: an obligation is a CONSEQUENCE of what has happened, computed
 * fresh on every page load, so the only honest way to end one is to record the
 * thing that ends it. A tick box would leave the rule producing the identical
 * obligation on the next render, which is how a to-do list starts lying.
 *
 * So this logs the interaction that discharges it — a message for a nudge, a
 * thank-you for a call — and the row disappears because the rule no longer
 * fires, not because anything was marked.
 */
export default function OwedActions({ item }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function done() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "log",
          contact_id: item.id,
          type: item.resolve,
          note: "logged from Daily",
        }),
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

  return (
    <span className="owedacts">
      <a
        className="act"
        href={`/people?open=${encodeURIComponent(item.id)}&do=draft${
          item.template ? `&t=${item.template}` : ""}`}
      >
        Draft message
      </a>
      <button
        type="button"
        className="act"
        disabled={busy}
        // Says exactly what it will write. "Done" on its own would leave you
        // guessing whether it recorded a message or just dismissed the row.
        title={`Records "${INTERACTION_LABEL[item.resolve]}" against ${item.name} today`}
        onClick={done}
      >
        Done
      </button>
      {err && <span className="acterr">{err}</span>}
    </span>
  );
}
