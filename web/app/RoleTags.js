import { startFor } from "@/lib/start";
import { placeFor } from "@/lib/geo";
import { PREFS } from "@/lib/config.generated";

/**
 * Where a role is, and when it starts. Two small grey tags on every row.
 *
 * DISPLAY ONLY. Neither of these touches a score, and that is the whole design:
 * Palantir's Deployment Strategist is the highest-fit posting in the corpus and
 * one of its locations is Colorado Springs. Weighting location into fit would
 * push the best role on the board down the page in order to express a
 * preference — and a preference is a thing you decide with, not a thing that
 * decides for you.
 *
 * The location was already on the row, in a column that truncates ("Colorado
 * Springs, ..."), so reading it meant hovering. What was missing is the
 * ANSWER — is this one of the two cities I want — which is what the tag gives.
 */

/**
 * ONE CHIP, and the preference is a mark INSIDE it.
 *
 * There has only ever been one component here, but on the page it did not read
 * as one: "SF" and "NY" came out bold ink, "Austin" and "Colorado Springs"
 * graphite, "remote" graphite lowercase, and three weights of the same chip
 * look like three different controls. Weight alone was carrying the whole
 * distinction — and weight is the least legible signal on a 11px monospace tag,
 * invisible next to a bold company name and gone entirely in a screenshot.
 *
 * So the preferred ones keep the heavier weight AND gain a tick. Same chip,
 * same size, same ground; one glyph is the difference between "somewhere" and
 * "somewhere you want". The tick is aria-hidden because the title already says
 * it in a sentence — reading "New York tick" would be worse than reading
 * "In New York, which you want."
 */
export function PlaceTag({ role }) {
  const p = placeFor(role, PREFS);
  if (!p.label) return null;
  // A CHIP THAT REPEATS ITS NEIGHBOUR ANSWERS NOTHING. For somewhere that is
  // neither preferred nor home the chip's label IS the first word of the
  // location cell beside it — "Atlanta, ...  Atlanta" — so it costs width and
  // says nothing new. Worse, once the chip stopped being clipped it competed
  // for that width and squeezed the real location down to a sliver: a 33-
  // character "Colorado Springs, CO +5 locations" reduced to about one glyph so
  // that a chip reading "Colorado Springs" could sit beside it.
  //
  // Preferred and home are different: "NY ✓" and "LA" are answers the column
  // does not give, in three characters. Those render; the echo does not.
  if (p.kind === "other") return null;
  return (
    <span className={`ptag${p.preferred ? " want" : ""}`} title={p.title || undefined}>
      {p.label}
      {p.preferred && <span className="ptick" aria-hidden="true">✓</span>}
    </span>
  );
}

/**
 * The stated start, or the honest absence of one.
 *
 * 668 of 734 open scored roles state no start at all, so "start not stated" is
 * the overwhelmingly common answer and it is deliberately shown rather than
 * hidden: it is the question to ask on a call, and a blank row would leave him
 * rediscovering that per application. Nothing is inferred from the class year —
 * inferring it would turn an open question into a fact on a screen.
 */
/**
 * The class per verdict, ENUMERATED rather than interpolated.
 *
 * `stag-${verdict}` builds a class name no static check can see, so
 * test_classes.mjs could only report a bare "stag-" with no rule behind it —
 * and could never have told us that a real verdict was missing its style. A
 * lookup fails loudly in the same test instead.
 */
const START_CLASS = {
  match: "stag-match",
  earlier: "stag-earlier",
  year_only: "stag-year_only",
  too_early: "stag-too_early",
  later: "stag-later",
  other: "stag-other",
  unstated: "stag-unstated",
};

export function StartTag({ role }) {
  const s = startFor(role, PREFS);
  if (!s.year && !s.note) return null;
  return (
    <span className={`stag ${START_CLASS[s.verdict] || "stag-unstated"}`}
          title={s.note || undefined}>
      {s.label}
    </span>
  );
}
