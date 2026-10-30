import {
  CATEGORIES, CATEGORY_LABEL, categoryClass, progressOf,
} from "@/lib/palette";

/**
 * The three presentational pieces the colour system adds. No "use client":
 * they hold no state and no handlers, so they render on the server inside Daily
 * and Forecast and get bundled into the client inside Inbox and Companies,
 * which is the cheaper of the two and needs no directive either way.
 */

/**
 * What kind of company this is. A 7px dot, never a tag.
 *
 * Renders NOTHING for an unknown category rather than a neutral dot. A grey dot
 * in a row of coloured ones reads as a fifth category; absence reads as "not
 * classified", which is what it is.
 *
 * Colour alone is never the only carrier: every dot has an accessible name, so
 * the fact survives a screen reader and a colour-blind reader hovering it.
 */
export function CategoryDot({ category }) {
  const cls = categoryClass(category);
  if (!cls) return null;
  return (
    <span
      className={`dot ${cls}`}
      role="img"
      aria-label={CATEGORY_LABEL[category]}
      title={CATEGORY_LABEL[category]}
    />
  );
}

/**
 * The legend, in the footer of a list view.
 *
 * Without it the dots are a code you are expected to have learned, which is the
 * same failure as an unlabelled control: it works for whoever built it.
 *
 * ALWAYS ALL FOUR. It used to narrow to the categories actually on the page,
 * on the argument that naming four when two are visible is noise. That argument
 * loses to a worse one: the set was computed from the FILTERED rows, so Daily
 * showed three dots, Inbox two and Forecast four, and Inbox's own set changed
 * every time a filter moved. A key that changes when the data changes is not a
 * key — it is another thing on the page to re-read, and the reader cannot tell
 * "there are no VC firms" from "there are no VC firms *matching this filter*".
 *
 * Four dots is one short line. `only` is still accepted and ignored rather than
 * removed from the call sites, so nothing silently starts passing a set that
 * does nothing; the parameter documents itself here instead.
 */
export function CategoryLegend({ only = null, note = null }) {
  const shown = CATEGORIES;
  if (!shown.length) return null;
  return (
    <p className="legend">
      {shown.map(([k, label]) => (
        <span className="lg" key={k}>
          <span className={`dot ${categoryClass(k)}`} aria-hidden="true" />
          {label}
        </span>
      ))}
      {note && <span className="lgnote">{note}</span>}
    </p>
  );
}

/**
 * A count, drawn.
 *
 * A green fill on a neutral track, because the LENGTH is the point: "16 of 25
 * tracked windows have no date" is this tool's own stated biggest risk and it
 * rendered as a sentence in a paragraph of other sentences.
 *
 * THE REMAINDER IS THE TRACK, NOT A COLOUR. It was amber, on the argument that
 * not-yet-done deserves to be visible. What that actually produced was a bar
 * that is SOLID AMBER at 0% — People's "0 of 5 messages" read at a glance as a
 * full alert rather than as an empty one, which is the opposite of the fact. And
 * amber already means "closes in 8-30 days" on every other surface here, so a
 * second meaning was being loaded onto a colour that was spoken for.
 *
 * A fill on a track cannot make that mistake: empty is empty, full is full, and
 * the only colour on the bar is the one that means done.
 *
 * The number stays next to the bar. A bar alone is a shape; the sentence under
 * it is what makes it a fact.
 */
export function Meter({ done, total, label = null, id = null }) {
  const p = progressOf(done, total);
  return (
    <div className="meter">
      <div
        className="meter-track"
        role="progressbar"
        aria-valuenow={p.done}
        aria-valuemin={0}
        aria-valuemax={p.total}
        aria-labelledby={id || undefined}
      >
        <span className="meter-done" style={{ width: `${p.pct}%` }} />
      </div>
      {label && <span className="meter-label" id={id || undefined}>{label}</span>}
    </div>
  );
}
