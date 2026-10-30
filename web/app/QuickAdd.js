"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { quickAddPayload } from "@/lib/people";

/**
 * Add a person to THIS company, from the Companies page, in one action.
 *
 * The full form on People is right for a person you know something about.
 * The case this exists for is the other one: the alumni search is open in
 * the next tab, a name is on screen, and the whole of what is known is a name
 * and a link. Two boxes, one button, and the row lands against this company
 * — no trip to another page, no company box to fill in, nothing to choose.
 *
 * The payload is decided by quickAddPayload() in lib/people.js, not here, so
 * the rule is tested without a browser and the form cannot send a field the
 * API refuses. The write goes through /api/people exactly as the People form
 * does; nothing here fetches LinkedIn, and nothing ever will.
 *
 * The error, when there is one, is a full-width line under the boxes rather
 * than a span squeezed beside them — the optimistic-save lesson: a message
 * clipped by its column is a failure that looks like never having clicked.
 */
export default function QuickAdd({ company, label }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [added, setAdded] = useState(null);

  const payload = quickAddPayload({ name, link, company });

  async function submit() {
    if (!payload || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || "Couldn't save — try again");
      setAdded(payload.name);
      setName("");
      setLink("");
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // stopPropagation throughout: one host is the body of a <details>, and a
  // click that bubbles to its <summary> folds the form shut mid-typing.
  const stop = (e) => e.stopPropagation();

  if (!open) {
    return (
      <button type="button" className="linkish quickadd-open"
              onClick={(e) => { stop(e); setOpen(true); }}>
        Add a person at {label}
      </button>
    );
  }

  return (
    <span className="quickadd" onClick={stop}>
      <span className="quickadd-row">
        <input
          aria-label={`Name, or their LinkedIn link, at ${label}`}
          placeholder="Name, or paste their LinkedIn link"
          value={name}
          disabled={busy}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <input
          aria-label={`LinkedIn link at ${label}`}
          placeholder="https://www.linkedin.com/in/…"
          value={link}
          disabled={busy}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button type="button" onClick={submit} disabled={!payload || busy}>
          Add to {label}
        </button>
        <button type="button" className="linkish" onClick={() => setOpen(false)}>
          close
        </button>
      </span>
      {added && !err && (
        <span className="quickadd-note dim">
          Added {added}.{" "}
          <a href={`/people?co=${encodeURIComponent(company)}`}>See everyone at {label}</a>
        </span>
      )}
      {err && <span className="quickadd-note acterr">{err}</span>}
    </span>
  );
}
