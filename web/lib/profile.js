/**
 * profile.json, read for display only.
 *
 * The scorer returns evidence IDs — "briefd_batch", "webs_creek" — which are
 * fine in a JSON blob and meaningless on screen. This turns them into the thing
 * they refer to, so "Lead with" reads like an instruction rather than a lookup
 * key you have to go and resolve yourself.
 *
 * Nothing here writes, and nothing here invents: the label is the opening clause
 * of the evidence text, verbatim.
 */
import fs from "node:fs";
import path from "node:path";

const PROFILE = path.join(process.cwd(), "..", "profile.json");

let _labels = null;

function shorten(text) {
  const t = (text || "").trim();
  // The opening clause carries the identity: "Founded <product>, an AI-powered
  // daily briefing SaaS; solo, no outside capital; 25 paying subscribers..."
  const cut = t.search(/[;(]|\s—\s/);
  let out = cut > 24 ? t.slice(0, cut) : t;
  if (out.length > 82) {
    const comma = out.lastIndexOf(",", 82);
    out = out.slice(0, comma > 40 ? comma : 82).trim() + "…";
  }
  return out.replace(/[.,;\s]+$/, "");
}

export function evidenceLabels() {
  if (_labels) return _labels;
  _labels = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(PROFILE, "utf8"));
    for (const e of raw.evidence || []) {
      if (e.id) _labels.set(e.id, shorten(e.text));
    }
  } catch {
    // A missing profile is not a reason to break a page; the IDs still render.
  }
  return _labels;
}

/** Labels for a list of ids, falling back to the id when it is unknown. */
export function labelEvidence(ids = []) {
  const map = evidenceLabels();
  return (ids || []).map((id) => map.get(id) || id);
}
