/**
 * Fails if any className used in the app has no rule in globals.css.
 *
 *   node test_classes.mjs
 *
 * This exists because it happened TWICE. Forecast was written against
 * .filters / .fc / .cbadge / .dl-* and rendered as unspaced running text for
 * weeks. That was fixed in isolation — and Gate was still using .fc, .fc-month
 * and .cbadge, so it stayed broken for another four sections of work while
 * sitting one click away in the footer.
 *
 * Nothing errors when a class is undefined. The build passes, the route returns
 * 200, the data is correct, and the page is simply unreadable. The only way to
 * catch it is to compare what the components ASK FOR against what the stylesheet
 * DEFINES.
 *
 * A class here is "defined" if globals.css mentions it as a selector anywhere,
 * including in a compound or media-query rule.
 */
import fs from "node:fs";
import path from "node:path";

const APP = "app";
const CSS = path.join("app", "globals.css");

// Utility classes that carry no styling of their own, and framework hooks.
const ALLOW = new Set(["open", "head", "full", "on", "urgent", "stale", "program",
                       "unknown", "top", "soon", "strong", "toggles", "foot",
                       "leaving", "donerow", "nextrow", "zero", "over"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const css = fs.readFileSync(CSS, "utf8");
const defined = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);

const used = new Map(); // class -> files
for (const file of walk(APP)) {
  const src = fs.readFileSync(file, "utf8");
  // className="a b c" and className={`a ${x} b`} and className={"a"}
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    // Drop ${...} interpolations; their static parts are captured either side.
    for (const c of raw.replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
      if (!c || !/^[a-zA-Z][\w-]*$/.test(c)) continue;
      if (!used.has(c)) used.set(c, new Set());
      used.get(c).add(file.replace(/\\/g, "/"));
    }
  }
}

const missing = [...used.entries()]
  .filter(([c]) => !defined.has(c) && !ALLOW.has(c))
  .sort();

console.log(`${used.size} distinct classes used, ${defined.size} defined in globals.css`);
if (!missing.length) {
  console.log("every class used has a rule");
  process.exit(0);
}
console.log(`\n${missing.length} CLASS${missing.length === 1 ? "" : "ES"} WITH NO RULE — the page renders unstyled and nothing errors:\n`);
for (const [c, files] of missing) {
  console.log(`  .${c}`);
  for (const f of files) console.log(`      ${f}`);
}
process.exit(1);
