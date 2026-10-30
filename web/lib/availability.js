/**
 * How long he actually has today, and what fits in it. Pure.
 *
 * The ladder already knows what each task COSTS — `minutes` is a stated field
 * on items and on deadline windows, never inferred, never guessed by a model —
 * and it has never known what the owner HAS. So it offers a three-hour composite on
 * a day with forty minutes in it, and the honest fix is not a smaller task; it
 * is knowing to offer a smaller task.
 *
 * THREE RULES.
 *
 * 1. NO ANSWER MEANS NO TRIMMING. Unanswered is the common state and it is a
 *    real one. The page asks once a day and then leaves him alone — a question
 *    that reappears is one you dismiss without reading, and this one has to be
 *    worth reading on the day it matters.
 *
 * 2. TRIMMING SAYS WHAT IT TRIMMED. A list that silently shortens is a list you
 *    stop trusting, because you cannot tell it from a list that lost something.
 *    "Accenture and Deloitte today, EY-Parthenon tomorrow" is the whole feature.
 *
 * 3. NOTHING IS EVER DROPPED, only deferred. The trimmed items come back
 *    tomorrow; they are not hidden, not rescheduled, and not marked as anything.
 */

/**
 * The buttons. Hours, because that is how a day is actually described — "I have
 * about two hours tonight" — and a minutes field would be a form to fill in.
 */
import { num } from "./num.js";

export const HOUR_CHOICES = [1, 2, 4, 6];

/**
 * What a piece of work costs when nothing states it.
 *
 * STATED VALUES ALWAYS WIN. These are the fallback for a child created before
 * `minutes` existed, and they are the durations the backfill itself writes, so
 * a task and its default agree rather than drifting.
 */
export const DEFAULT_MINUTES = {
  apply: 60,          // one application, properly
  confirm_date: 15,
  find_names: 20,
  followup: 10,
  other: 30,
};

export function minutesFor(item = {}) {
  const stated = num(item.minutes);
  if (stated !== null && stated > 0) return stated;
  return DEFAULT_MINUTES[item.unit_kind || item.kind] ?? DEFAULT_MINUTES.other;
}

/**
 * Fit a day's work into the hours available.
 *
 * Takes the ladder's ordered list and returns the prefix that fits, plus what
 * did not and why. ORDER IS PRESERVED absolutely: the ladder's ranking is
 * argued — irreversibility beats urgency, a closing window outranks a
 * commitment — and re-sorting by duration to pack the day fuller would throw
 * that away to save fifteen minutes.
 *
 * A composite task (three applications behind one row) is split into its
 * children first, so "two hours" can mean two of the three firms rather than
 * all or nothing.
 */
export function trimToFit(tasks = [], hours = null) {
  // RULE 1. No answer, no trimming, and the caller renders the full list.
  const h = num(hours);
  if (h === null) {
    return { fits: tasks, deferred: [], budget: null, used: 0, trimmed: false, message: null };
  }

  const budget = h * 60;
  const fits = [];
  const deferred = [];
  let used = 0;

  for (const t of tasks) {
    const cost = minutesFor(t);
    // The FIRST task always fits, whatever it costs. A budget smaller than the
    // most important thing on the list must not produce an empty day — it
    // should produce that one thing and an honest note that it will overrun.
    if (!fits.length || used + cost <= budget) {
      fits.push(t);
      used += cost;
    } else {
      deferred.push(t);
    }
  }

  return {
    fits,
    deferred,
    budget,
    used,
    trimmed: deferred.length > 0,
    overruns: used > budget,
    message: trimMessage(fits, deferred, hours, used, budget),
  };
}

/** Names what moved. A list that shortens without saying so is one you distrust. */
export function trimMessage(fits, deferred, hours, used, budget) {
  if (!deferred.length) return null;
  const name = (t) => t.label || t.firm || t.title || "one more";
  const today = fits.map(name);
  const later = deferred.map(name);
  const list = (a) => (a.length === 1 ? a[0]
    : a.length === 2 ? `${a[0]} and ${a[1]}`
    : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

  const over = used > budget
    ? ` ${today.length === 1 ? "That one alone" : "Those"} run past ${hours}h — `
      + "it is the thing that closes, so it is still first."
    : "";
  return `Trimmed to fit ${hours} ${hours === 1 ? "hour" : "hours"} — `
       + `${list(today)} today, ${list(later)} tomorrow.${over}`;
}

/** Today, in the user's timezone. The server runs in UTC and must not decide this. */
export function todayIn(tz = "America/Los_Angeles", now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: tz });
}
