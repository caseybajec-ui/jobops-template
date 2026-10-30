"use client";

import { useEffect, useState } from "react";
import { readDismissed, dismissHint } from "./Hint";

/**
 * A paragraph that explains a section once, then shrinks to a link.
 *
 * The difference from `Hint`: a Hint is a "?" you have to know to press, and
 * this is prose that is ON by default because the first time you see the
 * section you genuinely need it. What it must not do is stay at full length
 * forever — a standing explanation on a page you open every morning is the
 * thing your eye learns to jump over, and once it does, it jumps over the rows
 * underneath as well.
 *
 * So: full paragraph until dismissed, then one line with an expander that still
 * opens the full text. Nothing is deleted; it is folded.
 *
 * It shares Hint's localStorage store deliberately. Two dismissal mechanisms
 * would be two things to clear and two things to reason about, and the
 * behaviour is the same behaviour.
 */
/**
 * `className` exists so a caller can say "this one is a .note" without wrapping
 * it in a div. Two callers did wrap it, and the wrapper is a second block that
 * renders its own border and padding around a paragraph that already has both —
 * visible as a doubled rule, and counted twice by anything measuring how much
 * standing prose is on the page.
 */
export default function Explainer({ id, short, children, className = "" }) {
  // Starts EXPANDED and folds after mount if this browser has dismissed it.
  // The other order — start folded, expand if not dismissed — renders the
  // short line first for everyone, so a first-time reader sees the fold flash
  // open, which is the one state that should never appear.
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => { setDismissed(readDismissed().has(id)); }, [id]);

  if (!dismissed || open) {
    return (
      <p className={`sub ${className}`.trim()}>
        {children}{" "}
        {!dismissed && (
          <button
            type="button"
            className="linkish"
            onClick={() => { dismissHint(id); setDismissed(true); setOpen(false); }}
          >
            got it
          </button>
        )}
        {open && (
          <button type="button" className="linkish" onClick={() => setOpen(false)}>
            hide
          </button>
        )}
      </p>
    );
  }

  return (
    <p className={`sub folded ${className}`.trim()}>
      {short}{" "}
      <button type="button" className="linkish" onClick={() => setOpen(true)}>
        why?
      </button>
    </p>
  );
}
