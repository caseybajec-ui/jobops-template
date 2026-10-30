import {
  chipClass, urgencyOf, verificationOf, URGENCY_SENTENCE, VERIFICATION_SENTENCE,
  VERIFICATION_WORD,
} from "@/lib/chips";
import { inDays } from "@/lib/plural";

/**
 * One chip, three variants. A server component: it renders a span and has no
 * state, so it costs nothing on any page that uses it.
 *
 * The gap between a chip and the text before it is set HERE, in the stylesheet,
 * not at each call site. It was set per call site and missing in Closing soon,
 * where the verification chip sat flush against the company name and read as
 * part of it.
 */
export default function Chip({ variant, tone, outlined = false, title, children }) {
  return (
    <span className={chipClass(variant, tone, outlined)} title={title}>
      {children}
    </span>
  );
}

/** How long until it closes. TODAY is the only filled red pill in the app. */
export function UrgencyChip({ days, kind = "external", label = null, explain = false }) {
  const u = urgencyOf(days, kind);
  if (!u) return null;
  const text = label || (Number(days) < 0
    ? `${Math.abs(Math.round(days))} days overdue`
    : inDays(days));
  return (
    <Chip
      variant="urgency"
      tone={u.tone}
      outlined={u.outlined}
      // The scale explained where it is used, on the first chip only, so the
      // sentence is one click from every place the colour appears rather than
      // living solely in a legend at the foot of the page.
      title={explain ? URGENCY_SENTENCE
                     : (u.kind === "self" ? "A date you set yourself." : undefined)}
    >
      {u.tone === "today" && Number(days) >= 0 ? "TODAY" : text}
      {explain && <span className="chipq" aria-hidden="true">?</span>}
    </Chip>
  );
}

/**
 * How much a date is worth.
 *
 * The most important chip on the page and the quietest-looking. 1 of 25 tracked
 * dates is read from a firm's own site; the rest are prompts to check. A note
 * reading "MBB closes mid/late September" for a window that had already shut on
 * 11 August is what this exists to stop happening twice.
 */
export function VerificationChip({ confidence, short = false, explain = false }) {
  const v = verificationOf(confidence);
  const label = VERIFICATION_WORD[v.tone];
  return (
    <Chip
      variant="verification"
      tone={v.tone}
      outlined={v.tone !== "confirmed"}
      // The scale explained on the FIRST chip of a list, the same way the
      // urgency chip does it — so the sentence is one hover from every place
      // the colour appears rather than only in the footer legend.
      title={explain ? `${v.why} ${VERIFICATION_SENTENCE}` : v.why}
    >
      {short && v.tone === "confirmed" ? "✓" : label}
      {explain && <span className="chipq" aria-hidden="true">?</span>}
    </Chip>
  );
}

/** A fact about the role. Grey on purpose: it is not a claim on today. */
export function StatusChip({ children, title }) {
  return <Chip variant="status" title={title}>{children}</Chip>;
}
