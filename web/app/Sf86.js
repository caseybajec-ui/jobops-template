"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { copyText } from "./useAction";
import { Meter } from "./Palette";
import {
  SECTIONS, ADDRESS_YEARS, AFFIRMABLE, coverage, completeness, asText, ymOf,
  employmentOverlaps,
} from "@/lib/sf86";

/**
 * The SF-86 evidence pack.
 *
 * "Assemble the SF-86 evidence pack" was one line on a checklist, and the thing
 * it names is weeks of intermittent remembering: ten years of addresses with no
 * gaps, every employer with a supervisor who can still be reached, every trip,
 * every foreign contact. A checkbox is the wrong shape in both directions — it
 * cannot honestly be ticked until the whole thing is done, and it says nothing
 * about how far along it is. So it sat there, untouched, for the life of the
 * list.
 *
 * AUTOSAVE ON BLUR, one field at a time. Nothing to submit and nothing to lose:
 * this gets filled in three minutes at a time over months, and a Save button at
 * the bottom of a form that long is a way to lose an evening's remembering.
 *
 * THIS IS NOT THE FORM. Nothing here is submitted anywhere, and nothing here
 * says the owner is cleared or eligible for anything — assembling the evidence
 * is a thing they can do; the determination is an adjudicator's. That distinction is a
 * hard rule in CLAUDE.md and it holds on this page like everywhere else.
 */

/** One field, saved when it loses focus. */
function Field({ row, field, label, type, placeholder }) {
  const [value, setValue] = useState(row[field] ?? "");
  const [state, setState] = useState("idle");   // idle | saving | saved | error
  const [err, setErr] = useState(null);

  async function save() {
    // Nothing changed, nothing to say. A "saved" flash on a field you merely
    // tabbed through is noise that teaches you to ignore the real ones.
    if ((row[field] ?? "") === value) return;
    setState("saving");
    setErr(null);
    try {
      const res = await fetch("/api/sf86", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save", id: row.id, field, value }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "not saved");
      }
      row[field] = value;
      setState("saved");
      setTimeout(() => setState("idle"), 1500);
    } catch (e) {
      // STAYS red until it is fixed. A field that failed to save and then went
      // quiet is a field you believe is saved — the same lie the invisible
      // optimistic-rollback error told, which is why that one is on its own line.
      setState("error");
      setErr(e.message);
    }
  }

  // Built as a value rather than interpolated into the className string.
  // `sf-${field}` leaves a bare "sf-" once test_classes.mjs strips the
  // interpolation, and it then reports a class nobody wrote as undefined.
  const widthClass = `sf-${field}`;
  return (
    <label className={`sffield ${widthClass} ${state === "error" ? "sferr" : ""}`}>
      <span className="dim">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      {state === "saved" && <span className="sfok" aria-hidden="true">saved</span>}
      {state === "error" && <span className="acterr">{err}</span>}
    </label>
  );
}

/**
 * The address timeline. Ten years, laid end to end, with the holes shown.
 *
 * This is the whole reason the section is not just a list. A gap of four months
 * in 2021 is invisible in a list sorted by any field you like — you have to put
 * the spans on one line to see that they do not touch — and a gap is the single
 * most common reason a form comes back.
 */
function Timeline({ rows, now }) {
  const cov = coverage(rows, now);
  if (!cov.spans.length && !cov.gaps.length) return null;
  const span = cov.totalMonths || 1;
  const pct = (m) => `${(m / span) * 100}%`;

  return (
    <div className="sftimeline">
      <div className="sftrack">
        {cov.spans.filter((s) => !s.broken).map((s, i) => (
          <span
            key={i}
            className="sfspan"
            title={`${s.label}: ${s.from_ym} to ${s.to_ym || "now"}`}
            style={{
              left: pct(Math.max(0, s.from - cov.windowStart)),
              width: pct(Math.max(0, Math.min(s.to, cov.windowEnd)
                                     - Math.max(s.from, cov.windowStart))),
            }}
          />
        ))}
        {cov.gaps.map((g, i) => (
          <span
            key={`g${i}`}
            className="sfgap"
            title={`${g.months} months unaccounted for, ${g.fromYm} to ${g.toYm}`}
            style={{
              left: pct(g.from - cov.windowStart),
              width: pct(g.to - g.from),
            }}
          />
        ))}
      </div>
      <p className="sfscale">
        <span>{ymOf(new Date(Date.UTC(Math.floor(cov.windowStart / 12), cov.windowStart % 12)))}</span>
        <span>today</span>
      </p>
      {cov.gaps.length > 0 ? (
        <p className="sfgaps">
          <strong>
            {cov.gaps.length} gap{cov.gaps.length === 1 ? "" : "s"} in the last{" "}
            {ADDRESS_YEARS} years.
          </strong>{" "}
          {cov.gaps.map((g) => `${g.fromYm} to ${g.toYm} (${g.months}mo)`).join(" · ")}.
          This is what gets a form kicked back.
        </p>
      ) : (
        <p className="sfnogaps">
          No gaps. {ADDRESS_YEARS} years accounted for end to end.
        </p>
      )}
      {cov.broken.length > 0 && (
        <p className="sfgaps">
          {cov.broken.length} row{cov.broken.length === 1 ? " ends" : "s end"} before
          {cov.broken.length === 1 ? " it starts" : " they start"} — check the dates.
        </p>
      )}
    </div>
  );
}

/**
 * "None" is an answer, and this is where it is said.
 *
 * A checkbox that writes its own timestamped field. It does NOT read the row
 * count: an empty list is a question nobody has got round to, and the score
 * stays at zero until this is ticked or a row is added. Unticking withdraws
 * it — stores null — rather than deleting anything.
 */
function AffirmNone({ section, title, affirmed, conflict, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function toggle(value) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/sf86", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "affirm", section, value }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "not saved");
      }
      onChange();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <p className="sfaffirm">
      <label>
        <input type="checkbox" checked={!!affirmed} disabled={busy}
               onChange={(e) => toggle(e.target.checked)} />{" "}
        I have no {title.toLowerCase()} to report
      </label>
      {affirmed && (
        <span className="dim"> — affirmed {String(affirmed).slice(0, 10)}. This section counts as complete.</span>
      )}
      {!affirmed && <span className="dim"> — unanswered until you tick this or add one.</span>}
      {conflict && (
        <span className="sfgaps"> Affirmed none, but there are entries listed above. One of those is wrong — resolve it before filing.</span>
      )}
      {err && <span className="acterr"> {err}</span>}
    </p>
  );
}

/**
 * Overlapping employment dates, named — a thing to confirm, not an error.
 *
 * Concurrent part-time employment is normal and expected on an SF-86, and
 * a student's spring rows are often exactly that. The one time an overlap was
 * a typo (an end month a year after the internship ended) this list is what
 * surfaced it; the other four were accurate and stayed. So the copy asks the
 * owner to confirm the dates, and never suggests something needs fixing. Rendered in
 * the note colour rather than the alert colour for the same reason.
 */
function Overlaps({ rows, now }) {
  const over = employmentOverlaps(rows, now);
  if (!over.length) return null;
  return (
    <p className="sfoverlap">
      <strong>{over.length} overlapping date range{over.length === 1 ? "" : "s"}</strong>
      {" — "}concurrent employment is normal; just confirm each pair is accurate.{" "}
      {over.map((o) =>
        `${o.a.label} (${o.a.from_ym} to ${o.a.to_ym || "now"}) and ${o.b.label} (${o.b.from_ym} to ${o.b.to_ym || "now"}) overlap for ${o.months} month${o.months === 1 ? "" : "s"}`,
      ).join(" · ")}.
    </p>
  );
}

export default function Sf86({ rows = [], ready = true, affirmations = {} }) {
  const router = useRouter();
  const now = new Date();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!ready) {
    return (
      <div className="sheet">
        <p className="page-intro">
          The evidence-pack table is not in this database yet. Run{" "}
          <code>cd web &amp;&amp; node lib/applymigration.mjs ../migrations/004_sf86.sql</code>{" "}
          once. Nothing else in the app is affected.
        </p>
      </div>
    );
  }

  const done = completeness(rows, now, affirmations);

  async function add(section) {
    setBusy(true);
    try {
      await fetch("/api/sf86", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add", section }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    setBusy(true);
    try {
      await fetch("/api/sf86", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet">
      <h1 className="abouth">SF-86 evidence pack</h1>
      <p className="page-intro">
        Working notes for the facts a security questionnaire asks for, gathered
        now instead of in a week under a deadline. Nothing here is submitted
        anywhere, and nothing here says anything about whether you would be
        granted a clearance — that is a determination a government adjudicator
        makes, not you and not this tool. What you can do is have the answers
        ready.
      </p>
      <p className="sub">
        Every box saves when you click away from it. Come back to it three
        minutes at a time.
      </p>

      <Meter
        done={done.pct}
        total={100}
        id="sf86-progress"
        label={
          <>
            <span className="mstrong">{done.pct}% assembled.</span>{" "}
            {SECTIONS.map((s) => `${s.title.toLowerCase()} ${done.per[s.key].pct}%`).join(" · ")}.
          </>
        }
      />

      {SECTIONS.map((s) => {
        const mine = rows.filter((r) => r.section === s.key);
        return (
          <section className="section" key={s.key}>
            <h2>
              {s.title}
              <span className="h2note"> — {done.per[s.key].pct}% </span>
            </h2>
            <p className="sub">{s.blurb}</p>

            {s.timeline && s.key === "address" && <Timeline rows={mine} now={now} />}
            {s.key === "employer" && <Overlaps rows={mine} now={now} />}

            {mine.length === 0 && !done.per[s.key].affirmed && (
              <p className="nothing">
                Nothing here yet. {s.key === "address"
                  ? "Start with where you live now and work backwards."
                  : "Add the first one."}
              </p>
            )}

            {mine.map((r) => (
              <div className="sfrow" key={r.id}>
                {s.fields.map(([field, label, type, placeholder]) => (
                  <Field
                    key={field}
                    row={r}
                    field={field}
                    label={label}
                    type={type}
                    placeholder={placeholder}
                  />
                ))}
                <button
                  type="button"
                  className="linkish sfdel"
                  disabled={busy}
                  title="Remove this row"
                  onClick={() => remove(r.id)}
                >
                  remove
                </button>
              </div>
            ))}

            {AFFIRMABLE.includes(s.key) && (
              <AffirmNone section={s.key} title={s.title}
                          affirmed={done.per[s.key].affirmed}
                          conflict={done.per[s.key].conflict}
                          onChange={() => router.refresh()} />
            )}

            <p className="sfadd">
              <button type="button" disabled={busy} onClick={() => add(s.key)}>
                Add {s.key === "address" ? "an address"
                  : s.key === "employer" ? "an employer"
                  : s.key === "travel" ? "a trip" : "a contact"}
              </button>
              {s.key === "employer" && (
                <span className="dim">
                  {" "}The supervisor&apos;s contact details are the part that is
                  hardest to find later. Get them while you still have the email.
                </span>
              )}
            </p>
          </section>
        );
      })}

      <section className="section">
        <h2>Take it with you</h2>
        <p className="sub">
          Plain text, for typing into eQIP when the time comes. Anything still
          missing is marked, rather than left out — a missing supervisor is the
          most useful line in the file.
        </p>
        <p className="sfadd">
          <button
            type="button"
            onClick={async () => {
              setCopied(await copyText(asText(rows, now, affirmations)));
              setTimeout(() => setCopied(false), 2500);
            }}
          >
            {copied ? "Copied to the clipboard" : "Export as text"}
          </button>
        </p>
      </section>
    </div>
  );
}
