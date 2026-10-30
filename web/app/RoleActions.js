"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAction, copyText } from "./useAction";
import { HIDE_REASONS, bandOf } from "@/lib/display";
import { needsReferralCheck } from "@/lib/people";
import { USER_CLASS_YEAR } from "@/lib/constants";

/**
 * Save, Hide, Applied — on every row a role appears in.
 *
 * The action is stored against the role's GROUP key, not a job key. Palantir
 * lists "Deployment Strategist, Build to Apply - US Government" in six cities
 * and re-ids the postings when they churn; saving it means saving the role.
 *
 * Visible on hover on desktop, always visible under 720px, where there is no
 * hover to discover them with.
 */
export default function RoleActions({ role, state, referrals = [] }) {
  const router = useRouter();
  const key = role.groupKey;
  // ONE question before applying to a tier-1 defense target or a top-band role
  // with no referral in motion. It never blocks — "Apply anyway" is a
  // first-class answer sitting on the left — and it cannot recur, because the
  // row reads as applied afterwards.
  //
  // Not a modal, and not on every application. An interruption that fires every
  // time is one you dismiss without reading, which is worth less than none.
  const [shield, setShield] = useState(false);
  const [pitch, setPitch] = useState(false);
  const [menu, setMenu] = useState(false);
  const shieldNeeded = needsReferralCheck({
    company: role.company,
    band: bandOf(role.score),
    referral: referrals.includes(role.company),
  });
  // Hiding asks WHY, from a fixed list. It is the only judgement the owner makes on
  // a role that the tool does not already hold, nothing else records it, and a
  // closed list can be counted later where free text cannot. Unhiding asks
  // nothing — taking something back is not a decision worth a form.
  const [asking, setAsking] = useState(false);
  // "Wrong cycle" is not one of the hide reasons, though it is reached from the
  // same panel. A hide is a preference about one list; this is a statement about
  // the world, it removes the role from EVERY surface, and it is undone from the
  // foot of Inbox rather than by pressing Unhide on a row they can no longer see.
  // It asks for a sentence because that sentence is the only record this system
  // will ever hold of why — a growth-equity firm's was "their analyst class
  // targets December graduates", which is not derivable from anything stored.
  const [cycle, setCycle] = useState(false);
  const [cycleNote, setCycleNote] = useState("");
  const [cycleBusy, setCycleBusy] = useState(false);
  const [cycleErr, setCycleErr] = useState(null);

  async function flagWrongCycle(scope) {
    setCycleBusy(true);
    setCycleErr(null);
    try {
      const r = await fetch("/api/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope, on: true, note: cycleNote.trim() || null,
          key: scope === "company" ? role.company : key,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || "could not save");
      setCycle(false);
      setCycleNote("");
      router.refresh();
    } catch (e) {
      // Shown, never swallowed. A flag that silently failed looks exactly like
      // one that worked and then came back tomorrow.
      setCycleErr(String(e.message || e));
    } finally {
      setCycleBusy(false);
    }
  }

  const save = useAction(state?.saved?.includes(key) || false);
  const hide = useAction(state?.hidden?.includes(key) || false);
  const applied = useAction(state?.applied?.includes(key) || false);

  const err = save.error || hide.error || applied.error;

  const go = async (a, kind, next, note = null) => {
    await a.toggle(key, kind, next, note);
    // Hiding and applying change which rows belong on the page at all.
    if (kind !== "save") router.refresh();
  };

  /**
   * Mark applied, and record HOW.
   *
   * Two writes, in this order and not the other: the action first, because that
   * is what every list in the app filters on, and the lifecycle event second.
   * If the event fails the role is still correctly marked applied — the reverse
   * would leave a lifecycle history for a role the inbox still shows as open.
   *
   * A failed event is not surfaced as an error on the button, because the
   * button's job succeeded. It is one missing row in a tally that already
   * refuses to draw a conclusion below three applications.
   */
  async function markApplied(referral) {
    setShield(false);
    await go(applied, "applied", true);
    try {
      await fetch("/api/lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, status: "applied", referral }),
      });
      router.refresh();
    } catch { /* the action landed; the tally can miss one */ }
  }

  return (
    <span className={`rowacts${menu ? " menuopen" : ""}`} onClick={(e) => e.stopPropagation()}>
      {/* On a phone the four verbs do not fit beside a role title, and hiding
          them behind hover is not an option because there is no hover. One tap
          target opens them. Shown only under 720px — on a desktop the buttons
          are already there and a menu would be an extra click for nothing. */}
      <button
        type="button"
        className="act more-tap"
        aria-expanded={menu}
        aria-label="More actions for this role"
        onClick={() => setMenu(!menu)}
      >
        ⋯
      </button>
      <span className="actbtns">
        {/* The scorer already wrote the one line that says why THIS role. It
            was readable only inside an expanded row, which is three taps away
            from the message it belongs in. */}
        {role.angle && (
          <button
            type="button"
            className={`act${pitch ? " on" : ""}`}
            title="Copy the one-line pitch for this role to the clipboard"
            onClick={async () => {
              setPitch(await copyText(role.angle));
              // Reverts on its own. A "Copied" that stays put is a state the
              // row is now in, rather than something that just happened.
              setTimeout(() => setPitch(false), 2000);
            }}
          >
            {pitch ? "Copied" : "Copy pitch"}
          </button>
        )}
      <button
        type="button"
        className={`act${save.on ? " on" : ""}`}
        aria-pressed={save.on}
        disabled={save.busy}
        title={save.on ? "Remove from your shortlist" : "Add to your shortlist"}
        onClick={() => go(save, "save", !save.on)}
      >
        {save.on ? "Saved" : "Save"}
      </button>

      <button
        type="button"
        className={`act${applied.on ? " on" : ""}`}
        aria-pressed={applied.on}
        disabled={applied.busy}
        title={applied.on
          ? "Marked applied"
          : "Marks it applied and puts a check-back on Daily in 7 days"}
        onClick={() => {
          // Marking applied always asks one question, because the answer is the
          // only evidence this tool will ever have about whether referrals
          // actually work for him. Un-marking asks nothing: taking something
          // back is not a decision worth a form.
          if (!applied.on) { setShield(true); return; }
          go(applied, "applied", false);
        }}
      >
        {applied.on ? "Applied" : "Mark applied"}
      </button>

      <button
        type="button"
        className={`act${hide.on ? " on" : ""}`}
        aria-pressed={hide.on}
        disabled={hide.busy}
        title={hide.on ? "Show this again" : "Hide it, and say why"}
        onClick={() => (hide.on ? go(hide, "hide", false) : setAsking(true))}
      >
        {hide.on ? "Unhide" : "Hide"}
      </button>

      </span>

      {asking && (
        <span className="hidewhy">
          <span className="dim">Why?</span>
          {HIDE_REASONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={hide.busy}
              onClick={async () => {
                setAsking(false);
                await go(hide, "hide", true, value);
              }}
            >
              {label}
            </button>
          ))}
          <button type="button" className="linkish" onClick={() => setAsking(false)}>
            cancel
          </button>
          {/* Reached from the reasons panel because that is where he already
              goes to say why, but kept visibly apart from the five: it does
              something different and larger. */}
          <button
            type="button"
            className="linkish cyclebtn"
            onClick={() => { setAsking(false); setCycle(true); }}
          >
            wrong cycle — hide everywhere
          </button>
        </span>
      )}

      {cycle && (
        <span className="hidewhy cyclewhy">
          <label>
            <span className="dim">
              Wrong cycle for {role.display_name || role.company}. Why? (optional)
            </span>
            <input
              type="text"
              value={cycleNote}
              maxLength={400}
              autoFocus
              placeholder={`e.g. their ${USER_CLASS_YEAR} class takes December ${USER_CLASS_YEAR} graduates`}
              onChange={(e) => setCycleNote(e.target.value)}
            />
          </label>
          <span className="shieldacts">
            <button type="button" disabled={cycleBusy} onClick={() => flagWrongCycle("role")}>
              This role
            </button>
            {/* The whole firm, for when the cycle is a fact about the employer
                rather than one requisition. It is the second button and not the
                first, because it is the bigger claim. */}
            <button type="button" disabled={cycleBusy} onClick={() => flagWrongCycle("company")}>
              Everything at {role.display_name || role.company}
            </button>
            <button type="button" className="linkish" onClick={() => setCycle(false)}>
              cancel
            </button>
          </span>
          {cycleErr && <span className="acterr" role="status">{cycleErr}</span>}
        </span>
      )}
      {/* ONE interruption carrying both facts.
       *
       * The shield sentence and the with-or-without question were separate
       * steps first, and two dialogs in a row for one button is how a person
       * learns to click through both without reading either. The sentence only
       * appears when there is genuinely no referral in motion at a company
       * where that matters; the question appears every time, because its answer
       * is the only evidence about referrals this tool will ever hold.
       *
       * Nothing here blocks. All three answers apply the role. */}
      {shield && !applied.on && (
        <span className="shield" role="status">
          {shieldNeeded && (
            <p>
              No referral in motion at{" "}
              <strong>{role.display_name || role.company}</strong>. Your own gap
              data says that is what gets past their screen.{" "}
              <a href={`/people?co=${encodeURIComponent(role.company)}&add=1`}>
                Find a person first
              </a>
              , or answer below and apply anyway.
            </p>
          )}
          <p className="shieldq">Did a referral get you in?</p>
          <span className="shieldacts">
            <button type="button" disabled={applied.busy} onClick={() => markApplied(true)}>
              With a referral
            </button>
            <button type="button" disabled={applied.busy} onClick={() => markApplied(false)}>
              Applied cold
            </button>
            {/* Skip stores NULL, not false. "He did not answer" and "he applied
                cold" are different facts, and folding one into the other would
                invent evidence against the thesis being tested. */}
            <button type="button" className="linkish" disabled={applied.busy}
                    onClick={() => markApplied(null)}>
              skip the question
            </button>
            <button type="button" className="linkish" onClick={() => setShield(false)}>
              cancel
            </button>
          </span>
        </span>
      )}
      {/* Its own line, always. Inside the button row it was clipped by the
          column width, so a failed save reverted SILENTLY — the exact thing
          this path exists to prevent. */}
      {err && <span className="acterr" role="status">{err}</span>}
    </span>
  );
}
