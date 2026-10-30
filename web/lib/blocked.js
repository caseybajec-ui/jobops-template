/**
 * APPLY FLOWS THAT ARE BROKEN. The rules, pure.
 *
 * No database, no `node:` imports, no I/O — the same rule display.js and
 * today.js follow, so this can be imported by a client component, a build
 * script and a test alike.
 *
 * WHAT THIS IS FOR. The tool's whole output is "apply to this". Nothing in it
 * could record that applying is impossible: the hCaptcha on Palantir's Lever
 * flow loops forever, Deloitte's site has answered 406 since 8 September. The
 * role stays open, the score stays high, the window keeps counting down, and
 * every surface goes on recommending them — which is worse than not finding
 * them, because the owner spends the slot.
 *
 * IT IS NOT A CLASSIFIER AND NOTHING HERE READS A POSTING. Every row is
 * something the owner (or the apply bot's log) observed and entered. There is no
 * pattern, no threshold and no model: the mistakes this module can make are
 * limited to rendering a row wrong.
 */
import { plural, inDays } from "./plural.js";

/**
 * The reasons an apply flow can be blocked, and how each is worded.
 *
 * A CLOSED REQUISITION IS ONE OF THEM, deliberately, and it is the value most
 * likely to look redundant. `jobs.closed_at` already says a posting is gone —
 * but only for a posting the FETCHER can see. The apply bot meets closed reqs
 * on boards that are not tracked and on windows that are not boards at all,
 * and "I went to apply and it was gone" is a fact worth keeping whether or not
 * any board ever told us.
 */
export const REASONS = {
  captcha_hcaptcha: "hCaptcha loop",
  captcha: "captcha",
  http_error: "HTTP error",
  login_required: "account required",
  form_rejected: "the form rejected it",
  closed: "posting closed",
};

/** The default wording for a reason this build does not recognise. */
export const UNKNOWN_REASON_LABEL = "Blocked";

/**
 * How a reason reads. An unrecognised one renders as "Blocked" and the row
 * SURVIVES.
 *
 * FAIL OPEN, the same way triage does. The two errors are not symmetric: a row
 * whose reason string this build has never heard of costs one vague word on one
 * line, and dropping it silently un-blocks an application that is still broken
 * — so the owner is sent back to a form that will waste his evening again, with
 * nothing on screen to say why. The asymmetry is the whole argument, and it is
 * the reason `reason` is nullable in the schema rather than constrained.
 */
export function reasonLabel(reason) {
  if (!reason) return UNKNOWN_REASON_LABEL;
  return REASONS[reason] || UNKNOWN_REASON_LABEL;
}

/**
 * Fold the insert-only rows into "is this blocked right now".
 *
 * LATEST ROW PER (scope, key) WINS, ORDERED BY id — never by `at`. Two writes
 * inside one second carry identical timestamps and the pair settles at random;
 * foldFlags() in actions.js documents the same trap and orders the same way,
 * and the ids both tables generate are millisecond-prefixed so they sort the
 * way the clock ran.
 *
 * Keys are JSON-stringified rather than joined with a delimiter, for the reason
 * foldFlags learned by doing it wrong: a hand-punctuated composite key is
 * ambiguous the first time a component contains the separator, and a window key
 * is literally `window:Deloitte|Strategy & Operations / Consulting,
 * undergraduate` — colons, pipes, commas and slashes in one string.
 */
export function foldBlocked(rows = []) {
  const latest = new Map();
  for (const r of rows) {
    const k = JSON.stringify([r.scope, r.key]);
    const prev = latest.get(k);
    if (!prev || String(r.id).localeCompare(String(prev.id)) > 0) latest.set(k, r);
  }
  const roles = new Map();
  const windows = new Map();
  for (const [, r] of latest) {
    // A LIFT IS A ROW, and this is the line that reads it. `on_` is 0 on a row
    // written by `unblock`, so the fold simply stops reporting the block while
    // the history of it stays in the table.
    if (!Number(r.on_)) continue;
    const entry = {
      scope: r.scope,
      key: r.key,
      reason: r.reason || null,
      note: r.note || null,
      label: r.label || null,
      url: r.url || null,
      at: r.at || null,
    };
    (r.scope === "window" ? windows : roles).set(r.key, entry);
  }
  return { roles, windows };
}

/** The empty answer, so a caller that could not read the table has a shape. */
export const NO_BLOCKS = { roles: new Map(), windows: new Map() };

/**
 * Is this POSTING blocked?
 *
 * ON `key`, THE REQUISITION, NOT ON `groupKey`. Every other app-owned fact
 * about a role — saved, hidden, applied — is keyed on the group, because
 * Palantir reposts the same job in nine cities and acting on one of them means
 * acting on the role. A broken apply form is the exception: it is a fact about
 * one requisition's page, and twelve Palantir Deployment Strategist postings
 * share a group key while only the Chicago one loops.
 *
 * That asymmetry is why the group-level answer is composed rather than stored
 * — see visibleRoles() in db.js, which filters postings and lets a group vanish
 * only when it has no unblocked posting left.
 */
export function isBlocked(role, blocked = NO_BLOCKS) {
  if (!role || !role.key) return false;
  return (blocked.roles || NO_BLOCKS.roles).has(role.key);
}

/** The entry for a posting, or null. */
export function blockFor(role, blocked = NO_BLOCKS) {
  if (!role || !role.key) return null;
  return (blocked.roles || NO_BLOCKS.roles).get(role.key) || null;
}

/**
 * How long a window has left, worded.
 *
 * SEPARATE FROM THE LINE because a past date must not render as "closes 3 days
 * ago". inDays() is right about the arithmetic and wrong about the verb, and
 * this is the one place the distinction matters: a blocked window that has
 * already shut is the exact outcome the countdown exists to prevent, so it has
 * to say so in words rather than in a negative number.
 */
export function closesPhrase(closeIn, closes = null) {
  // null CHECKED BEFORE Number(), because `Number(null)` is 0 and 0 is a
  // perfectly finite number of days — so an undated window would have rendered
  // as "closes today", which is the most alarming line this section can print
  // and would be false every single morning. `Number.isFinite` cannot catch it;
  // only refusing the value before coercion can. Same for "" and for undefined.
  if (closeIn === null || closeIn === undefined || closeIn === "") return null;
  const d = Math.round(Number(closeIn));
  if (!Number.isFinite(d)) return null;
  const when = closes ? ` (${closes})` : "";
  if (d < 0) return `CLOSED ${plural(-d, "day")} ago${when}`;
  return `closes ${inDays(d)}${when}`;
}

/**
 * One digest line.
 *
 * A WINDOW LINE CARRIES THE COUNTDOWN and a role line does not, because the two
 * are running out at different speeds. A blocked requisition sits there until
 * the board drops it, and there is no date to count. A blocked WINDOW is a
 * deadline that keeps moving while the block does not — Deloitte closes on 30
 * September and the 406 had already eaten three days when this was written — so
 * a line saying only "blocked, HTTP error" lets the window expire while parked
 * in the very section that exists to stop that. The countdown is what makes the
 * row cost something to ignore.
 *
 * The label and the url come off the ROW, never from a join, so a requisition
 * Lever has since re-ided still renders as what it was and where it was.
 */
export function blockedLine(entry, { closeIn = null, closes = null } = {}) {
  if (!entry) return null;
  const label = entry.label || entry.key;
  const parts = [`**${label}** — ${reasonLabel(entry.reason)}`
    + (entry.note ? `: ${entry.note}` : "")];
  if (entry.scope === "window") {
    const phrase = closesPhrase(closeIn, closes);
    // NO DATE IS ITS OWN STATE and it is said out loud. A window with no close
    // date rendering as a line with no countdown is indistinguishable from one
    // whose countdown failed to compute, and 16 of 25 tracked windows have no
    // date at all — so silence here would be the common case wearing the
    // costume of a bug.
    parts.push(phrase || "no close date on file");
  }
  if (entry.url) parts.push(entry.url);
  return parts.join(" · ");
}

/**
 * Every blocked entry the digest should say, worst-dated first.
 *
 * WINDOWS BEFORE ROLES, and dated windows before undated ones, because that is
 * the order of what is unrecoverable: a window that closes takes the cycle with
 * it, a requisition that closes is one requisition. Within each, soonest first,
 * and the tie broken on `key` — every sort in this project ends in a unique
 * column, after three separate incidents of pages reshuffling on their own.
 */
export function orderBlocked(blocked = NO_BLOCKS, closeInFor = () => null) {
  const rows = [];
  for (const [, e] of blocked.windows || NO_BLOCKS.windows) {
    rows.push({ ...e, closeIn: closeInFor(e.key) });
  }
  const windows = rows.sort((a, b) =>
    (a.closeIn == null ? 1 : 0) - (b.closeIn == null ? 1 : 0)
    || (a.closeIn ?? 0) - (b.closeIn ?? 0)
    || String(a.key).localeCompare(String(b.key)));
  const roles = [...(blocked.roles || NO_BLOCKS.roles).values()]
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return [...windows, ...roles];
}
