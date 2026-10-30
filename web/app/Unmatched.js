"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Resolve an employer the matcher would not guess at.
 *
 * A SELECT OF KNOWN COMPANIES, never a free-text field and never a
 * suggestion. matchEmployer() refuses anything fuzzier than an exact or
 * clean-suffix name match, so everything here is a case a person has to
 * decide: "Andurl" is a typo, "Anduril Defense Systems" might be a different
 * entity, and an edit-distance rule would resolve both the same way and be
 * wrong about one of them.
 *
 * The application is ALREADY RECORDED. This only attaches a company to it, so
 * leaving one unresolved loses nothing except the ability to count it against
 * that company.
 */
export default function Unmatched({ names = [], known = [] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState({});

  async function resolve(raw, slug) {
    if (!slug) return;
    setBusy(raw);
    try {
      const r = await fetch("/api/applications", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ employer_raw: raw, employer_id: slug }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setMsg((m) => ({ ...m, [raw]: "matched" }));
      router.refresh();
    } catch (err) {
      setMsg((m) => ({ ...m, [raw]: `Failed: ${err.message}` }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="unmatched" data-testid="unmatched">
      {names.map((raw) => (
        <li key={raw}>
          <span className="who">{raw}</span>
          <select
            aria-label={`Company for ${raw}`}
            defaultValue=""
            disabled={busy === raw}
            onChange={(e) => resolve(raw, e.target.value)}
          >
            <option value="">Leave unmatched</option>
            {known.map((c) => (
              <option key={c.slug} value={c.slug}>{c.display_name}</option>
            ))}
          </select>
          {msg[raw] && <span className="note"> {msg[raw]}</span>}
        </li>
      ))}
    </ul>
  );
}
