"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { windowKey, STALE_DAYS } from "@/lib/display";
import { inDays } from "@/lib/plural";
import { USER_CLASS_YEAR } from "@/lib/constants";

/**
 * Sixteen windows, one at a time.
 *
 * The list below this is sixteen identical rows, each with a date input and a
 * button. As an OVERVIEW that is right — you can see the whole risk at once —
 * and as a thing to actually do it is the worst possible shape: every row asks
 * the same question, none of them is the next one, and the eye has nowhere to
 * land. So the list stays and the WORK moves here.
 *
 * A MODAL, which this codebase otherwise avoids on purpose — the hide-reason
 * control is deliberately inline because "a dialog would cost three clicks for
 * a one-click answer". The difference is that this is not one answer, it is
 * sixteen in a row, and the whole value is having nothing else on screen. It is
 * opt-in, it closes on Escape, and it never opens by itself.
 *
 * SKIP RECORDS NOTHING. That is the load-bearing detail. "Checked — still none"
 * writes a check, which is a fact about the looking and moves the window to the
 * back of the queue; "Skip for now" writes nothing at all, because the owner did
 * not look and a tool that recorded it as though he had would be turning an
 * absence of evidence into evidence of absence — the exact failure the McKinsey
 * miss cost a cycle for.
 */
export default function ConfirmFocus({ windows = [], total = 0, nextDueIn = null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [closes, setCloses] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [answered, setAnswered] = useState(0);

  const current = windows[i] || null;
  const done = i >= windows.length;

  const next = useCallback(() => {
    setCloses("");
    setPicking(false);
    setErr(null);
    setI((n) => n + 1);
  }, []);

  const record = useCallback(async (date) => {
    if (!current) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/windows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: windowKey(current), closes: date || null }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || "Couldn't save — try again");
      }
      setAnswered((n) => n + 1);
      next();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, [current, next]);

  // 1 / 2 / 3 for the three answers, Enter to confirm a picked date, Escape to
  // leave. Keyboard because this is a run of sixteen and reaching for the mouse
  // between each one is most of the cost.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") { setOpen(false); return; }
      // Never hijack a key while the date field has it.
      const typing = document.activeElement?.tagName === "INPUT";
      if (e.key === "Enter" && picking && closes) { record(closes); return; }
      if (typing) return;
      if (e.key === "1") { setPicking(true); }
      else if (e.key === "2") { record(null); }
      else if (e.key === "3") { next(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, picking, closes, record, next]);

  // Refresh once, on the way out, rather than after every answer: a refresh
  // per window would re-render the list underneath and re-order the queue
  // mid-session, moving the card onto a window that was three answers away.
  function close() {
    setOpen(false);
    if (answered > 0) router.refresh();
  }

  // NOTHING DUE A CHECK IS A STATE, NOT AN ABSENCE.
  //
  // This returned null, so the section rendered sixteen inline date inputs with
  // no way into the one-at-a-time flow and nothing saying why — and Daily's
  // "Confirm one now" button landed here and appeared to do nothing. All
  // sixteen had been looked at inside the fourteen-day cooldown, which is the
  // queue working exactly as designed; a design working correctly must not look
  // like a broken page.
  if (!windows.length) {
    return (
      <p className="focusopen focusquiet">
        {total > 0 ? (
          <>
            <strong>Nothing is due a check.</strong>{" "}
            All {total} of these were looked at inside the last {STALE_DAYS} days.
            {nextDueIn !== null && nextDueIn > 0
              ? ` The next comes back round ${inDays(nextDueIn)}.`
              : ""}{" "}
            The list below is still the whole picture, and you can answer any row
            in it by hand.
          </>
        ) : (
          <>Every tracked window has a date. Nothing to confirm.</>
        )}
      </p>
    );
  }

  if (!open) {
    return (
      <p className="focusopen">
        <button type="button" className="focusbtn" onClick={() => { setI(0); setAnswered(0); setOpen(true); }}>
          Confirm dates — about {Math.round(windows.length * 10 / 6) * 6 >= 60
            ? `${Math.round(windows.length * 10 / 60)} hours`
            : `${windows.length * 10} minutes`} for all {windows.length}
        </button>
        <span className="dim">
          {" "}One at a time, ten minutes each. Stop whenever — every answer is
          saved as you go.
        </span>
      </p>
    );
  }

  return (
    <div className="focus" role="dialog" aria-modal="true" aria-label="Confirm application dates">
      <div className="focuscard">
        <p className="focusprog">
          {done ? `${answered} answered` : `${i + 1} of ${windows.length}`}
          <button type="button" className="linkish focusclose" onClick={close}>
            close
          </button>
        </p>

        {done ? (
          // A REAL done state. Not "0 remaining" in the same layout — the queue
          // being empty is the outcome this whole feature exists for, and it
          // should look different from being partway through one.
          <>
            <h2 className="focusfirm">That is the queue.</h2>
            <p className="focusprogram">
              {answered === 0
                ? "You skipped all of them. They will be waiting tomorrow."
                : `${answered} window${answered === 1 ? "" : "s"} answered. The ones you dated are marked verified — read from the firm's own site, which is the only way anything here earns that word.`}
            </p>
            <p className="focusacts">
              <button type="button" onClick={close}>Back to Forecast</button>
            </p>
          </>
        ) : (
          <>
            <h2 className="focusfirm">{current.firm}</h2>
            <p className="focusprogram">{current.program}</p>
            <p className="focuswhen">
              {current.verifiedAgo === null
                ? "Never checked"
                : current.verifiedAgo === 0
                  ? "Checked today"
                  : `Last checked ${current.verifiedAgo} days ago`}
              {current.verifiedAgo !== null && current.verifiedAgo < STALE_DAYS
                && current.verifiedAgo > 0 ? " — not due yet" : ""}
            </p>

            {/* The careers page, opened for you. When companies.yaml has no
                source URL this is a pre-filled search rather than nothing:
                a dead end here is a window that stays undated forever. */}
            <p className="focusgo">
              <a
                className="focusbtn"
                href={current.source || `https://duckduckgo.com/?q=${encodeURIComponent(
                  `${current.firm} ${current.program} application deadline ${USER_CLASS_YEAR}`)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open {current.source ? "their careers page" : "a search for it"} ↗
              </a>
            </p>

            <p className="focusacts">
              {picking ? (
                <>
                  <input
                    type="date"
                    autoFocus
                    value={closes}
                    disabled={busy}
                    aria-label={`Close date for ${current.firm}`}
                    onChange={(e) => setCloses(e.target.value)}
                  />
                  <button type="button" disabled={busy || !closes}
                          onClick={() => record(closes)}>
                    Save the date
                  </button>
                  <button type="button" className="linkish" onClick={() => setPicking(false)}>
                    back
                  </button>
                </>
              ) : (
                <>
                  <button type="button" disabled={busy} onClick={() => setPicking(true)}>
                    <span className="kbd">1</span> Found a date
                  </button>
                  <button type="button" disabled={busy} onClick={() => record(null)}>
                    <span className="kbd">2</span> Checked — still none
                  </button>
                  {/* Records NOTHING. He did not look, and saying he did would
                      make "no date" look like a finding. */}
                  <button type="button" className="linkish" disabled={busy} onClick={next}>
                    <span className="kbd">3</span> Skip for now
                  </button>
                </>
              )}
              {err && <span className="acterr">{err}</span>}
            </p>

            <p className="focusnote">
              A date typed here marks the window <strong>verified</strong> — read
              from the firm&apos;s own site by you, which is the only way anything
              in this tool earns that word. &ldquo;Still none&rdquo; records that
              you looked and nothing else. Skipping records nothing at all.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
