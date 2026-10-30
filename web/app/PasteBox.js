"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Paste a search results page for one company.
 *
 * A PLAIN TEXTAREA AND A SUBMIT BUTTON. No drag-drop, no clipboard API, no
 * paste event handler -- so a browser agent can fill it the same way the owner
 * can, and so it works when the clipboard permission prompt does not.
 *
 * NOTHING BECOMES A CONTACT. The parsed rows land in suggested_contacts and
 * the owner taps promote on the ones worth having.
 */
export default function PasteBox({ company, slug }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/paste", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, company, company_slug: slug }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // THE NOTE IS SHOWN WHEN NOTHING PARSED. "0 added" on its own reads as a
      // quiet success; the server says why, and this repeats it.
      setMsg(d.note
        || `${d.stored} staged, ${d.duplicates} already known`
           + (d.parsed ? ` (${d.parsed} people found in the text)` : ""));
      if (d.stored) { setText(""); router.refresh(); }
    } catch (err) {
      setMsg(`Failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="pastebox" onSubmit={submit}>
      <label htmlFor={`paste-${slug}`} className="sub">
        Open the search above, select the results, and paste them here.
      </label>
      <textarea
        id={`paste-${slug}`}
        name="pasted"
        className="drafttext"
        rows={5}
        value={text}
        disabled={busy}
        placeholder="Paste the search results"
        onChange={(e) => setText(e.target.value)}
      />
      <p className="draftacts">
        <button type="submit" disabled={busy || !text.trim()}>
          {busy ? "Reading…" : "Add these people"}
        </button>
        {msg && <span className="note">{msg}</span>}
      </p>
    </form>
  );
}
