"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { search, PAGES } from "@/lib/search";
import { shortcutFor, SHORTCUTS } from "@/lib/keys";

/**
 * ⌘K, and the shortcut overlay behind "?".
 *
 * Named Palette2 because app/Palette.js already exists and is about COLOUR —
 * the category dots and the progress meter. Two unrelated things called Palette
 * in one directory is a mistake waiting for whoever opens the wrong one, and
 * renaming the colour module would touch a dozen imports for no benefit.
 *
 * The pages are always available with no fetch at all, because they are a
 * constant. Everything else arrives from /api/search on the first keystroke and
 * is cached for the life of the palette — a fetch per keystroke would put a
 * network round trip between typing "sa" and "sar".
 */
export default function Palette2() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [i, setI] = useState(0);
  const [loading, setLoading] = useState(false);
  const box = useRef(null);
  const loaded = useRef(false);

  const pages = PAGES.map(([href, label]) => ({ kind: "page", label, href }));
  const [items, setItems] = useState(pages);

  const load = useCallback(async () => {
    if (loaded.current) return;
    loaded.current = true;
    setLoading(true);
    try {
      const r = await fetch("/api/search");
      const b = await r.json();
      setItems([...pages, ...(b.items || [])]);
    } catch {
      // The pages still work. A palette that opens with nothing in it because
      // one fetch failed is worse than one that offers less.
    } finally {
      setLoading(false);
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setRows(search(q, items)); setI(0); }, [q, items]);

  useEffect(() => {
    const onKey = (e) => {
      const s = shortcutFor(e);
      if (s === "palette") {
        e.preventDefault();
        setOpen((v) => !v);
        setHelp(false);
        load();
        return;
      }
      if (s === "help" && !open) { e.preventDefault(); setHelp((v) => !v); return; }
      if (s === "escape") { setOpen(false); setHelp(false); return; }
      if (!open) return;
      // Inside the palette, j/k are TEXT. Only the arrows and Enter navigate,
      // because the input has focus and typing "j" must type a j.
      if (e.key === "ArrowDown") { e.preventDefault(); setI((n) => Math.min(n + 1, rows.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setI((n) => Math.max(n - 1, 0)); }
      if (e.key === "Enter" && rows[i]) {
        e.preventDefault();
        setOpen(false);
        router.push(rows[i].href);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, rows, i, router, load]);

  useEffect(() => {
    if (open && box.current) box.current.focus();
  }, [open]);

  if (help) {
    return (
      <div className="overlay" role="dialog" aria-label="Keyboard shortcuts"
           onClick={() => setHelp(false)}>
        <div className="overlaycard" onClick={(e) => e.stopPropagation()}>
          <h2>Keyboard</h2>
          <table className="keys">
            <tbody>
              {SHORTCUTS.map(([, label, where, does], n) => (
                <tr key={n}>
                  <td className="mono">{label}</td>
                  <td className="dim">{where}</td>
                  <td>{does}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim">
            None of these fire while you are typing in a box. Escape closes
            this.
          </p>
        </div>
      </div>
    );
  }

  if (!open) return null;

  return (
    <div className="overlay" role="dialog" aria-label="Search" onClick={() => setOpen(false)}>
      <div className="overlaycard palettecard" onClick={(e) => e.stopPropagation()}>
        <input
          ref={box}
          className="paletteq"
          type="text"
          value={q}
          placeholder="Roles, companies, people, tasks, pages…"
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search"
        />

        <ul className="paletterows">
          {rows.map((r, n) => (
            <li key={`${r.kind}:${r.href}:${r.label}`}
                className={n === i ? "on" : ""}
                onMouseEnter={() => setI(n)}>
              <a href={r.href} onClick={() => setOpen(false)}>
                <span className="pkind">{r.kind}</span>
                <span className="plabel">{r.label}</span>
                {r.sub && <span className="dim">{r.sub}</span>}
              </a>
            </li>
          ))}
          {/* MUTUALLY EXCLUSIVE. A fast typist reaches the box before the
              fetch lands, and "Nothing matches" is a wrong answer that arrives
              confidently and then changes its mind. While the rest is still
              coming, say so. */}
          {q && rows.length === 0 && (
            <li className="dim">
              {loading ? "Still loading roles, people and tasks…"
                       : `Nothing matches “${q}”.`}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
