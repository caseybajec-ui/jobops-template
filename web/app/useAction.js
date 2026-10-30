"use client";

import { useState } from "react";

/**
 * Optimistic writes with a REAL rollback.
 *
 * The screen updates immediately, and if the POST fails the change is undone in
 * front of you and the row says so. It never leaves a tick sitting there next to
 * something that was not saved — a UI that lies about having stored something is
 * worse than one that is slow.
 *
 * No alert(). The message goes inline, next to the thing that failed.
 */
export function useAction(initial = false) {
  const [on, setOn] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function toggle(key, kind, next = !on, note = null) {
    const previous = on;
    setOn(next);              // optimistic
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, kind, on: next, note }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      // Reconcile against what the server actually recorded.
      if (typeof body.on === "boolean") setOn(body.on);
    } catch {
      setOn(previous);        // rollback, visibly
      setError("Couldn't save — try again");
    } finally {
      setBusy(false);
    }
  }

  return { on, error, busy, toggle, setOn };
}

/**
 * Put text on the clipboard, or say so honestly.
 *
 * `navigator.clipboard` is UNDEFINED outside a secure context, and "secure"
 * means https or localhost — not `http://192.168.1.x:3311`, which is exactly
 * how this app gets opened from a phone on the same wifi. So the modern API
 * alone would make "Copy message" fail every single time in the one situation
 * it is most likely to be used: standing up, phone in hand, about to paste
 * something into LinkedIn.
 *
 * The fallback is the old execCommand route through an off-screen textarea. It
 * is deprecated and it works everywhere, which is the right trade for a
 * function whose failure mode is a feature that cannot be used at all.
 *
 * Returns true only if the text actually got there. The caller logs the message
 * as sent ONLY on true — recording a message as sent when it never reached the
 * clipboard would put a real person into the follow-up cadence for something
 * they were never sent.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the old way */ }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen rather than hidden: display:none and visibility:hidden both
    // make the selection fail silently, which is the worst of both.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const okay = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!okay;
  } catch {
    return false;
  }
}

/** Same contract for the items endpoint. */
export async function postItem(payload) {
  const res = await fetch("/api/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg = "Couldn't save — try again";
    try {
      const b = await res.json();
      if (b?.error) msg = b.error;
    } catch { /* keep the generic message */ }
    throw new Error(msg);
  }
  return res.json();
}
