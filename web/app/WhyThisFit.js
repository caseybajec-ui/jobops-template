import { whyThisFit } from "@/lib/why";

/**
 * The band, explained. Rendered inside an expanded row.
 *
 * NOT a second opinion and NOT a second score. Every sentence here is a
 * translation of a column the pipeline already wrote: the four deterministic
 * gates that run in Python before any model sees the role, the scorer's own
 * reasons and gaps, and the spread across its samples.
 *
 * The gates come FIRST, before the model's reasoning, because they answer the
 * question that is actually being asked. "Why is this Weak" is usually not a
 * question about the score at all — it is "why can't I apply to this", and the
 * answer is a gate, decided in code, with no judgement in it anywhere.
 */
export default function WhyThisFit({ job }) {
  const w = whyThisFit(job);

  return (
    <div className="why">
      <h4>Why {w.band}</h4>
      <p className="whyband">{w.bandText}</p>
      <p className="whyconf">{w.confidence}</p>

      {/* The FAILED gates, on their own, first. A blocker buried in a list of
          passes is a blocker that gets missed, and it is the one thing here
          that changes whether the role is worth reading at all. */}
      {w.blocked.length > 0 && (
        <p className="whyblocked">
          <strong>
            {w.blocked.length === 1 ? "One thing" : `${w.blocked.length} things`} rules
            this out for you:
          </strong>{" "}
          {w.blocked.map((g) => g.text).join(" ")}
        </p>
      )}

      <ul className="whygates">
        {w.gates.map((g) => (
          <li key={g.key} className={g.pass ? "gpass" : "gfail"}>
            <span className="gname">{g.label}</span>
            <span className="gtext">{g.text}</span>
          </li>
        ))}
      </ul>

      <div className="whycols">
        <div>
          <h4>What the scorer liked</h4>
          <ul>
            {w.reasons.length
              ? w.reasons.map((r, i) => <li key={i}>{r}</li>)
              : <li className="dim">It gave no reasons.</li>}
          </ul>
        </div>
        <div>
          <h4>What it held against you</h4>
          <ul>
            {w.gaps.length
              ? w.gaps.map((g, i) => <li key={i}>{g}</li>)
              : <li className="dim">Nothing recorded.</li>}
          </ul>
        </div>
      </div>

      <p className="whymodel">
        {/* Which model, said out loud. One model scores everything in this tool
            — mixing two put the top of every ranking in whichever one inflates
            more, and it took two attempts to clean up. Printing it here is how
            you would notice it happening again. */}
        Scored by {w.model || "an unrecorded model"}
        {w.effort ? ` at ${w.effort} effort` : ""}. The gates above it are code,
        not judgement: they run before any model sees the posting.{" "}
        <a href="/gate">What the rules filtered out</a>.
      </p>
    </div>
  );
}
