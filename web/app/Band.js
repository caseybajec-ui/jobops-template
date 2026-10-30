import { bandOf } from "@/lib/display";
import { bandClass } from "@/lib/palette";

/**
 * Fit, shown as a word and a bar. One component, used by every list.
 *
 * The inbox used to read 92, 92, 88, 88, 82, then twenty roles at 72, then a
 * wall of 28. Haiku emits about twelve distinct values and moves by roughly
 * +/-10 between runs on the same role, so a two-digit number invites reading a
 * four-point gap as a difference. It is not one.
 *
 * The number is not deleted — it moves to the expanded row, where it reads
 * "fit 72 of 100" and is clearly one number rather than a ranking.
 *
 * COLOUR. The bar and the word now carry the band's colour: green, blue, amber,
 * grey. Length alone was the original design and it was a notch too austere —
 * five grey bars at 85, 72, 60, 40 and 28 are hard to tell apart at a glance, so
 * ranking a list meant reading every row. The word is still there and still says
 * it in text, so nothing depends on seeing the colour.
 */
export default function Band({ score, why = false }) {
  const name = bandOf(score);
  const top = name === "Excellent" || name === "Strong";
  return (
    <span
      className={`scorebar ${bandClass(score)}${why ? " asks" : ""}`}
      title={why ? `fit ${score} of 100 — open the row for why` : `fit ${score} of 100`}
    >
      <span className="track">
        <span
          className="fill"
          style={{ width: `${Math.max(2, Math.min(100, Number(score) || 0))}%` }}
        />
      </span>
      <span className={`band${top ? " top" : ""}`}>{name}</span>
    </span>
  );
}
