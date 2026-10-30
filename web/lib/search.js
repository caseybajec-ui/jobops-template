/**
 * The command palette's matching, as a pure function.
 *
 * Pure so the ranking is testable without a browser, and because "why did
 * typing 'sar' not surface Saronic" is a question you want to answer in a test
 * rather than by clicking.
 *
 * SUBSEQUENCE MATCHING, not substring. Typing "dstrat" should find "Deployment
 * Strategist" — the point of a palette is that you type what you remember, in
 * the order you remember it, and get there in four keystrokes. A substring
 * match would need "deployment str".
 */

export const KINDS = [
  ["page", "Page"],
  ["company", "Company"],
  ["role", "Role"],
  ["person", "Person"],
  ["task", "Task"],
];

/** The pages, which are always searchable because they are always there. */
export const PAGES = [
  ["/", "Daily"],
  ["/companies", "Companies"],
  ["/people", "People"],
  ["/inbox", "Inbox"],
  ["/forecast", "Forecast"],
  ["/resumes", "Resumes"],
  ["/profile", "Profile card"],
  ["/pulse", "Pulse"],
  ["/sf86", "SF-86 pack"],
  ["/gate", "What the rules filtered out"],
  ["/about", "How this works"],
  // A tour is a destination like any other here, which is what keeps the
  // palette from needing a second kind of row that does something instead of
  // going somewhere.
  ["/?tour=interface", "Take the tour"],
];

/**
 * Score one candidate against a query. Higher is better; 0 means no match.
 *
 * The ordering rules, in the order they matter:
 *   an exact prefix beats a word-start beats a scattered subsequence
 *   a shorter target beats a longer one, so "Saronic" beats "Saronic Mission
 *     Operations Engineer (Platform - UUV)" for the query "sar"
 *   a tighter span beats a looser one
 */
export function score(query, text) {
  const q = String(query || "").toLowerCase().trim();
  const t = String(text || "").toLowerCase();
  if (!q) return 0;
  if (!t) return 0;

  if (t.startsWith(q)) return 1000 - t.length;

  // Word-start: "mission ops" finding "Mission Operations Engineer".
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 800 - t.length;

  // Plain substring anywhere.
  const at = t.indexOf(q);
  if (at >= 0) return 600 - at - t.length / 10;

  // Subsequence: every character of the query, in order, anywhere.
  let i = 0;
  let first = -1;
  let last = -1;
  for (let k = 0; k < t.length && i < q.length; k++) {
    if (t[k] === q[i]) {
      if (first < 0) first = k;
      last = k;
      i += 1;
    }
  }
  if (i < q.length) return 0;
  const span = last - first;
  return Math.max(1, 400 - span - t.length / 10);
}

/**
 * Rank everything against a query.
 *
 * `items` are `{ kind, label, sub, href }`. Ties are broken by kind order and
 * then by label, so the list cannot reshuffle between keystrokes that produce
 * the same scores — a palette whose rows move under the cursor is one you stop
 * pressing Enter in.
 */
export function search(query, items = [], limit = 12) {
  const q = String(query || "").trim();
  if (!q) {
    // Empty query shows the pages, in their own order. A palette that opens
    // blank is one more thing to work out.
    return items.filter((i) => i.kind === "page").slice(0, limit);
  }
  const kindRank = Object.fromEntries(KINDS.map(([k], n) => [k, n]));
  return items
    .map((i) => ({ ...i, _s: Math.max(score(q, i.label), score(q, i.sub || "") * 0.6) }))
    .filter((i) => i._s > 0)
    .sort((a, b) => b._s - a._s
                 || (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9)
                 || String(a.label).localeCompare(String(b.label)))
    .slice(0, limit);
}
