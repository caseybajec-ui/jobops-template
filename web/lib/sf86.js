/**
 * The SF-86 evidence pack — what each section wants, and whether it is done.
 *
 * Pure, like display.js and people.js: no database, no `node:`, so it runs on
 * the server and inside the client component that edits it, and the gap
 * detection can be tested against fixed dates.
 *
 * WHAT THIS IS NOT. It is not the SF-86, it does not submit anything, and it is
 * not advice about the form. It is a place to accumulate the facts the form
 * asks for over the months before there is a form to put them in, because the
 * one thing that reliably goes wrong is being asked for ten years of addresses
 * on a deadline and reconstructing them from memory.
 *
 * THE CLEARANCE RULE APPLIES HERE AS EVERYWHERE. Nothing in this file or the
 * page it drives says the owner is cleared, eligible, or likely to be.
 * Assembling the evidence is a thing they can do; the determination is an
 * adjudicator's.
 */

/** How far back the addresses have to go. The form asks for ten years. */
export const ADDRESS_YEARS = 10;

/**
 * The four sections, their fields, and the words on screen.
 *
 * `required` is what has to be filled for a row to count as complete. A
 * supervisor's phone number is genuinely required by the form and a trip's
 * purpose is genuinely required, so they are not optional here either —
 * a completeness percentage that ignores the hard parts is a percentage that
 * says you are finished when you are not.
 */
export const SECTIONS = [
  {
    key: "address",
    title: "Where you have lived",
    blurb: `Every address for the last ${ADDRESS_YEARS} years, with no gaps. Gaps are the single most common reason a form comes back.`,
    fields: [
      ["label", "Address", "text", "1234 Example St, Apt 5, Los Angeles, CA 90007"],
      ["from_ym", "From", "month", ""],
      ["to_ym", "To", "month", ""],
    ],
    required: ["label", "from_ym"],
    timeline: true,
  },
  {
    key: "employer",
    title: "Where you have worked",
    blurb: "Every employer, and someone there who can confirm it. The supervisor's contact details are the part nobody has written down.",
    fields: [
      ["label", "Employer", "text", "the company's legal name"],
      ["person", "Supervisor", "text", "their name"],
      ["contact", "How to reach them", "text", "email or phone"],
      ["from_ym", "From", "month", ""],
      ["to_ym", "To", "month", ""],
    ],
    required: ["label", "person", "contact", "from_ym"],
    timeline: true,
  },
  {
    key: "travel",
    title: "Foreign travel",
    blurb: "Every trip outside the US, why you went, and when. Short trips count.",
    fields: [
      ["country", "Country", "text", "Australia"],
      ["purpose", "Purpose", "text", "study abroad"],
      ["from_ym", "From", "month", ""],
      ["to_ym", "To", "month", ""],
    ],
    required: ["country", "purpose", "from_ym"],
  },
  {
    key: "contact",
    title: "Foreign contacts",
    blurb: "People who are not US citizens that you have ongoing contact with. Classmates and colleagues count; a barista does not.",
    fields: [
      ["label", "Name", "text", "their name"],
      ["country", "Country", "text", "Australia"],
      ["purpose", "Relationship", "text", "classmate on exchange"],
    ],
    required: ["label", "country", "purpose"],
  },
];

export const SECTION_KEYS = SECTIONS.map((s) => s.key);

/**
 * Sections that can be answered "none".
 *
 * "None" is an ANSWER, and it has to be said. A section with no rows scores
 * zero because an empty list is indistinguishable from a list nobody has got
 * round to — empty-means-none is the silent no-op this repo keeps producing.
 * So "I have no foreign contacts to report" is its own field, stored with a
 * timestamp under `sf86:affirm:<section>` in settings, never inferred. The
 * page, the score and the export all read that field and never the row count.
 */
export const AFFIRMABLE = ["contact"];
export const affirmKey = (section) => `sf86:affirm:${section}`;
export const SECTION_BY_KEY = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

/** Every column a row may carry. The API validates against this. */
export const FIELD_KEYS = ["label", "person", "contact", "purpose", "country",
                           "from_ym", "to_ym"];

/**
 * Rows seeded the first time the page is opened: NONE.
 *
 * The original pre-filled two trips its owner had taken, with the dates
 * deliberately blank -- a fact the repository held, asked as a question. A
 * template holds no such fact about its owner, and a seeded row that is wrong
 * about them is worse than an empty section: this is a form signed under
 * penalty of perjury, and an empty field asks a question where a wrong one
 * does not. The list stays, empty, so seedSf86() and the test keep their shape
 * and an owner who wants to pre-fill their own rows has the one place to do it.
 */
export const SEED = [];

/* --------------------------------------------------------------- the dates */

const ymRe = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validYm(s) {
  return typeof s === "string" && ymRe.test(s);
}

/** Months since year zero, so two YYYY-MM values can be compared and subtracted. */
export function months(ym) {
  if (!validYm(ym)) return null;
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
}

export function ymOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addMonths(ym, n) {
  const t = months(ym);
  if (t === null) return null;
  const v = t + n;
  return `${Math.floor(v / 12)}-${String((v % 12) + 1).padStart(2, "0")}`;
}

/**
 * The gaps in a run of dated spans, and whether the run reaches back far enough.
 *
 * GAPS ARE THE POINT. A form that comes back is almost always a form with a
 * month unaccounted for between two addresses, and that is invisible in a list
 * of addresses sorted by anything at all — you have to lay them end to end.
 *
 * An open span (`to_ym` null) is treated as running to now, which is what "I
 * still live there" means. A span with no start is skipped entirely rather than
 * being given one: an undated row is an unanswered question, and inventing a
 * start for it would close a gap that is really still open.
 */
export function coverage(entries = [], now = new Date(), years = ADDRESS_YEARS) {
  const nowYm = ymOf(now);
  const startYm = addMonths(nowYm, -years * 12);
  const spans = entries
    .filter((e) => validYm(e.from_ym))
    .map((e) => ({
      from: months(e.from_ym),
      to: validYm(e.to_ym) ? months(e.to_ym) : months(nowYm),
      label: e.label || e.country || "(unnamed)",
      from_ym: e.from_ym,
      to_ym: e.to_ym,
    }))
    // A span that ends before it starts is a typo, not a span. Kept visible as
    // its own problem rather than silently reordered into something plausible.
    .map((s) => ({ ...s, broken: s.to < s.from }))
    .sort((a, b) => a.from - b.from || String(a.label).localeCompare(String(b.label)));

  const gaps = [];
  const windowStart = months(startYm);
  const windowEnd = months(nowYm);
  let cursor = windowStart;

  for (const s of spans) {
    if (s.broken) continue;
    if (s.to < windowStart) continue;          // entirely before the window
    if (s.from > cursor) {
      gaps.push({ from: cursor, to: s.from,
                  fromYm: ymFrom(cursor), toYm: ymFrom(s.from),
                  months: s.from - cursor });
    }
    cursor = Math.max(cursor, s.to);
  }
  if (cursor < windowEnd) {
    gaps.push({ from: cursor, to: windowEnd,
                fromYm: ymFrom(cursor), toYm: ymFrom(windowEnd),
                months: windowEnd - cursor });
  }

  const covered = Math.max(0, Math.min(windowEnd - windowStart,
    (windowEnd - windowStart) - gaps.reduce((n, g) => n + g.months, 0)));

  return {
    spans, gaps,
    broken: spans.filter((s) => s.broken),
    windowStart, windowEnd,
    totalMonths: windowEnd - windowStart,
    coveredMonths: covered,
    complete: gaps.length === 0 && spans.length > 0,
  };
}

function ymFrom(m) {
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
}

/* ---------------------------------------------------------- completeness */

/**
 * How far along the pack is, as one number, per section and overall.
 *
 * A row counts when every REQUIRED field on it is filled. A section with no
 * rows at all scores 0 rather than 100 — "nothing to do" and "nothing done"
 * must not look the same, which is the same failure as an empty section reading
 * as a quiet day.
 *
 * Addresses additionally have to COVER the window: ten rows with a two-year
 * hole in the middle is not a complete address history, and a percentage that
 * said otherwise would be actively misleading about the one thing this section
 * exists to get right.
 */
export function completeness(entries = [], now = new Date(), affirmations = {}) {
  const per = {};
  for (const s of SECTIONS) {
    const rows = entries.filter((e) => e.section === s.key);
    const filled = rows.filter((r) =>
      s.required.every((f) => String(r[f] ?? "").trim() !== ""));
    let score = rows.length === 0 ? 0 : filled.length / rows.length;

    // "None", said out loud, is complete. Said beside listed rows it is a
    // contradiction: the rows score on their own and the conflict is flagged
    // rather than either claim being quietly preferred.
    const affirmed = AFFIRMABLE.includes(s.key) ? (affirmations?.[s.key] || null) : null;
    const conflict = !!affirmed && rows.length > 0;
    if (affirmed && rows.length === 0) score = 1;

    if (s.key === "address") {
      const cov = coverage(rows, now);
      const spanScore = cov.totalMonths > 0 ? cov.coveredMonths / cov.totalMonths : 0;
      // The weaker of the two. Well-filled rows that leave a hole are not a
      // complete address history, and neither are complete dates on rows
      // missing the address itself.
      score = rows.length === 0 ? 0 : Math.min(score, spanScore);
    }
    per[s.key] = {
      rows: rows.length,
      complete: filled.length,
      pct: Math.round(score * 100),
      affirmed,
      conflict,
    };
  }
  // Sections weigh equally. Weighting by row count would let twelve trips drown
  // out a missing employment history, and the form does not care which one is
  // longer.
  const pct = Math.round(
    SECTIONS.reduce((n, s) => n + per[s.key].pct, 0) / SECTIONS.length);
  return { per, pct, sections: SECTIONS.length };
}

/* ------------------------------------------------------ employment dates */

/**
 * Every pair of employer rows whose months overlap, with the shared span.
 *
 * Concurrent employment is normal and expected on an SF-86 — a student may
 * work three part-time jobs in one spring and those dates are accurate. What
 * the form rejects is INCONSISTENT dates, and an overlap is where a typo shows
 * up (an end month a year after the internship ended). So this names each pair
 * and the months for a human to confirm, and is never a correction. A
 * same-month handover reports as one shared month for the same reason: the
 * form works in months, and only the owner knows which came first.
 *
 * An undated row is an unanswered question, not a span. An open row runs to
 * now, as it does in coverage().
 */
export function employmentOverlaps(entries = [], now = new Date()) {
  const nowM = months(ymOf(now));
  const spans = entries
    .filter((e) => e.section === "employer" && validYm(e.from_ym))
    .map((e) => ({
      id: e.id, label: e.label || "(unnamed)", from_ym: e.from_ym, to_ym: e.to_ym,
      from: months(e.from_ym),
      to: validYm(e.to_ym) ? months(e.to_ym) : nowM,
    }))
    .filter((s) => s.to >= s.from)
    .sort((a, b) => a.from - b.from || String(a.label).localeCompare(String(b.label))
                 || String(a.id).localeCompare(String(b.id)));
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i], b = spans[j];
      const from = Math.max(a.from, b.from);
      const to = Math.min(a.to, b.to);
      if (to < from) continue;
      out.push({
        a: { id: a.id, label: a.label, from_ym: a.from_ym, to_ym: a.to_ym },
        b: { id: b.id, label: b.label, from_ym: b.from_ym, to_ym: b.to_ym },
        months: to - from + 1,
        fromYm: ymFrom(from), toYm: ymFrom(to),
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------- the export */

/**
 * The whole pack as plain text, for transcribing into eQIP.
 *
 * Plain text on purpose: eQIP is a web form that will be filled in by hand from
 * whatever is on the other screen, and anything cleverer than a readable list
 * is a format that has to be un-formatted first.
 *
 * Marks what is MISSING rather than omitting it. A row with no supervisor
 * contact is the most useful line in the file — it is the next thing to go and
 * find — and leaving it out would make the export look finished.
 */
export function asText(entries = [], now = new Date(), affirmations = {}) {
  const out = [];
  const done = completeness(entries, now, affirmations);
  out.push("SF-86 EVIDENCE PACK");
  out.push(`Assembled ${now.toISOString().slice(0, 10)} — ${done.pct}% complete`);
  out.push("");
  out.push("This is working notes, not a submission. Nothing here has been filed.");
  out.push("");

  for (const s of SECTIONS) {
    const rows = entries.filter((e) => e.section === s.key)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.id).localeCompare(String(b.id)));
    out.push(s.title.toUpperCase());
    const affirmed = done.per[s.key].affirmed;
    if (!rows.length) {
      // Two different facts, two different lines. "Nothing recorded" with no
      // affirmation is a question still open; with one, it is the answer.
      if (affirmed) {
        out.push(`  Affirmed: no ${s.title.toLowerCase()} to report (affirmed ${affirmed.slice(0, 10)})`);
      } else if (AFFIRMABLE.includes(s.key)) {
        out.push("  (nothing recorded yet — UNANSWERED: add them, or affirm there are none)");
      } else {
        out.push("  (nothing recorded yet)");
      }
      out.push("");
      continue;
    }
    if (done.per[s.key].conflict) {
      out.push(`  CONFLICT: affirmed none on ${affirmed.slice(0, 10)}, but ${rows.length} listed below. Resolve before filing.`);
    }
    for (const r of rows) {
      const bits = [];
      for (const [f, label] of s.fields) {
        const v = String(r[f] ?? "").trim();
        if (v) bits.push(`${label}: ${v}`);
        else if (s.required.includes(f)) bits.push(`${label}: *** MISSING ***`);
      }
      out.push(`  - ${bits.join(" | ")}`);
    }
    if (s.key === "employer") {
      const over = employmentOverlaps(rows, now);
      if (over.length) {
        out.push("");
        out.push("  OVERLAPPING DATES — concurrent employment is normal and expected; confirm each pair is accurate:");
        for (const o of over) {
          out.push(`    ${o.a.label} (${o.a.from_ym} to ${o.a.to_ym || "now"}) and ${o.b.label} (${o.b.from_ym} to ${o.b.to_ym || "now"}): `
                   + `overlap for ${o.months} month${o.months === 1 ? "" : "s"}, ${o.fromYm} to ${o.toYm}`);
        }
      }
    }
    if (s.key === "address") {
      const cov = coverage(rows, now);
      if (cov.gaps.length) {
        out.push("");
        out.push(`  GAPS in the last ${ADDRESS_YEARS} years — these get a form kicked back:`);
        for (const g of cov.gaps) {
          out.push(`    ${g.fromYm} to ${g.toYm} (${g.months} month${g.months === 1 ? "" : "s"} unaccounted for)`);
        }
      }
    }
    out.push("");
  }
  return out.join("\n");
}
