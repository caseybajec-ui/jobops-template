"use client";

import { submissionLine } from "@/lib/submissions";

/**
 * Three numbers, at the top of Daily, in the same words the digest uses.
 *
 * WHY IT IS THE FIRST THING ON THE PAGE. Everything below measures what the
 * pipeline FOUND — 11,495 roles, 59 boards, a fit band, a closing window. This
 * measures what the owner DID, and it is the only figure on the page that changes
 * the outcome. Putting it under the ladder would make it a report; putting it
 * on top makes it the frame everything else is read inside.
 *
 * IT WILL READ ZERO. That is the design, not a gap: on the day it was built
 * `applications`, `manual_applications` and `role_events` held no rows at all.
 * The counter is honest about that in words rather than showing a bare `0`,
 * because "0 submitted" and "this counter has never worked" look identical and
 * this project has shipped that confusion on three separate surfaces.
 *
 * ONE IMPLEMENTATION, TWO SURFACES. The sentence comes from submissionLine() in
 * lib/submissions.js, the same call the digest makes, so the page and the email
 * can never disagree about how many applications went in.
 */
export default function SubmissionCounter({ counter }) {
  // A FAILED READ IS NOT A QUIET WEEK, and it must not render as one. null
  // reaches submissionLine, which says "not counted -- missing data".
  const line = submissionLine(counter);
  const never = !counter || counter.neverAny;

  return (
    <p className={never ? "counter counter-none" : "counter"}
       title={counter
         ? `Week of ${counter.weekStart}, Monday to Sunday, America/Chicago.`
           + " Open rolling windows and interviews are current state, not weekly counts."
         : "The submissions count could not be read."}>
      {line}
    </p>
  );
}
