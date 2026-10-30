/**
 * The one-line "why it's here" for each company, from companies.yaml.
 *
 * Read with a minimal parser rather than a YAML dependency — the same approach
 * lib/deadlines.js takes, and for the same reason: the app has no yaml package
 * and this block is a flat list of scalars by design.
 */
import fs from "node:fs";
import path from "node:path";

const YAML = path.join(process.cwd(), "..", "companies.yaml");

let _notes = null;

export function companyNotes() {
  if (_notes) return _notes;
  _notes = new Map();
  let raw;
  try { raw = fs.readFileSync(YAML, "utf8"); } catch { return _notes; }

  let slug = null;
  let collecting = false;
  let buf = [];
  const flush = () => {
    if (slug && buf.length) _notes.set(slug, buf.join(" ").replace(/\s+/g, " ").trim());
    buf = [];
    collecting = false;
  };

  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+slug:\s*(\S+)/);
    if (m) { flush(); slug = m[1]; continue; }
    if (/^\s*-\s+(name|firm):/.test(line)) { flush(); slug = null; continue; }

    const note = line.match(/^\s{4}note:\s*(.*)$/);
    if (note && slug) {
      const v = note[1].trim();
      if (v === ">" || v === "|") { collecting = true; buf = []; }
      else { buf = [v]; flush(); }
      continue;
    }
    if (collecting) {
      const cont = line.match(/^\s{6,}(\S.*)$/);
      if (cont) buf.push(cont[1].trim());
      else flush();
    }
  }
  flush();
  return _notes;
}
