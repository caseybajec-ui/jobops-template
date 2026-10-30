/**
 * Which child of a big task to put in front of him today.
 *
 * Pure — no database, no `node:` — like display.js, today.js and people.js, so
 * the rules can be tested against fixed dates rather than against whatever the
 * table holds this morning. The caller does the reading and the one write.
 *
 * THE PROBLEM. "Pull 15 alumni names from the alumni directory" is not a task, it
 * is a project, and it sat untouched from the day it was written: nothing that
 * takes three hours starts in the four minutes between classes this tool is
 * built around. Sixteen unconfirmed windows had the same shape — a standing
 * instruction to do sixteen things, which is a nag, not a queue.
 *
 * THE RULE. At most ONE child of each kind carries today's date. Not a quota to
 * hit, a ceiling to stop at: two confirm-date items on one morning is the same
 * wall in miniature.
 *
 * WHAT IT DOES NOT DO. It does not rotate a surfaced-but-unfinished item away.
 * An item that appears and then vanishes because a day passed teaches you that
 * the page forgets, and the whole redesign exists because the page was being
 * closed. It stays until it is done or explicitly pushed.
 */

/** One of each kind per day. */
export const UNIT_KINDS = ["confirm_date", "find_names"];

/** Nothing new on a Saturday or Sunday. */
export function isWeekend(date) {
  const d = date.getUTCDay();
  return d === 0 || d === 6;
}

/** Today as YYYY-MM-DD in the user's timezone, not the server's. */
export function todayIn(tz, now = new Date()) {
  // en-CA renders ISO-ish (2026-08-31), which is the one locale that does.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * Pick what to surface, and say what to write.
 *
 * Returns `{ surface: [ids], reason: {...} }` — a PLAN, not an effect. The
 * caller writes `surfaced_on` for the returned ids and nothing else, which is
 * what makes this idempotent: run it twice on the same day and the second call
 * finds the first call's item already surfaced and returns nothing to do.
 *
 * `children` are item rows carrying `unit_kind`, `surfaced_on`, `done`, and for
 * find_names a `unit_company`; `ranking` is the Companies "Start here" order,
 * best first; `contactCounts` maps a company slug to how many people are known
 * there; `windowStaleness` maps a company slug or firm to days since it was
 * last checked (null = never), for the confirm_date choice.
 */
export function planToday({
  children = [],
  ranking = [],
  contactCounts = {},
  windowStaleness = {},
  namesPerCompany = 2,
  today = null,
  now = new Date(),
  tz = "America/Los_Angeles",
} = {}) {
  const day = today || todayIn(tz, now);
  const weekend = isWeekend(new Date(`${day}T12:00:00Z`));

  const plan = { surface: [], keep: [], reason: {}, next: {}, weekend };

  /**
   * WHAT COMES AFTER TODAY'S, named but not surfaced.
   *
   * A collapsed parent row said "Nothing surfaced today" — four lines to report
   * an absence. "next up: Anduril" is the same row's worth of space saying
   * something usable, and it must be the pick the scheduler WOULD make rather
   * than a guess the view invents: the find_names order is company ranking and
   * the confirm_date order is staleness, and re-deriving either in a component
   * is two implementations of one rule waiting to disagree.
   *
   * It runs the real picker over the children that are neither done nor already
   * standing, which is exactly the question "what is next".
   */
  const describe = (pick, rows) => {
    if (!pick) return null;
    const row = rows.find((c) => c.id === pick.id);
    return { id: pick.id, company: row?.unit_company || null, title: row?.title || null };
  };

  for (const kind of UNIT_KINDS) {
    const mine = children.filter((c) => c.unit_kind === kind && !c.done);
    const pickFrom = (rows) => (kind === "find_names"
      ? pickFindNames(rows, ranking, contactCounts, namesPerCompany)
      : pickConfirmDate(rows, windowStaleness));

    // ALREADY SURFACED AND STILL OPEN: IT STAYS. On ANY previous day, not just
    // today.
    //
    // This compared `surfaced_on === day`, so yesterday's unfinished pick did
    // not match and a new one was chosen — or, when the cooldown left nothing
    // eligible, none was, and both parents read "Nothing surfaced today". The
    // one-per-day ladder delivered zero per day.
    //
    // The rule is: an uncompleted surfaced child stays until it is done. `mine`
    // is already filtered to not-done, so any surfaced_on at all means standing.
    // Most recent first, so a history of several settles deterministically.
    const standing = mine
      .filter((c) => c.surfaced_on)
      .sort((a, b) => String(b.surfaced_on).localeCompare(String(a.surfaced_on))
                   || String(a.id).localeCompare(String(b.id)))[0];
    if (standing) {
      plan.keep.push(standing.id);
      plan.reason[kind] = standing.surfaced_on === day
        ? "already surfaced today"
        : "still open from a previous day";
      plan.next[kind] = describe(pickFrom(mine.filter((c) => c.id !== standing.id)), mine);
      continue;
    }

    // WEEKENDS. Nothing new is chosen, but Friday's pick is not withdrawn —
    // it simply keeps whatever surfaced_on it already has, and the caller does
    // not write. A job search does not require Saturday admin; it also should
    // not lose Friday's unfinished item.
    if (weekend) {
      plan.reason[kind] = "weekend — nothing new";
      // Monday's pick, named on Saturday. The row still has something to say.
      plan.next[kind] = describe(pickFrom(mine), mine);
      continue;
    }

    const pick = pickFrom(mine);

    if (pick) {
      plan.surface.push(pick.id);
      plan.reason[kind] = pick.why;
      plan.next[kind] = describe(pickFrom(mine.filter((c) => c.id !== pick.id)), mine);
    } else {
      plan.reason[kind] = mine.length ? "nothing eligible" : "none left";
      plan.next[kind] = null;
    }
  }

  return plan;
}

/**
 * The highest-ranked company that still has fewer than two names.
 *
 * Ranked rather than stalest, because for networking the question is where a
 * referral is worth most, and that is the Companies ordering — reachable roles
 * weighted by class-year depth. A company that reached the target drops out entirely
 * rather than being deprioritised: two names is the whole goal.
 */
function pickFindNames(children, ranking, contactCounts, namesPerCompany) {
  const order = new Map(ranking.map((slug, i) => [slug, i]));
  const eligible = children
    .filter((c) => c.unit_company)
    .filter((c) => (contactCounts[c.unit_company] || 0) < namesPerCompany)
    .sort((a, b) => (order.get(a.unit_company) ?? 9999) - (order.get(b.unit_company) ?? 9999)
                 // TOTAL. Two companies absent from the ranking tie at 9999,
                 // and without this the pick would differ between page loads.
                 || String(a.unit_company).localeCompare(String(b.unit_company))
                 || String(a.id).localeCompare(String(b.id)));
  const c = eligible[0];
  return c ? { id: c.id, why: `${c.unit_company} is the highest-ranked company still under ${namesPerCompany} names` } : null;
}

/**
 * The window nobody has looked at for longest.
 *
 * Never-checked first — an unknown that has never been investigated is worth
 * more than one confirmed absent a fortnight ago — then oldest check.
 */
function pickConfirmDate(children, staleness) {
  const eligible = [...children].sort((a, b) => {
    const sa = staleness[a.unit_company];
    const sb = staleness[b.unit_company];
    const na = sa === null || sa === undefined;
    const nb = sb === null || sb === undefined;
    if (na !== nb) return na ? -1 : 1;         // never checked wins
    if (!na && sa !== sb) return sb - sa;       // then oldest
    return String(a.unit_company || a.id).localeCompare(String(b.unit_company || b.id))
        || String(a.id).localeCompare(String(b.id));
  });
  const c = eligible[0];
  if (!c) return null;
  const s = staleness[c.unit_company];
  return {
    id: c.id,
    why: s === null || s === undefined
      ? `${c.unit_company || "it"} has never been checked`
      : `${c.unit_company || "it"} was last checked ${s} days ago, the longest of any`,
  };
}

/**
 * How a parent reads: how many of its children are done.
 *
 * Counted from the children rather than stored on the parent, for the reason
 * every derived value in this codebase is derived: a stored count is a second
 * copy that goes wrong the first time a child is completed by another path.
 */
/**
 * What a child IS, so the counter can name its own unit.
 *
 * "0 of 8" under a title reading "Pull 15 alumni names" looks like a miscount:
 * the title counts NAMES and the counter counts COMPANIES, and nothing on the
 * row says so. Two numbers that measure different things have to say which is
 * which — the same rule the Companies row learned about at40 and reachable40.
 */
export const UNIT_NOUN = {
  confirm_date: ["window", "windows"],
  find_names: ["company", "companies"],
};

export function parentProgress(parent, children) {
  const mine = children.filter((c) => c.parent_id === parent.id);
  // Every child of one parent has the same kind; take it from whichever is
  // there rather than from the parent, which carries none.
  const kind = mine.find((c) => c.unit_kind)?.unit_kind;
  const [one, many] = UNIT_NOUN[kind] || [null, null];
  return {
    total: mine.length,
    done: mine.filter((c) => c.done).length,
    // The kind, returned rather than recomputed by every caller: the parent row
    // needs it to ask the plan what comes next, and a second `find(c =>
    // c.unit_kind)` in the view is the same lookup written twice.
    kind: kind || null,
    noun: mine.length === 1 ? one : many,
    children: mine,
  };
}

/**
 * How long something has been sitting, as a signal rather than a date.
 *
 * "added 5 days ago" was under every task, which is noise on a thing added
 * yesterday and far too quiet on one that has been ignored for a fortnight.
 * Nothing under three days; gold to nine; red past that.
 */
export const AGE_QUIET_DAYS = 3;
export const AGE_LOUD_DAYS = 10;

export function ageSignal(days) {
  if (days === null || days === undefined || days < AGE_QUIET_DAYS) return null;
  return {
    days,
    level: days >= AGE_LOUD_DAYS ? "now" : "soon",
    text: `untouched ${days} days`,
  };
}
