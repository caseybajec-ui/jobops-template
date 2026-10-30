/**
 * What the Ask box is allowed to see: a deterministic, token-capped summary of
 * the search, assembled from rows the caller has already read.
 *
 * NEVER THE WHOLE CORPUS. There are ~9,800 open postings; sending them would
 * cost more per question than the entire monthly cap and would bury the answer.
 * This sends a fixed shape, ordered by what a question is most likely to be
 * about, and stops at a hard ceiling.
 *
 * PURE. Rows in, string out — no queries here. That is what makes it testable
 * and what keeps the read surface visible in one place: whatever the caller
 * passes is exactly what the model sees, and the route returns this text to the
 * page so it can be read.
 *
 * TRIMMED BY PRIORITY, NOT BY TRUNCATION. Sections are added whole, in order,
 * until the budget is spent; a section that will not fit is dropped and SAID to
 * be dropped. Cutting a table in half mid-row would hand the model a fragment
 * that reads like a complete list, which is how you get a confident answer about
 * three companies when there were forty.
 */

// Who the owner is, baked from profile.json and config.yaml. The one sentence
// below that names a person and a start season reads them from here, so the
// box cannot be answering questions about someone else's search.
import { OWNER, CLASS_YEAR, PREFS } from "./config.generated.js";

/**
 * Token estimate. Deliberately crude and deliberately HIGH.
 *
 * ~3.6 characters per token is conservative for English prose; the real count
 * is usually lower. This decides how much to send, so erring high spends less
 * money than erring low, and the alternative — a count_tokens API call before
 * every question — costs a network round trip to save nothing.
 */
export function estimateTokens(s) {
  return Math.ceil(String(s || "").length / 3.6);
}

/** The ceiling. ~8K in, ~700 out is about 1.2c a question at Haiku rates. */
export const CTX_BUDGET_TOKENS = 8000;

const fmt = (v, dash = "—") => (v === null || v === undefined || v === "" ? dash : String(v));

/**
 * Build the context.
 *
 * `state` carries plain rows, all of which the Pulse page already has or can
 * read cheaply. Ordered by what gets asked about: the windows that close, then
 * what is on the owner, then who they know, then what is in flight, then the roles.
 * Roles go LAST because there are the most of them and they are the least
 * likely to be the subject of a question about the search as a whole — so they
 * are what gets dropped first when the budget runs out.
 */
export function buildContext(state = {}) {
  const {
    today = null, graduation = null,
    windows = [], items = [], contacts = [], applications = [],
    sf86 = null, roles = [], counts = {},
  } = state;

  const sections = [];

  sections.push(["Today", [
    `Today is ${fmt(today)}.`,
    graduation ? `${OWNER.name} graduates ${graduation} and is recruiting for full-time roles starting ${PREFS.canStartSeason || "summer"} ${CLASS_YEAR}.` : null,
    counts.openRoles != null ? `${counts.openRoles} open postings are tracked; ${fmt(counts.reachable)} are ones they could actually take.` : null,
  ].filter(Boolean).join("\n")]);

  if (windows.length) {
    sections.push(["Application windows", [
      "firm | programme | closes | days left | confidence | status",
      ...windows.map((w) => [
        w.firm, w.program, fmt(w.closes, "no date"),
        w.closeIn === null || w.closeIn === undefined ? "—" : `${w.closeIn}d`,
        fmt(w.confidence), fmt(w.status),
      ].join(" | ")),
      "",
      "Only a window marked `verified` has been read off the firm's own site.",
    ].join("\n")]);
  }

  if (items.length) {
    sections.push(["Things on him", items.map((i) => {
      const due = i.dueIn === null || i.dueIn === undefined
        ? "no date"
        : i.dueIn < 0 ? `${Math.abs(i.dueIn)}d overdue` : `due in ${i.dueIn}d`;
      return `- ${i.title} (${due}${i.done ? ", done" : ""})`;
    }).join("\n")]);
  }

  if (contacts.length) {
    sections.push(["People they know", [
      "name | company | status | last thing that happened",
      ...contacts.map((c) => [
        fmt(c.name), fmt(c.company), fmt(c.status), fmt(c.last, "nothing yet"),
      ].join(" | ")),
    ].join("\n")]);
  }

  if (applications.length) {
    sections.push(["Applications in flight", [
      "company | role | stage | days in stage",
      ...applications.map((a) => [
        fmt(a.company), fmt(a.title), fmt(a.status), fmt(a.days),
      ].join(" | ")),
    ].join("\n")]);
  }

  if (sf86) {
    sections.push(["SF-86 evidence pack", [
      `Overall ${sf86.pct}% assembled.`,
      ...Object.entries(sf86.per || {}).map(([k, v]) => `- ${k}: ${v.pct}% (${v.rows} entries)`),
    ].join("\n")]);
  }

  if (roles.length) {
    sections.push(["Roles that fit, best first", [
      "company | role | fit | location | pay | starts",
      ...roles.map((r) => [
        fmt(r.company), fmt(r.title), fmt(r.band), fmt(r.location),
        fmt(r.pay, "not published"), fmt(r.start, "not stated"),
      ].join(" | ")),
    ].join("\n")]);
  }

  // Spend the budget in order; drop whole sections and say which.
  const out = [];
  const dropped = [];
  let used = 0;
  for (const [name, body] of sections) {
    const block = `## ${name}\n${body}`;
    const cost = estimateTokens(block);
    if (used + cost > CTX_BUDGET_TOKENS) { dropped.push(name); continue; }
    out.push(block);
    used += cost;
  }
  if (dropped.length) {
    // SAID, not silent. A model given a truncated context and no note about it
    // will answer as though it had the whole thing.
    out.push(`## Not included\n${dropped.join(", ")} — too long for this question's budget.`);
  }

  const text = out.join("\n\n");
  return {
    text,
    tokens: estimateTokens(text),
    sections: out.length,
    dropped,
    budget: CTX_BUDGET_TOKENS,
  };
}
