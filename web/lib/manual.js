/**
 * daily.yaml — the pipeline's blind spots, which are currently the highest-value
 * work in the search. Rendered at the TOP of the daily view: consulting
 * applications, the SF-86 pack, and alumni outreach matter more right now than
 * anything the fetcher can see, and the screen should say so rather than
 * quietly omitting them.
 */
import fs from "node:fs";
import path from "node:path";
import { daysUntil } from "./day.js";

const YAML = path.join(process.cwd(), "..", "daily.yaml");

export function manualItems() {
  let raw;
  try { raw = fs.readFileSync(YAML, "utf8"); } catch { return []; }
  const items = [];
  let cur = null;
  let key = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const start = line.match(/^\s*-\s+(\w+):\s*(.*)$/);
    const pair = line.match(/^\s{4}(\w+):\s*(.*)$/);
    const cont = line.match(/^\s{6,}(\S.*)$/);
    if (start) {
      if (cur) items.push(cur);
      cur = {};
      key = start[1];
      cur[key] = clean(start[2]);
    } else if (pair && cur) {
      key = pair[1];
      cur[key] = clean(pair[2]);
    } else if (cont && cur && key) {
      cur[key] = ((cur[key] ? cur[key] + " " : "") + cont[1].trim()).trim();
    }
  }
  if (cur) items.push(cur);
  return items
    .filter((i) => i.text && String(i.done) !== "true")
    .map((i) => ({
      ...i,
      // Calendar days, from day.js. These render on Daily beside the window
      // countdowns and the `items` ones, and all three have to agree.
      dueIn: daysUntil(i.due),
    }))
    .sort((a, b) => (a.dueIn ?? 9999) - (b.dueIn ?? 9999)
                 || String(a.text || "").localeCompare(String(b.text || "")));
}

function clean(v) {
  const s = (v || "").trim();
  if (s === ">" || s === "|" || s === "") return "";
  return s.replace(/^["']|["']$/g, "");
}
