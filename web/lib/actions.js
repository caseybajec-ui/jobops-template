/**
 * What a row is actually asking you to do.
 *
 * Pure — no database, no `node:` — so it runs on the server and inside the row
 * components, and every branch is testable without a browser.
 *
 * THE PROBLEM. Every row looked the same and the right action was not the same.
 * Palantir's Deployment Strategist is open NOW, which means it will be filled
 * long before the owner graduates — applying to it is close to pointless, and
 * the thing worth doing is meeting somebody there before the class-year req
 * opens. Databricks' APM (dated for the class) is the opposite: it is the
 * actual application, open to the owner's class, and it closes. Both rendered
 * as a title, a location and a Save button.
 */

import { bandOf, isCodingInterviewRole, CODING_NOTE } from "./display.js";
import { USER_CLASS_YEAR } from "./constants.js";
import { NAMES_PER_COMPANY } from "./people.js";

export const PRIMARY_ACTIONS = [
  ["apply", "Apply", "Open to your class, and it closes. This is the one to act on."],
  ["find_person", "Find a person", `Open now, so it will be filled before you graduate. The value here is knowing somebody before the ${USER_CLASS_YEAR} req opens.`],
  ["watch", "Watch", "Nothing to do today. It is here as evidence about who hires this profile."],
];
export const ACTION_LABEL = Object.fromEntries(PRIMARY_ACTIONS.map(([k, l]) => [k, l]));
export const ACTION_WHY = Object.fromEntries(PRIMARY_ACTIONS.map(([k, , w]) => [k, w]));

/**
 * The one verb for a role.
 *
 *   apply         a named programme or an entry role DATED for the owner's
 *                 class. The thing they can actually start on graduating.
 *   find_person   open now, not a programme, and fewer than two contacts at
 *                 that company. A req that will be filled by Christmas is not
 *                 an application; it is evidence that the company hires this
 *                 profile, and the move is a name.
 *   watch         everything else — including an open-now role at a company the
 *                 owner already knows two people at, where the networking is
 *                 done and there is nothing else to do until a class-year req
 *                 appears.
 *
 * `wrong_cycle` is NOT handled here. A flagged role is excluded before this
 * function is ever called, by the one shared filter — a per-view check is how
 * a hidden role reappears on the fourth page somebody forgot to update.
 */
function baseAction(role = {}, companyContactCount = 0,
                    userClassYear = USER_CLASS_YEAR) {
  const level = role.entry_level;
  const dated = role.start_window === `${userClassYear} program`
    || Number(role.class_year) === userClassYear
    || Number(role.start_year) === userClassYear;

  // A named programme dated for his class, or an entry role explicitly dated
  // for it. "Dated" is the load-bearing word: an undated programme role is a
  // programme that will run again next year, and applying to this year's is
  // applying to the wrong one.
  if ((level === "program" || level === "entry") && dated) return "apply";

  // Open now and nobody known there yet.
  if (level !== "program" && companyContactCount < NAMES_PER_COMPANY) {
    return "find_person";
  }

  return "watch";
}

/**
 * A straight engineering role screens with a live coding interview the owner
 * has said they would fail, so it is never the day's application.
 *
 * WATCH, NOT HIDDEN. He asked for exactly this and the distinction matters: a
 * hidden role is one he never learns exists, and these are still evidence that
 * the company hires new grads into his class year. Demoting the verb stops the
 * tool pointing at them; deleting them would throw away the intelligence.
 *
 * ONLY FROM `apply`. A role already at find_person keeps it — that verb is
 * about getting a name at a company, which stays worth doing whether or not
 * this particular req is his loop. 22 coding roles sit there today and this
 * rule deliberately leaves every one alone.
 */
export function codingBlocked(role = {}, companyContactCount = 0,
                              userClassYear = USER_CLASS_YEAR) {
  return baseAction(role, companyContactCount, userClassYear) === "apply"
      && isCodingInterviewRole(role.title);
}

export function computePrimaryAction(role = {}, companyContactCount = 0,
                                     userClassYear = USER_CLASS_YEAR) {
  const base = baseAction(role, companyContactCount, userClassYear);
  return (base === "apply" && isCodingInterviewRole(role.title)) ? "watch" : base;
}

/** Everything a row needs to render its action, in one call. */
export function primaryActionFor(role, contactCounts = {}, userClassYear = USER_CLASS_YEAR) {
  const n = contactCounts[role.company] || 0;
  const action = computePrimaryAction(role, n, userClassYear);
  return {
    action,
    label: ACTION_LABEL[action],
    why: ACTION_WHY[action],
    contacts: n,
    // The reason the verb was demoted, or null. Rendered as a gray note beside
    // the row so "Watch" is not silent about why it is not "Apply".
    note: codingBlocked(role, n, userClassYear) ? CODING_NOTE : null,
    // Band is not part of the decision, but the row shows it and the tooltip
    // reads better with it.
    band: bandOf(role.score),
  };
}

/* ------------------------------------------------------------------ flags */

export const FLAG_WRONG_CYCLE = "wrong_cycle";

/**
 * Fold the insert-only flag rows into "is this hidden right now".
 *
 * Latest row per (scope, key, flag) wins, ordered by id — never by `at`, which
 * is the trap the actions table already documents: two clicks inside one second
 * write identical timestamps and the pair settles at random.
 */
export function foldFlags(rows = []) {
  const latest = new Map();
  for (const r of rows) {
    // JSON, not a delimiter. This was written with an unintended NUL byte
    // as the separator — invisible in every editor and in every diff. A
    // stringified array cannot be ambiguous however a key is punctuated,
    // and it is readable.
    const k = JSON.stringify([r.scope, r.key, r.flag]);
    const prev = latest.get(k);
    if (!prev || String(r.id).localeCompare(String(prev.id)) > 0) latest.set(k, r);
  }
  const roles = new Map();
  const companies = new Map();
  for (const [, r] of latest) {
    if (!Number(r.on_)) continue;
    (r.scope === "company" ? companies : roles).set(r.key, r.note || null);
  }
  return { roles, companies };
}

/**
 * Is this role hidden? By its own flag, or by its company's.
 *
 * ONE PREDICATE, used by every list. The brief's own instruction — "one helper,
 * used everywhere; no per-view filtering" — is the important half: a role hidden
 * on Daily and visible on Inbox is worse than one that was never hidden, because
 * the first teaches you the button does not work.
 */
export function isWrongCycle(role, flags = { roles: new Map(), companies: new Map() }) {
  if (!role) return false;
  return flags.roles.has(role.groupKey) || flags.companies.has(role.company);
}

/** The same predicate, curried, for a `.filter()` in the middle of a chain. */
export const notHidden = (flags) => (role) => !isWrongCycle(role, flags);

/** Why it is hidden, for the undo list at the foot of Inbox. */
export function wrongCycleNote(role, flags) {
  if (!role) return null;
  return flags.roles.get(role.groupKey) ?? flags.companies.get(role.company) ?? null;
}
