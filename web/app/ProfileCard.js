"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { copyText } from "./useAction";
import { FIELDS, GROUPS, READ_ONLY, copyAllText, completeness } from "@/lib/card";
import { VARIANTS, VARIANT_KEYS } from "@/lib/variant";

/**
 * The fields every application form asks for, with a copy button on each.
 *
 * WHY THIS IS THE WHOLE FEATURE. A Workday form asks for the same legal name,
 * address, phone, GPA and graduation date every time, and the owner retypes
 * them from memory. Retyping is where a 3.91 becomes a 3.19 and a postcode loses a
 * digit, and neither is noticeable until the application has already gone.
 *
 * NO SAVE BUTTON. It autosaves on blur, because a save button on a page you
 * visit to copy one field is a step you skip, and a skipped save on a form you
 * then paste from is worse than not having stored it at all.
 *
 * A FAILED SAVE MUST BE VISIBLE. The optimistic-save rollback in this codebase
 * once reverted correctly while its error message sat clipped behind a column,
 * so a failed save looked exactly like never having typed. The error here gets
 * its own line under the field, and the field keeps what he typed rather than
 * snapping back to the stored value — losing his text to tell him it did not
 * save would be the same lie twice.
 */
export default function ProfileCard({ profile = {}, ready = true, compact = false }) {
  const router = useRouter();
  const [values, setValues] = useState(profile);
  const [errors, setErrors] = useState({});
  const [saved, setSaved] = useState({});
  const [copied, setCopied] = useState(null);
  // Which resume the three bullets belong to. Tech first because every
  // fetched role today is defense or product; finance lives on the deadline
  // rows, where consulting and VC actually recruit.
  const [variant, setVariant] = useState("tech");

  const done = completeness(values);

  async function save(key, value) {
    if (READ_ONLY.has(key)) return;
    if (String(profile[key] || "") === String(value || "")) return;   // nothing changed
    setErrors((e) => ({ ...e, [key]: null }));
    try {
      const r = await fetch("/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value: String(value ?? "") }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "could not save");
      setSaved((s) => ({ ...s, [key]: true }));
      setTimeout(() => setSaved((s) => ({ ...s, [key]: false })), 1500);
      router.refresh();
    } catch (e) {
      setErrors((err) => ({ ...err, [key]: String(e.message || e) }));
    }
  }

  async function copy(key, value) {
    if (!value) return;
    if (await copyText(value)) {
      setCopied(key);
      // Reverts on its own. A "Copied" that stays put reads as a state the row
      // is now in, rather than as something that just happened.
      setTimeout(() => setCopied(null), 1500);
    }
  }

  if (!ready) {
    return (
      <p className="nothing">
        The profile table is not in this database yet. It arrives with the next
        daily run, which applies any migration it has not seen.
      </p>
    );
  }

  return (
    <div className={`card${compact ? " compact" : ""}`}>
      <p className="cardtop">
        <span className="dim">{done.filled} of {done.total} filled.</span>{" "}
        <button
          type="button"
          className="railbtn"
          onClick={() => copy("__all", copyAllText(values, variant))}
        >
          {copied === "__all" ? "Copied" : "Copy all as text"}
        </button>
      </p>

      {/* THE RESUMES. Two documents, and the rule for which goes where is the
          same code the Apply tags use, so the card and the buttons cannot come
          to different conclusions. */}
      <section className="cardgroup">
        <h3 className="railhead">Resumes</h3>
        {VARIANT_KEYS.map((k) => (
          <div className="cardrow" key={k}>
            <span className="cardlabel">{VARIANTS[k].label}</span>
            <span className="cardvalue ro">
              <a href={VARIANTS[k].pdf} download={VARIANTS[k].filename}>
                {VARIANTS[k].filename}
              </a>
              {" — "}{VARIANTS[k].goesTo}
            </span>
          </div>
        ))}
        <p className="cardnote">
          Chosen by the company&rsquo;s category, not by a model: defense and
          product &amp; tech take the tech resume, consulting and VC &amp; growth
          take the finance one. A company with no category gets no
          recommendation rather than a guess.{" "}
          <a href="/resumes">See both documents</a> — the PDFs as sent, and the
          text the scorer reads.
        </p>
      </section>

      {GROUPS.map(([g, glabel]) => (
        <section className="cardgroup" key={g}>
          <h3 className="railhead">{glabel}</h3>
          {/* The bullets exist twice, once per resume. The toggle picks which
              three are shown, edited and copied — never both at once, because
              two fields labelled "Bullet 1" holding different text is a card
              you cannot read an answer off. */}
          {g === "bullets" && (
            <div className="varswitch" role="group" aria-label="Which resume these bullets are for">
              {VARIANT_KEYS.map((k) => (
                <button
                  type="button"
                  key={k}
                  className={`act${variant === k ? " on" : ""}`}
                  aria-pressed={variant === k}
                  onClick={() => setVariant(k)}
                >
                  {VARIANTS[k].label}
                </button>
              ))}
            </div>
          )}
          {FIELDS
            .filter(([, , grp]) => grp === g)
            .filter(([, , , o]) => !o?.variant || o.variant === variant)
            .map(([key, label, , opts]) => {
            const v = values[key] || "";
            const ro = READ_ONLY.has(key);
            return (
              <div className={`cardrow${ro ? " ro" : ""}`} key={key}>
                <label className="cardlabel" htmlFor={`f-${key}`}>{label}</label>
                {ro ? (
                  <span className="cardvalue ro" id={`f-${key}`}>{v}</span>
                ) : opts?.multiline ? (
                  <textarea
                    id={`f-${key}`}
                    rows={2}
                    value={v}
                    onChange={(e) => setValues((s) => ({ ...s, [key]: e.target.value }))}
                    onBlur={(e) => save(key, e.target.value)}
                  />
                ) : (
                  <input
                    id={`f-${key}`}
                    type="text"
                    value={v}
                    onChange={(e) => setValues((s) => ({ ...s, [key]: e.target.value }))}
                    onBlur={(e) => save(key, e.target.value)}
                  />
                )}
                <button
                  type="button"
                  className="act cardcopy"
                  disabled={!v}
                  title={v ? `Copy ${label}` : "Nothing to copy yet"}
                  onClick={() => copy(key, v)}
                >
                  {copied === key ? "Copied" : "Copy"}
                </button>
                {saved[key] && <span className="cardsaved">saved</span>}
                {/* Its own line. A save error clipped by a column is a failed
                    save that looks exactly like never having typed. */}
                {errors[key] && <span className="acterr" role="status">{errors[key]}</span>}
              </div>
            );
          })}
          {g === "eligibility" && (
            <p className="cardnote">
              The clearance line is fixed on purpose. It matches what the scorer
              is told, and eligibility is a determination a government
              adjudicator makes — not something this tool, or you, may assert on
              an application.
            </p>
          )}
          {g === "bullets" && (
            <p className="cardnote">
              Yours, pasted in. Nothing here writes them: the tool selects and
              orders what you have written, and never invents a claim or a
              number.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
