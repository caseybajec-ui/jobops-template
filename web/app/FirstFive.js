"use client";

import { useEffect, useState } from "react";
import { firstFive } from "@/lib/firstfive";

/**
 * "What do I do first?" — above the TODAY card, until it is dismissed.
 *
 * NOT A TOUR. The tour explains the interface; this is the actual work, and
 * every row is either done or it is not. The decision lives in lib/firstfive.js
 * and is tested there; this only draws it.
 *
 * IT NEVER SHOWS A FINISHED STEP. That is the reason it reads live state instead
 * of being a static list, and it is why the filtering happens in the pure
 * function rather than here — a component that filters is a component that can
 * be rendered without filtering.
 *
 * DISMISSAL IS PER-BROWSER AND FORGETTABLE. localStorage, which is what
 * CLAUDE.md permits it for: losing it costs one click. The PROGRESS is never
 * stored — it is read from the database every render, so a step ticked on
 * another device is ticked here too, and nothing can drift.
 *
 * It starts VISIBLE and hides after mount if this browser dismissed it. The
 * other order renders a dismissed panel for one frame on every load, which is
 * the one state it should never show — the same call Explainer makes.
 */
const KEY = "jobops.firstfive.dismissed";

export default function FirstFive({ state }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(KEY) === "1");
    } catch { /* private window: it simply stays visible */ }
  }, []);

  function dismiss() {
    setDismissed(true);
    try { window.localStorage.setItem(KEY, "1"); } catch { /* fine */ }
  }

  if (dismissed) return null;

  const { steps, doneCount, total, allDone } = firstFive(state);

  // ALL DONE COLLAPSES TO ONE LINE and stays out of the way. Not removed
  // outright: something that vanishes with no trace reads as a bug the first
  // time you go looking for it.
  if (allDone) {
    return (
      <p className="ff done">
        <span className="ffdonemark" aria-hidden="true">✓</span>
        All {total} of the first things are done.{" "}
        <button type="button" className="linkish" onClick={dismiss}>Hide this</button>
      </p>
    );
  }

  return (
    <section className="ff" aria-label="What to do first">
      <p className="ffhead">
        <span className="ffkicker">What do I do first?</span>
        <span className="ffcount">{doneCount} of {total} done</span>
        <span className="spacer" />
        <button type="button" className="linkish" onClick={dismiss}>Hide this</button>
      </p>
      <ol className="fflist">
        {steps.map((s) => (
          <li key={s.id}>
            <span className="ffwhat">
              {s.title}
              {s.note && <span className="ffnote"> · {s.note}</span>}
            </span>
            <span className="ffwhy">{s.why}</span>
            <a className="railbtn ffgo" href={s.href}>{s.cta}</a>
          </li>
        ))}
      </ol>
    </section>
  );
}
