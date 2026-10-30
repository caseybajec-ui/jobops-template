"use client";

import { useEffect, useState } from "react";

/**
 * "Ask about this data" — one question, one answer, no memory.
 *
 * ON PULSE, NOT DAILY. Daily is for doing; this is for asking, and a box that
 * invites a question at the top of the page whose job is to name one task would
 * compete with it every morning.
 *
 * IT SHOWS THE COST AND THE COUNTER BEFORE YOU ASK. A capped feature where you
 * cannot see the cap is a feature you either avoid or overrun; the point of
 * thirty a month is being able to watch it work.
 *
 * IT SHOWS WHAT IT READ. The context the answer came from is one click away,
 * because an answer whose inputs you cannot check is one you either trust
 * blindly or stop using — the same argument as the fit band's "why".
 *
 * DISABLED, AND SAYS WHICH VARIABLE, when the key is unset. It never falls back
 * to another key; see lib/ask.js.
 */
export default function Ask() {
  const [status, setStatus] = useState(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [showCtx, setShowCtx] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/ask")
      .then((r) => r.json())
      .then((s) => { if (alive) setStatus(s); })
      .catch(() => { if (alive) setStatus({ ready: false, reason: "Could not reach the app." }); });
    return () => { alive = false; };
  }, []);

  async function submit(e) {
    e?.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error || `Something went wrong (${r.status}).`);
        if (j.atCap) setStatus((s) => ({ ...s, atCap: true, used: j.used ?? s?.used }));
      } else {
        setRes(j);
        setStatus((s) => ({ ...s, used: j.used, left: j.left, atCap: j.left <= 0 }));
      }
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  if (!status.ready) {
    return (
      <section className="section ask">
        <h2>Ask about this data</h2>
        <p className="nothing">
          {status.reason}
        </p>
      </section>
    );
  }

  const left = status.left ?? 0;

  return (
    <section className="section ask">
      <h2>
        Ask about this data
        <span className="h2note"> — {left} of {status.cap} questions left this month</span>
      </h2>
      <p className="sub">
        Read-only. It can answer questions about what is in the tool; it cannot
        change anything, apply to anything, or send anything. Single question,
        no memory of the last one.
      </p>

      <form className="askform" onSubmit={submit}>
        <input
          type="text"
          value={q}
          maxLength={400}
          disabled={busy || status.atCap}
          aria-label="Your question"
          placeholder="Which companies have I not contacted anyone at?"
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="railbtn"
                disabled={busy || status.atCap || !q.trim()}>
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>

      {status.atCap && (
        <p className="nothing">
          {status.cap} of {status.cap} used this month. The cap resets on the 1st.
        </p>
      )}

      {err && <p className="acterr askerr">{err}</p>}

      {res && (
        <div className="askanswer">
          <p className="askbody">{res.answer}</p>
          <p className="askmeta">
            {/* Four decimal places, because at a cent a question two would
                round most of them to $0.01 and one to nothing at all. */}
            ${res.cost.toFixed(4)} · {res.used} of {res.cap} used ·{" "}
            {res.context.tokens} tokens of context
            {res.context.dropped?.length
              ? ` · ${res.context.dropped.join(", ")} did not fit`
              : ""}
            {" · "}
            <button type="button" className="linkish"
                    onClick={() => setShowCtx(!showCtx)}>
              {showCtx ? "hide what it read" : "what it read"}
            </button>
          </p>
          {showCtx && <pre className="askctx">{res.context.text}</pre>}
        </div>
      )}
    </section>
  );
}
