"use client";

import { useRouter } from "next/navigation";
import { useAction } from "./useAction";

/**
 * Star a company you are actually going after.
 *
 * Stored against the company slug, so it survives every posting on that board
 * churning. Targets sort above everything else on this page.
 */
export default function CompanyTarget({ company, on }) {
  const router = useRouter();
  const a = useAction(on);
  return (
    <>
      <button
        type="button"
        className={`star${a.on ? " on" : ""}`}
        aria-pressed={a.on}
        disabled={a.busy}
        /* A star with only aria-pressed on it announces as "pressed, button" —
           true and useless. The label and the tooltip say the same sentence, so
           hovering and listening give the same answer. */
        aria-label={a.on ? `${company} is one of your targets — click to remove it`
                         : `Make ${company} one of your targets`}
        title={a.on ? "One of your targets — click to remove"
                    : "Make this a target — targets sort to the top of this page"}
        onClick={async () => {
          await a.toggle(company, "target", !a.on);
          router.refresh();
        }}
      >
        {a.on ? "★" : "☆"}
      </button>
      {a.error && <span className="acterr">{a.error}</span>}
    </>
  );
}

/**
 * What to do next at a target company, derived from what is already known —
 * never a free-text field to keep up to date.
 *
 * The order matters: an owed follow-up outranks everything, because it is the
 * only one with a date attached.
 */
export function nextStep(c) {
  if (c.contactsDue > 0) {
    return { text: `Follow up with ${c.dueName || "your contact"} — due today`, due: true };
  }
  if (c.stage === "interviewing") return { text: "Interviewing", due: false };
  if (c.stage === "offer") return { text: "Offer — decide", due: true };
  // A referral in motion outranks having applied, because it is the thing that
  // changes the odds on the application that is already in.
  if (c.referred > 0) {
    return { text: "Referred — say thank you if you haven't", due: false };
  }
  if (c.appliedAt) {
    return { text: `Applied ${String(c.appliedAt).slice(0, 10)}, waiting`, due: false };
  }
  if (c.stage === "applied") return { text: "Applied, waiting", due: false };
  if (!c.contacts) {
    // Was "Find alumni — titles are in networking targets", which named a file
    // that no longer exists (networking_targets.md was replaced by the Start
    // here queue). A next step pointing at nothing is worse than none.
    return { text: "Find two names — nobody here yet", due: false };
  }
  if (c.replied === 0) {
    return {
      text: `Waiting on ${c.contacts} ${c.contacts === 1 ? "person" : "people"}`,
      due: false,
    };
  }
  return { text: "Someone replied — book the call", due: false };
}
