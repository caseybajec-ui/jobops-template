"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Edit a manually added role's posting URL, in the row.
 *
 * ONLY RENDERS FOR A MANUAL ROW. A polled row's url is rewritten by its board on
 * every fetch, so an edit would be silently undone by tomorrow morning's cron —
 * worse than no control at all, because it would look like it worked. The data
 * layer refuses that case too; this just does not offer it.
 *
 * WHY IT EXISTS. A manual entry is added before its exact posting URL is known:
 * Truist went in as careers.truist.com so the row could exist, be gated and be
 * scored the same day. Pasting the real link should not mean editing YAML,
 * committing, redeploying and re-running a CLI.
 *
 * The error gets its own line, for the reason this codebase has already paid
 * for once: an optimistic save whose failure message was clipped by a column
 * looked exactly like never having clicked.
 */
export default function JobUrl({ job }) {
  const router = useRouter();
  const [url, setUrl] = useState(job.url || "");
  const [state, setState] = useState(null);      // "saved" | null
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  if (job.source !== "manual") return null;

  async function save() {
    if ((job.url || "") === url.trim()) return;   // nothing changed
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/joburl", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: job.key, url }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || "could not save");
      setState("saved");
      setTimeout(() => setState(null), 1500);
      router.refresh();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="full">
      <h4>Posting URL</h4>
      <p className="dim joburlnote">
        Added by hand, so this is yours to set — paste the exact posting link
        when you have it.
      </p>
      <div className="joburlrow">
        <input
          type="text"
          value={url}
          disabled={busy}
          aria-label="Posting URL"
          onChange={(e) => setUrl(e.target.value)}
          onBlur={save}
        />
        {state === "saved" && <span className="cardsaved">saved</span>}
      </div>
      {err && <p className="acterr" role="status">{err}</p>}
    </div>
  );
}
