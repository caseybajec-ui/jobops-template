"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { USER_CLASS_YEAR } from "@/lib/constants";

/**
 * "This whole firm is the wrong cycle" — behind a ⋯ on the Companies row.
 *
 * WHY IT IS A MENU AND NOT A LINK. It shipped as a bare text button reading
 * "wrong cycle", sitting in the flow of each company's note line. On a page
 * where every one of the 21 rows carries a note, that put the words "wrong
 * cycle" at the end of 21 sentences — so the page appeared to be ASSERTING
 * that every company was the wrong cycle, which is the exact opposite of the
 * truth and of what the control does. Exactly one company is flagged, and a
 * flagged company is not even on this page: it drops to Watching.
 *
 * A control's resting state is a claim about the row it sits on. This one had
 * no resting state that could be read as an offer rather than a label, so it
 * gets a glyph instead — the same ⋯ the role rows use, for the same reason.
 *
 * Two steps to commit, deliberately. Removing a company from every list in the
 * app is not a one-click action, and while the undo list at the foot of Inbox
 * makes it recoverable, recoverable is not the same as noticed.
 *
 * The same flag a role row sets, at company scope. It lives here as well as on
 * a role because wrong-cycle is usually a fact about an EMPLOYER's recruiting
 * calendar rather than about one requisition — a growth-equity firm's analyst
 * class took December graduates, which is true of every req they will ever
 * post for that class — and Companies is the page where the owner is looking
 * at employers rather than at postings.
 */
export default function CompanyCycle({ company, label }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const box = useRef(null);

  // Escape closes, and so does a click anywhere else. A popover that can only
  // be dismissed by finding its own cancel button is a modal in disguise.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    const onDown = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  async function commit() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "company", key: company, on: true, note: note.trim() || null,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "could not save");
      setOpen(false);
      setNote("");
      router.refresh();
    } catch (e) {
      // Surfaced, never swallowed: a flag that silently failed looks exactly
      // like one that worked, right up until the company is back tomorrow.
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="comenu" ref={box}>
      <button
        type="button"
        className="comore"
        aria-expanded={open}
        aria-label={`More actions for ${label || company}`}
        title="More actions"
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        ⋯
      </button>

      {open && (
        <span className="comenubody" role="menu">
          <span className="comenuhead">{label || company}</span>
          <label className="comenulabel">
            Wrong graduating cycle? Say why — optional, but it is the only record
            of the reason.
            <input
              type="text"
              value={note}
              maxLength={400}
              autoFocus
              placeholder={`e.g. their ${USER_CLASS_YEAR} class takes December ${USER_CLASS_YEAR} graduates`}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            />
          </label>
          <span className="comenuacts">
            <button type="button" disabled={busy} onClick={commit}>
              Hide everything at {label || company}
            </button>
            <button type="button" className="linkish" onClick={() => setOpen(false)}>
              cancel
            </button>
          </span>
          {err && <span className="acterr" role="status">{err}</span>}
        </span>
      )}
    </span>
  );
}
