"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Paste the apply log.
 *
 * A PLAIN TEXTAREA AND A SUBMIT BUTTON, the same shape as PasteBox.js and for
 * the same reasons: no drag-drop, no clipboard API, no paste event handler, so
 * a browser agent can fill it exactly the way the owner can and it works when the
 * clipboard permission prompt does not.
 *
 * IT IS A SEPARATE COMPONENT, not a generalisation of PasteBox.js. The two
 * boxes post to different routes, show different results and fail differently
 * -- this one has a red banner that echoes the paste back, which the contacts
 * box has no use for. Extracting a shared component would put the working one
 * at risk to save a form element.
 *
 * NOTHING GREEN ON NOTHING. A paste that yields no rows renders red, says so,
 * and shows the text back, because "0 added" on a green page is
 * indistinguishable from "there was nothing to add".
 */
export default function ApplyLogPaste() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch("/api/applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (!r.ok && !d.note) throw new Error(d.error || `HTTP ${r.status}`);
      setResult(d);
      if (d.ok) { setText(""); router.refresh(); }
    } catch (err) {
      setResult({ ok: false, note: `Failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }

  const failed = result && result.ok === false;

  return (
    <form className="pastebox" onSubmit={submit}>
      <label htmlFor="applylog" className="sub">
        Paste the apply log, or the 7pm digest. Re-pasting the same log is safe
        — it updates what is already there rather than adding it twice.
      </label>
      <textarea
        id="applylog"
        name="applylog"
        className="drafttext"
        rows={6}
        value={text}
        disabled={busy}
        placeholder={"2026-09-08 | linkedin | Anduril | Product Manager | Costa Mesa, CA | success\n"
          + "…or:\n- Anduril\n- Scale AI"}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="draftacts">
        <button type="submit" disabled={busy || !text.trim()}>
          {busy ? "Reading…" : "Import applications"}
        </button>
      </p>

      {failed && (
        <div className="importfail" role="alert" data-testid="import-failed">
          <p><strong>Nothing was imported.</strong> {result.note}</p>
          {result.echo && (
            <>
              <p className="sub">This is what was pasted:</p>
              <pre className="importecho">{result.echo}</pre>
            </>
          )}
        </div>
      )}

      {result && result.ok && (
        <p className="note" data-testid="import-ok">
          {result.stored} new, {result.updated} updated
          {result.format ? ` — read as the ${result.format} format` : ""}
          {result.unmatched?.length
            ? `. ${result.unmatched.length} employer(s) need matching below.`
            : "."}
        </p>
      )}

      {result && result.ok && result.warning && (
        // A header in the wrong order is how a whole wave once landed shifted
        // with the counts looking right. The counts above are not proof; this
        // is the one line that says so.
        <div className="importfail" role="alert" data-testid="import-warning">
          <p><strong>Check the rows that just landed.</strong> {result.warning}</p>
        </div>
      )}
    </form>
  );
}
