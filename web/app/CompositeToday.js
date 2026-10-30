"use client";

import { useState } from "react";
import { trimToFit } from "@/lib/availability";
import { useRouter } from "next/navigation";
import { urgencyClass } from "@/lib/palette";
import { UNDO_WINDOW_SECONDS } from "@/lib/lifecycle";
import ResumeTag from "./ResumeTag";

/**
 * The TODAY card when it covers more than one firm.
 *
 * "Apply to Accenture, Deloitte and EY-Parthenon" is three applications and it
 * had ONE tick box. There was no way to record having done two of them, so the
 * item stayed open, said nothing about progress, and the only honest moment to
 * check it off was after all three — which is a week apart from the first.
 *
 * One row per firm, each its own checkbox, each its own countdown. Ticking a
 * row records a real application: the same object, the same lifecycle and the
 * same days-in-stage arithmetic as a role off a job board, so these three show
 * up in In flight beside everything else instead of being invisible to the
 * tracker that exists to watch them.
 *
 * The single-firm card keeps its "Mark it done" — a checklist of one is a
 * checkbox with extra steps.
 */
export default function CompositeToday({ windows = [], applied = {}, hours = null }) {
  // TRIMMED TO WHAT FITS, and it says what it moved. An unanswered day trims
  // nothing — see lib/availability.js for why that is the default rather than a
  // fallback. The order is the ladder's and is never repacked to fill the day:
  // the ranking is argued, and saving fifteen minutes is not worth losing it.
  const plan = trimToFit(
    windows.map((w) => ({ ...w, label: w.firm, minutes: w.minutes })), hours);
  const shown = plan.fits;
  const router = useRouter();
  // Rows this session created, so the undo window can be offered and then
  // withdrawn. Server state is the source of truth on reload; this is only
  // what is still inside its sixty seconds.
  const [fresh, setFresh] = useState({});
  const [asking, setAsking] = useState(null);   // window key awaiting the referral answer
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const done = windows.filter((w) => applied[w.key] || fresh[w.key]).length;
  const total = windows.length;

  async function post(payload) {
    const res = await fetch("/api/manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(b.error || "Couldn't save — try again");
    return b;
  }

  async function submit(w) {
    setBusy(w.key);
    setErr(null);
    try {
      const { id } = await post({
        action: "create",
        firm_label: w.firm,
        program_name: w.program,
        class_year: w.classYear,
        window_id: w.key,
        source: "window",
        status: "applied",
      });
      setFresh((f) => ({ ...f, [w.key]: { id, at: Date.now() } }));
      // The referral question opens IN PLACE, immediately, because it is about
      // the thing just done. Asked later it is a quiz about last week.
      setAsking(w.key);
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function answer(w, referral) {
    const rec = fresh[w.key];
    if (!rec) { setAsking(null); return; }
    setBusy(w.key);
    try {
      await post({ action: "referral", id: rec.id, referral });
      setAsking(null);
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function undo(w) {
    const rec = fresh[w.key];
    if (!rec) return;
    setBusy(w.key);
    setErr(null);
    try {
      await post({ action: "undo", id: rec.id });
      setFresh((f) => { const n = { ...f }; delete n[w.key]; return n; });
      setAsking(null);
      router.refresh();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  // All three in: the card has nothing left to ask, so it stops taking space.
  if (total > 0 && done === total) {
    return (
      <p className="compdone">
        Submitted all {total} — tracking {total === 1 ? "it" : "them"} in{" "}
        <a href="#inflight">In flight</a>.
      </p>
    );
  }

  return (
    <div className="composite">
      <p className="compcount">
        {done} of {total} submitted
      </p>

      {/* NAMES WHAT MOVED. A list that silently shortens cannot be told apart
          from one that lost something, and the whole value of answering "two
          hours" is knowing which firm waits until tomorrow. */}
      {plan.message && <p className="trimmed">{plan.message}</p>}

      <ul className="complist">
        {shown.map((w) => {
          const rec = fresh[w.key];
          const isDone = !!applied[w.key] || !!rec;
          // Undoable only inside the window, and only for a row this session
          // created — a row already in the database on page load is history.
          const undoable = rec && (Date.now() - rec.at) / 1000 <= UNDO_WINDOW_SECONDS;
          return (
            <li className="comprow" key={w.key}>
              <label className="compmain">
                <input
                  type="checkbox"
                  checked={isDone}
                  disabled={busy === w.key || (isDone && !undoable)}
                  aria-label={`Mark ${w.firm} submitted`}
                  onChange={(e) => (e.target.checked ? submit(w) : undo(w))}
                />
                <span className="compfirm">{w.firm}</span>
                <span className="compprog">— {w.program}</span>
                {/* This is where the finance resume actually lives. There are
                    no fetched consulting or VC roles — those firms recruit
                    through channels the board fetcher cannot see — so without
                    a tag here the finance variant would never appear on any
                    surface the owner uses to apply. */}
                <ResumeTag category={w.category} />
              </label>

              <span className={`compwhen ${urgencyClass(w.closeIn)}`}>
                {w.closeIn === null
                  ? "no date"
                  : w.closeIn < 0
                    ? `${Math.abs(w.closeIn)}d ago`
                    : w.closeIn === 0
                      ? "today"
                      : `${w.closeIn} ${w.closeIn === 1 ? "day" : "days"}`}
              </span>

              {/* Asked once, in place, about the thing just ticked. */}
              {asking === w.key && (
                <span className="compask">
                  <span className="dim">Submitted. With a referral or without?</span>
                  <button type="button" disabled={busy === w.key}
                          onClick={() => answer(w, true)}>With a referral</button>
                  <button type="button" disabled={busy === w.key}
                          onClick={() => answer(w, false)}>No referral</button>
                  <button type="button" className="linkish" disabled={busy === w.key}
                          onClick={() => setAsking(null)}>skip</button>
                </span>
              )}

              {isDone && asking !== w.key && (
                <span className="compnote">
                  {undoable ? (
                    <>
                      Submitted.{" "}
                      <button type="button" className="linkish" disabled={busy === w.key}
                              onClick={() => undo(w)}>Undo</button>
                    </>
                  ) : (
                    <>Submitted{applied[w.key]?.submittedAt
                      ? ` ${String(applied[w.key].submittedAt).slice(0, 10)}`
                      : ""}. <a href="#inflight">In flight</a>.</>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {err && <p className="acterr">{err}</p>}
    </div>
  );
}
