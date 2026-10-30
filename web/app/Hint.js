"use client";

import { useEffect, useState } from "react";

/**
 * A "?" next to something that needs one sentence of explanation.
 *
 * FIRST-RUN, and it means it: once dismissed the "?" is gone for good on that
 * concept, everywhere it appears. A help affordance that stays forever is
 * chrome, and chrome on every row of a list is worse than the confusion it was
 * meant to fix.
 *
 * NEVER MODAL. It opens in place, below the thing it explains, and closes on a
 * click or on Escape. Nothing behind it is blocked while it is open — the same
 * rule the hide-reason control follows, for the same reason: an answer that
 * costs three clicks is one you stop asking for.
 *
 * localStorage, which is the one thing CLAUDE.md permits it for: "no
 * localStorage for data; localStorage is fine for dismissed-tooltip flags".
 * A dismissal is per-browser and per-device by nature, and losing one costs a
 * "?" reappearing once.
 */
const KEY = "jobops.hints.dismissed";

export function readDismissed() {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    // A private window, cleared site data, or a browser set to block storage.
    // Showing the hint again is the correct failure: it is a sentence.
    return new Set();
  }
}

/** Record a dismissal. Shared with Explainer, which folds rather than hides. */
export function dismissHint(id) {
  try {
    const d = readDismissed();
    d.add(id);
    window.localStorage.setItem(KEY, JSON.stringify([...d]));
  } catch { /* it will simply be offered again */ }
}

export default function Hint({ id, children }) {
  // Starts hidden and appears after mount. Rendering it on the server would
  // mean the markup says "?" for a hint this browser dismissed months ago, and
  // React would then hydrate over the top of it — a flash of a control that
  // should not be there.
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setShow(!readDismissed().has(id));
  }, [id]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function dismiss() {
    setOpen(false);
    setShow(false);
    dismissHint(id);
  }

  if (!show) return null;

  return (
    <span className="hint">
      <button
        type="button"
        className="hintq"
        aria-expanded={open}
        aria-label="What does this mean?"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(!open); }}
      >
        ?
      </button>
      {open && (
        <span className="hintbody" role="note" onClick={(e) => e.stopPropagation()}>
          {children}
          <button type="button" className="linkish hintgot" onClick={dismiss}>
            got it
          </button>
        </span>
      )}
    </span>
  );
}
