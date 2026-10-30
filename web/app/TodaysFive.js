"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { copyText } from "./useAction";
import { OWNER } from "@/lib/constants";
import { renderTemplate, TEMPLATE_BY_KEY, firstNameOf, linkedinNote,
         LINKEDIN_LIMIT } from "@/lib/people";

/**
 * Today's five people: who, why, and what to say.
 *
 * THE POINT OF THE WHOLE NETWORKING HALF. The owner opens JobOps and sees five
 * people rather than a table he has to work out what to do with. Everything
 * below the fold is reference; this is the thing to act on.
 *
 * NOTHING IS SENT. Copy puts the note on the clipboard; Mark sent records that
 * HE sent it. There is no send path on this page and there is not going to be
 * one -- the paste into LinkedIn is the approval, exactly as DraftMessage
 * already works.
 *
 * SKIP IS A PAUSE, NOT A REJECTION. The row comes back in 30 days, because a
 * person who is wrong for today may be exactly right when their company opens
 * the role the owner wants.
 */
export default function TodaysFive({ people = [], overrides = {} }) {
  const router = useRouter();
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(null);

  if (!people.length) {
    // AN EMPTY QUEUE IS A REAL STATE AND IT SAYS WHICH ONE. "Nothing today"
    // and "no source has ever run" read identically otherwise, and that
    // confusion has bitten three separate surfaces in this project.
    return (
      <div className="section">
        <h2>Today&apos;s five</h2>
        <p className="nothing">
          Nobody staged yet. Paste a {OWNER.schoolShort} alumni search on{" "}
          <a href="/outreach">Outreach</a>, or import your connections. The
          local reader fills this too once it has run.
        </p>
      </div>
    );
  }

  async function act(id, action) {
    setBusy(id + action);
    setErr(null);
    try {
      const r = await fetch("/api/suggested/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      router.refresh();
    } catch (e) {
      setErr(`${action} failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="section">
      <h2>
        Today&apos;s five
        <span className="h2note"> · best first, and why</span>
      </h2>

      {people.map((p) => {
        const note = linkedinNote({
          first_name: firstNameOf(p.name),
          company: p.company_label || p.company,
          role_title: p.role_title || "the role",
          shared_hook: "",
        });
        return (
          <div key={p.id} className="person">
            <div className="phead">
              <span className="pname">{p.name}</span>
              <span className="pmeta">
                {p.title || "role not stated"} · {p.company_label || p.company}
              </span>
              <span className="pwhen">{p.rank_reason}</span>
              <span className="pacts">
                {p.profile_url && (
                  <a className="act" href={p.profile_url} target="_blank"
                     rel="noreferrer noopener">Profile</a>
                )}
                <button type="button" className="act" disabled={busy}
                  onClick={async () => {
                    await copyText(note.text);
                    setCopied(p.id);
                  }}>
                  {copied === p.id ? "Copied" : "Copy"}
                </button>
                <button type="button" className="act" disabled={busy}
                  onClick={() => act(p.id, "sent")}>
                  {busy === p.id + "sent" ? "…" : "Mark sent"}
                </button>
                <button type="button" className="act" disabled={busy}
                  onClick={() => act(p.id, "skip")}>
                  Skip
                </button>
              </span>
            </div>
            <p className="sub">
              {note.text}
              <span className="note">
                {" "}{note.text.length} / {LINKEDIN_LIMIT} characters
                {note.shortened ? ", title shortened to fit" : ""}
              </span>
            </p>
          </div>
        );
      })}

      {err && <p className="alert">{err}</p>}
      <p className="note">
        Copy puts the note on the clipboard. Mark sent records that YOU sent
        it, and starts the follow-up clock. Skip puts the person back for 30
        days rather than dropping them.
      </p>
    </div>
  );
}
