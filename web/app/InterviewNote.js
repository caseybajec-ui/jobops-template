import { familyOf } from "@/lib/families";
import { interviewNote, DISCLAIMER } from "@/lib/interviews";
import { categoryOfCompany } from "@/lib/palette";

/**
 * What this kind of interview actually looks like, on the role it applies to.
 *
 * A Palantir deployment-strategist interview and a Deloitte case interview
 * share nothing — not the format, not the preparation, not the week before —
 * and the tool has never said which of the two a role leads to.
 *
 * UNKNOWN RENDERS NOTHING. A prep checklist for the wrong format is worse than
 * none: it is confident, specific and misleading, read on the morning of.
 *
 * THE DISCLAIMER IS NOT DECORATION. This is compiled from public interview
 * reports, which is a weaker source than anything else in this tool — the
 * deadline windows at least come from a firm's own site. It renders under every
 * note in the same spirit as the "estimated" chip, and for the same reason the
 * McKinsey note cost a cycle: a weak source stated plainly beats a confident
 * wrong one.
 */
export default function InterviewNote({ role, compact = false }) {
  const family = familyOf(role, categoryOfCompany(role?.company));
  const note = interviewNote(family);
  if (!note) return null;

  return (
    <div className={`ivnote${compact ? " compact" : ""}`}>
      <h4>If this goes to interview — {note.label}</h4>

      <p className="ivhead">The process, typically</p>
      <ul className="ivlist">
        {note.process.map((l, i) => <li key={i}>{l}</li>)}
      </ul>

      <p className="ivhead">What to prepare</p>
      <ul className="ivlist">
        {note.prep.map((l, i) => <li key={i}>{l}</li>)}
      </ul>

      {/* THE QUESTIONS ONLY A HUMAN CAN ANSWER. 668 of 734 open scored roles
          state no start date at all, and no parser fixes that — the posting
          does not say. Asking is the only way to find out, it has to happen on
          every call, and without this it gets rediscovered per application. */}
      <p className="ivhead">Ask them</p>
      <ul className="ivlist ivask">
        {note.ask.map((l, i) => <li key={i}>{l}</li>)}
      </ul>

      <p className="ivdisclaimer">{DISCLAIMER}</p>
    </div>
  );
}
