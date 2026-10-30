/**
 * Which boards stopped answering. Pure — no database, no network, no `node:`.
 *
 * THE BUG THIS EXISTS FOR. A board whose slug goes stale does not error. It
 * answers, politely, with nothing — Greenhouse 404s but Ashby returns a JS shell
 * with an empty list, which is why probe_board validates shape rather than
 * status. Downstream, an empty board is indistinguishable from a company that
 * had no new roles: same green run, same freshness stamp, same silence. Fifty-
 * nine boards are polled every morning and any of them can do this.
 *
 * WHAT MAKES A ZERO AN ANOMALY IS HISTORY, NOT THE ZERO. Judgment Labs lists 5
 * roles and could honestly go to 0; Anduril going to 0 is a broken slug. The
 * only thing that separates them is what the board returned before, so every
 * rule here is a comparison against that board's own past and never a threshold
 * somebody picked.
 *
 * IT REPORTS, IT DOES NOT ACT. Nothing here closes a role, drops a company or
 * edits companies.yaml. fetch_jobs.py already refuses to close roles on a board
 * that did not answer — silence is not evidence — and this module keeps that
 * property by producing text for a human rather than a decision for the
 * pipeline. Same reason the deadline checker does not scrape.
 */

/** A board is "known good" if it has ever returned at least one role. */
const everWorked = (hist) => hist.some((h) => (h.n_roles ?? 0) > 0);

/**
 * Whole days between two YYYY-MM-DD strings. Both are already CALENDAR dates —
 * `day` is stamped once per run — so this is deliberately not timezone-aware.
 *
 * Date.UTC rather than `new Date(str)`: the latter is parsed as UTC midnight for
 * this format but as LOCAL midnight for others, and a helper that changes
 * meaning with its input format is one nobody can safely reuse. Returns 0 rather
 * than NaN on anything unparseable, because a bad date must not silently
 * suppress an anomaly — 0 keeps the board inside the reporting window.
 */
function daysBetween(from, to) {
  const p = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const a = p(from); const b = p(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * Severities, worst first. `error` outranks `zeroed` because a board that threw
 * gave us no information at all, while one that answered with 0 at least told
 * us something — and because an error is usually the fixable one (a slug, a
 * rename, an outage) whereas a genuine 0 may just be a small company.
 */
export const ANOMALY_RANK = { empty_run: 0, error: 1, zeroed: 2, never_worked: 3 };

/**
 * How long a board that has NEVER returned a role stays news.
 *
 * THE CASE THIS EXISTS FOR. `zeroed` compares a board against its own past, so
 * a board with no past cannot trip it — and a slug that was wrong from the day
 * it was added has no past by definition. `ashby/mach` is the live example: it
 * answered cleanly with 0 roles on the first run of this table, matched no rule,
 * and rendered as "No anomalies." That is the project's own #1 failure class,
 * "an always-empty source and an always-zero count are the same bug", reproduced
 * inside the module written to catch it.
 *
 * WHY IT IS BOUNDED. A genuinely small company with nothing open right now is
 * also a board that has never returned a role, and it would trip this every
 * morning forever. "A nag you cannot answer is one you learn to skip" — and
 * there is no answer to give here, because the only fix is checking the slug by
 * hand. So it is news for a fortnight, which is long enough to act on and short
 * enough not to become wallpaper.
 *
 * IT DOES NOT GO SILENT AFTERWARDS. healthLines() carries the count of
 * never-working boards in its ALWAYS-PRESENT head line, whether or not anything
 * is flagged. The fortnight bounds the nagging, not the fact — the same split as
 * a window check, which refreshes recency without ever asserting a date.
 */
export const NEVER_WORKED_DAYS = 14;

/** Did this fetch go wrong at all — threw, or answered with nothing? */
const bad = (r) => !!r.error || (r.n_roles ?? 0) === 0;

/**
 * How many times running we have looked at this board and found it broken,
 * and the day the run of failures started.
 *
 * COUNTED IN OBSERVATIONS, NOT DATES. A day with no row is a day nobody
 * looked, and an absence of evidence must not become evidence either way --
 * it neither counts as a failure nor clears the streak. That is the same rule
 * as a window check: a negative observation records that you looked, never
 * what you found. Days when the pipeline itself did not run would otherwise
 * silently reset every board's streak, which is the direction that loses the
 * finding.
 */
export function badStreak(today_, hist) {
  if (!bad(today_)) return { days: 0, since: null };
  const older = [...hist].sort((a, b2) => String(b2.day).localeCompare(String(a.day)));
  let days = 1;
  let since = today_.day;
  for (const r of older) {
    if (!bad(r)) break;
    days += 1;
    since = r.day;
  }
  return { days, since };
}

/**
 * Everything wrong with the latest fetch.
 *
 * @param rows  every board_fetches row available, any order. Each:
 *              { day, source, slug, display_name, n_roles, error }
 * @param today the day to judge. Defaults to the newest day present, so a
 *              caller that has not thought about timezones still gets the last
 *              run rather than an empty answer.
 *
 * Returns { day, boards, anomalies, totalRoles, ok } — `ok` is false when
 * anything at all is wrong, and it is what the caller should branch on rather
 * than re-deriving the condition from the list.
 */
export function boardAnomalies(rows = [], today = null) {
  const all = rows.filter((r) => r && r.source && r.slug);
  if (!all.length) {
    // NO ROWS IS NOT A CLEAN BILL OF HEALTH. It means the table is empty or the
    // read failed, and reporting that as "all boards fine" is exactly the
    // green-on-nothing this module exists to prevent. The caller is told it has
    // no data instead, and says so.
    return { day: null, boards: [], anomalies: [], totalRoles: 0, ok: false, noData: true };
  }

  const day = today || all.map((r) => r.day).sort().at(-1);
  const boards = all.filter((r) => r.day === day);

  // Every board's history BEFORE today, keyed by board.
  const past = new Map();
  for (const r of all) {
    if (r.day >= day) continue;
    const k = `${r.source}:${r.slug}`;
    if (!past.has(k)) past.set(k, []);
    past.get(k).push(r);
  }

  const anomalies = [];
  for (const b of boards) {
    const k = `${b.source}:${b.slug}`;
    const hist = past.get(k) || [];
    const name = b.display_name || b.slug;
    const best = Math.max(0, ...hist.map((h) => h.n_roles ?? 0));
    // How long this has been going on, for the escalation rule in notify.js.
    const streak = badStreak(b, hist);

    if (b.error) {
      anomalies.push({
        kind: "error", source: b.source, slug: b.slug, name,
        brokenDays: streak.days, brokenSince: streak.since,
        was: everWorked(hist) ? best : null,
        detail: b.error,
        line: `**${name}** (${b.source}/${b.slug}) — fetch failed: ${b.error}.`
          + (everWorked(hist)
            ? ` It listed ${best} roles before, so its roles were left open rather than closed.`
            : " It has never returned a role here."),
      });
      continue;
    }

    if ((b.n_roles ?? 0) === 0 && everWorked(hist)) {
      // THE CASE THE WHOLE TABLE IS FOR. Answered cleanly, listed nothing, and
      // used to list something. Almost always a renamed slug or a board moved
      // to another ATS — Shield AI mid-migration, Glean's 'gleanwork'.
      anomalies.push({
        kind: "zeroed", source: b.source, slug: b.slug, name,
        brokenDays: streak.days, brokenSince: streak.since,
        was: best, detail: null,
        line: `**${name}** (${b.source}/${b.slug}) — answered with 0 roles, `
          + `and used to list ${best}. The slug has probably changed or the `
          + `board moved. Check with: python fetch_jobs.py discover ${name}`,
      });
      continue;
    }

    if ((b.n_roles ?? 0) === 0) {
      // ANSWERED CLEANLY WITH NOTHING, AND NEVER HAS ANSWERED WITH ANYTHING.
      // Either the slug was wrong the day it was added, or the company really
      // has no openings — and NOTHING IN THE DATA CAN TELL THOSE APART, which
      // is exactly why it has to be said out loud rather than assumed benign.
      const firstDay = [b, ...hist].map((h) => h.day).sort()[0];
      const emptyFor = daysBetween(firstDay, day);
      if (emptyFor <= NEVER_WORKED_DAYS) {
        anomalies.push({
          kind: "never_worked", source: b.source, slug: b.slug, name,
          brokenDays: streak.days, brokenSince: streak.since,
          was: null, detail: null, emptyFor,
          // COUNTS UP, never down. "Empty since it was added, 0 days ago" is the
          // honest reading on day one; a countdown would imply a deadline that
          // does not exist.
          line: `**${name}** (${b.source}/${b.slug}) — answered with 0 roles, and `
            + `has never returned one${emptyFor > 0 ? ` in the ${emptyFor} day`
              + `${emptyFor === 1 ? "" : "s"} since it was added` : " (first run)"}. `
            + `Either the slug is wrong or the company has nothing open; the data `
            + `cannot tell those apart. Check with: python fetch_jobs.py discover ${name}`,
        });
      }
    }
  }

  const totalRoles = boards.reduce((n, b) => n + (b.n_roles ?? 0), 0);

  // HOW MANY BOARDS HAVE NEVER RETURNED A ROLE, whether or not they are still
  // inside the never_worked reporting window. This is the half that must never
  // go quiet: the anomaly stops after a fortnight so it does not become a nag,
  // and this count stays in the head line forever so the fact does not vanish
  // with it. A board that is silently empty for six months is precisely what
  // this module exists to make visible.
  const neverWorked = boards.filter(
    (b) => !b.error
      && (b.n_roles ?? 0) === 0
      && !everWorked(past.get(`${b.source}:${b.slug}`) || []),
  ).length;

  // A RUN THAT INGESTED NOTHING IS NEVER A SUCCESS, whatever the individual
  // boards say. This is the backstop for the case where every board fails the
  // same way at once — a dead network on the runner, a bad release of requests,
  // an expired outbound proxy — where each board looks like one ordinary error
  // and the run as a whole is a catastrophe.
  if (boards.length && totalRoles === 0) {
    anomalies.unshift({
      kind: "empty_run", source: null, slug: null, name: null,
      was: null, detail: null,
      line: `**No roles at all.** All ${boards.length} boards returned nothing `
        + `on ${day}. Treat today's roles, scores and counts as stale.`,
    });
  }

  anomalies.sort((a, b) => (ANOMALY_RANK[a.kind] ?? 9) - (ANOMALY_RANK[b.kind] ?? 9)
    || String(a.name).localeCompare(String(b.name))
    // Unique tie-break. Two boards can share a display name across ATSs, and a
    // comparator that can return 0 for distinct rows reshuffles the list on
    // every render — third time in this project, hence the rule.
    || String(a.slug).localeCompare(String(b.slug)));

  return {
    day,
    boards,
    anomalies,
    totalRoles,
    neverWorked,
    ok: anomalies.length === 0,
    noData: false,
  };
}

/**
 * The pipeline-health section, as digest lines.
 *
 * IT ALWAYS SAYS THE COUNT, including when everything is fine. "59 boards, 9,912
 * roles" is what makes a later "58 boards" legible; a section that renders only
 * on failure gives the reader nothing to compare against, and a health report
 * you only see when it is bad cannot be sanity-checked when it is good.
 */
export function healthLines(health, { limit = 8 } = {}) {
  if (!health || health.noData) {
    return ["**Pipeline health: no fetch was recorded.** Either the run did not "
      + "reach the boards or the board_fetches table is empty. This is not a "
      + "clean bill of health — it is missing data."];
  }
  const { boards, anomalies, totalRoles, day, neverWorked = 0 } = health;
  // THE NEVER-WORKING COUNT RIDES ON THE HEAD LINE, in both the healthy and the
  // unhealthy case. It outlives the never_worked anomaly, which stops after a
  // fortnight so it does not become a nag — see NEVER_WORKED_DAYS. Bounding the
  // nagging must not bound the fact.
  const empties = neverWorked
    ? `, ${neverWorked} board${neverWorked === 1 ? " has" : "s have"} never returned a role`
    : "";
  const head = `Pipeline health, ${day}: ${boards.length} boards polled, `
    + `${totalRoles.toLocaleString("en-US")} roles seen${empties}`;
  if (!anomalies.length) return [`${head}. No anomalies.`];

  const shown = anomalies.slice(0, limit).map((a) => a.line);
  const rest = anomalies.length - shown.length;
  return [
    `${head}, **${anomalies.length} needing attention**:`,
    ...shown,
    ...(rest > 0 ? [`…and ${rest} more.`] : []),
  ];
}
