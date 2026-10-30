/**
 * A Daily section: a heading, an anchor, and a name the rail can read.
 *
 * NO COLLAPSE. It had one — a chevron on every heading, folding persisted per
 * browser, and the rail marking folded sections — and it is gone at the owner's
 * call. The argument for it was that Daily's order is right for the general
 * case and wrong for a particular morning, so let the reader fold what they do
 * not want. The argument against is simpler and won: it is a control on every
 * heading, on a page whose whole redesign was about having less to look at, for
 * a decision nobody was actually going to make each day. Machinery you never
 * touch is not neutral — it is more page.
 *
 * What survives is the half that pays for itself with no interaction at all:
 * `data-section`, which SectionNav reads to build the rail's jump list. The
 * PAGE is the source of truth for which sections exist, because half of them
 * are conditional — Saved appears only when something is saved, People becomes
 * Follow-ups owed once anyone is on the list — and a hand-kept array in the
 * rail would link to a section that is not there the first time one of those
 * conditions changed, with nothing to say so.
 *
 * A server component now, which is the other thing dropping the toggle bought:
 * no state, no effect, no client bundle.
 */
export default function Section({ id, title, note = null, children }) {
  return (
    <section className="section" id={id} data-section={title}>
      <h2>
        {title}
        {note}
      </h2>
      {children}
    </section>
  );
}
