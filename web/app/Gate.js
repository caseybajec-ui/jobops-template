"use client";

import { useState } from "react";

/**
 * What the deterministic gate deleted, and the phrase that decided each kill.
 *
 * This view exists because a kill count is not reviewable. The triage prompt
 * once scored a healthy-looking 20% survival rate while deleting Palantir's
 * Forward Deployed Software Engineer, New Grad posting — the rate said how much
 * got through and nothing at all about what. A gate is a regex making a delete
 * decision, so the only defence is being able to read what it matched.
 *
 * Phrases first, rows second. A bad pattern shows up in the phrase table as one
 * entry with a high count and a meaning the gate never intended.
 */
export default function Gate({ phrases, rows, counts, filters }) {
  const [q, setQ] = useState(filters.q || "");

  const push = (patch) => {
    const p = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "" || v === null) p.delete(k);
      else p.set(k, v);
    }
    window.location.search = p.toString();
  };

  const total = counts.reduce((a, c) => a + c.n, 0);
  const shown = phrases.filter(
    (p) => !filters.gate || p.gate_name === filters.gate
  );

  return (
    <>
      <div className="filters">
        <span className="dim">
          gate kills — every deletion with the phrase that caused it
        </span>
        <span className="spacer" />
        <label>
          gate
          <select
            defaultValue={filters.gate || ""}
            onChange={(e) => push({ gate: e.target.value })}
          >
            <option value="">all ({total})</option>
            {counts.map((c) => (
              <option key={c.gate} value={c.gate}>
                {c.gate} ({c.n})
              </option>
            ))}
          </select>
        </label>
        <label>
          field
          <select
            defaultValue={filters.field || ""}
            onChange={(e) => push({ field: e.target.value })}
          >
            <option value="">any</option>
            <option value="location">location</option>
            <option value="title">title</option>
            <option value="description">description</option>
          </select>
        </label>
        <label>
          search
          <input
            value={q}
            placeholder="phrase, title, company"
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => push({ q })}
            onKeyDown={(e) => e.key === "Enter" && push({ q })}
          />
        </label>
      </div>

      <div className="filters" style={{ position: "static" }}>
        <span className="faint">
          A kill on a <strong>description</strong> match deserves more suspicion than
          one on a <strong>location</strong> match: prose in a posting&apos;s opening
          paragraphs is company boilerplate, and &quot;offices in London and New
          York&quot; says nothing about where the role sits.
        </span>
      </div>

      <div className="prow head">
        <span>matched phrase</span>
        <span>n</span>
        <span>gate · field · example</span>
      </div>

      {shown.map((p) => (
        <div className="prow" key={`${p.gate_name}|${p.gate_field}|${p.phrase}`}>
          <span className="co mono">{p.phrase}</span>
          <span className="num">{p.n}</span>
          <span className="dim">
            {p.gate_name} ·{" "}
            <span className={`label${p.gate_field === "description" ? " soon" : ""}`}>
              {p.gate_field}
            </span>{" "}
            · {p.example}
          </span>
        </div>
      ))}

      <div className="filters" style={{ position: "static" }}>
        <span className="count mono">
          {rows.length} row{rows.length === 1 ? "" : "s"} below
        </span>
      </div>

      <div className="krow head">
        <span>company</span>
        <span>location</span>
        <span>title · matched phrase</span>
      </div>

      {rows.map((r) => (
        <div className="krow" key={r.key}>
          <span className="co">{r.display_name}</span>
          <span className="loc">{r.location || "—"}</span>
          <span className="dim">
            <a href={r.url} target="_blank" rel="noreferrer">
              {r.title}
            </a>{" "}
            · <span className="mono faint">{r.gate_name}</span>{" "}
            <span className="mono">{r.gate_text}</span>
          </span>
        </div>
      ))}

      {rows.length === 0 && (
        <div className="filters" style={{ position: "static" }}>
          <span className="faint">Nothing matches that filter.</span>
        </div>
      )}
    </>
  );
}
