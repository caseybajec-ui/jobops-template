"use client";

/* The only page a signed-out visitor can reach.
 *
 * Deliberately plain: one field, one button, and the same paper, type and rules
 * as the rest of the app. No new colours, fonts or radii — --alert carries the
 * error because that is what --alert is for, and nothing else on the page
 * competes with it.
 */
import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const { error } = await r.json().catch(() => ({}));
        setErr(error || "Wrong password");
        setBusy(false);
        return;
      }
      // replace(), not push(): the login page should not sit in history behind
      // the app, where Back would land on it while already signed in.
      router.replace(params.get("next") || "/");
      router.refresh();
    } catch {
      setErr("Could not reach the server");
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <p className="page-intro">
        JobOps is private. Enter the password to continue.
      </p>
      <form className="actions" onSubmit={submit}>
        <input
          className="note-input"
          type="password"
          value={password}
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
      {err ? <p className="acterr">{err}</p> : null}
      <p className="faint login-note">
        Signed-in sessions last 30 days on this browser.
      </p>
    </div>
  );
}
