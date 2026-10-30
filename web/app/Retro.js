"use client";

import { useEffect, useState } from "react";
import { readDismissed, dismissHint } from "./Hint";

/**
 * Last week, on a Monday, above everything else.
 *
 * ONLY ON A MONDAY, and only about the week that has ENDED. A retro on a
 * Wednesday reports a week still in progress — a number that changes while you
 * read it, which teaches you not to read it. The rule is in lib/pulse.js:
 * mondayRetro returns null on every other day, so this renders nothing.
 *
 * DISMISSIBLE FOR THE DAY, and the key carries the date. A permanent dismissal
 * would kill the retro forever after one Monday; a session-only one would bring
 * it back on every refresh. Keyed by week, it goes away when he has read it and
 * returns next Monday with different numbers.
 *
 * It says what happened and does not grade it. There is no "on track" here for
 * the same reason there is none anywhere else in this tool: nothing in this
 * repository knows what on track means, and a number that cannot be derived is
 * one that was invented.
 */
export default function Retro({ retro, weekOf }) {
  const id = `retro:${weekOf}`;
  // Starts hidden and appears after mount, so a dismissed retro never flashes
  // on screen before the browser's own record of it is read.
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(!readDismissed().has(id));
  }, [id]);

  if (!retro || !show) return null;

  return (
    <section className="retro" role="note">
      <h2 className="retrolabel">Last week</h2>
      <p className="retroline">
        {retro.lines.map((l, i) => (
          <span key={i}>{i > 0 && " "}{l}</span>
        ))}
      </p>
      <p className="retroacts">
        <a href="/pulse">See the whole picture</a>
        <button
          type="button"
          className="linkish"
          onClick={() => { dismissHint(id); setShow(false); }}
        >
          got it
        </button>
      </p>
    </section>
  );
}
