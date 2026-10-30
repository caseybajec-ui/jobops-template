/**
 * What is worth an email, and what that email says. Pure — no database, no
 * network, no `node:`.
 *
 * Everything here is a function of state that has already been read, so the
 * whole of "would this send, and what would it say" is testable without a
 * mailbox, a key, or a cron run. The sender in notify.mjs does the I/O and
 * makes no decisions.
 *
 * THE RULE THAT SHAPES ALL OF IT: a day with nothing actionable sends nothing.
 * A digest that arrives whether or not anything happened is one you filter to a
 * folder inside a fortnight, and then the one that mattered goes there too. So
 * `buildDigest` returns null far more often than it returns an email, and that
 * is the feature rather than a gap in it.
 */
import { plural, inDays } from "./plural.js";
import { orderBlocked, blockedLine } from "./blocked.js";
import { windowKey } from "./display.js";
import { num } from "./num.js";
import { healthLines } from "./boards.js";
import { truncationLine } from "./blockers.js";
import { transferLine } from "./transfer.js";
import { submissionLine } from "./submissions.js";

// THE TRIGGER LIST LIVES IN ./triggers.js, and is re-exported here so every
// existing importer is unchanged. It was moved because genconfig.mjs needs it
// at build time and importing notify.js pulled in transfer.js, which now reads
// the file genconfig writes -- a cycle that works only on a machine that has
// already built once. See triggers.js.
export { TRIGGERS, TRIGGER_RANK } from "./triggers.js";
import { TRIGGERS, TRIGGER_RANK } from "./triggers.js";

/**
 * When a closing window speaks up: at 7 days, at 3, and at 1.
 *
 * NOT every day inside the week. Four identical emails about Deloitte teaches
 * you that a JobOps email is noise, and the fifth one — the one that says it
 * closes tomorrow — arrives into that. Descending, because the threshold a
 * window has reached is the FIRST of these it is at or under.
 */
export const WINDOW_STEPS = [7, 3, 1];

/** Which step a day count has reached, or null when it is between them. */
export function windowStep(days) {
  // num(), not Number(). Number(null) is 0 and 0 <= 1, so an UNDATED window
  // came back as the 1-day step and would have been emailed as "closes
  // tomorrow". See lib/num.js — the same mistake in three places in one day.
  const d = num(days);
  if (d === null || d < 0) return null;
  for (const s of WINDOW_STEPS) {
    if (d <= s) {
      // The tightest step it qualifies for: 2 days is a "3", not a "7".
      const tighter = WINDOW_STEPS.filter((x) => d <= x);
      return Math.min(...tighter);
    }
  }
  return null;
}

const abs = (base, path) => `${String(base || "").replace(/\/$/, "")}${path}`;

/**
 * Everything that fired, highest priority first.
 *
 * `alreadyFired` is the set of trigger keys already emailed — it is what makes
 * the repeat rules work. A window key carries its own threshold
 * ("window:Deloitte|Strategy:3"), so "have I already said this" is a lookup
 * rather than a judgement.
 */
/**
 * The stages a run must finish before its data is worth anything.
 *
 * `watch` is deliberately absent: it is `continue-on-error` in the workflow
 * because a careers page having a bad night must not invalidate a fetch, a
 * gate and a score that all succeeded. `deadlines` is absent for the same
 * reason -- it reports, it does not produce data anything else reads.
 */
export const REQUIRED_STAGES = ["fetch", "gate", "score"];

/** "fetch=success,gate=success,score=" -> {fetch:"success",...}. */
export function parseStages(s) {
  const text = String(s || "").trim();
  if (!text) return null;
  const out = {};
  for (const part of text.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The last day a row may have no stages and still be believed.
 *
 * The workflow began reporting per-stage outcomes on 2026-09-08. Two rows
 * predate that -- 09-07 and 09-08 -- and they are grandfathered BY DATE
 * rather than by an open-ended fallback.
 *
 * The difference matters. An unbounded "no stages means trust the job status"
 * is indistinguishable from a workflow that has quietly stopped reporting
 * them: every future row takes the fallback, partial-run detection dies, and
 * nothing goes red. Closing it by date means that after this cutoff a missing
 * stage list is an ERROR -- the run does not count as complete, so the
 * staleness alert speaks rather than staying silent.
 */
export const STAGES_REQUIRED_FROM = "2026-09-09";

/**
 * Did this run finish everything, or merely leave a row behind?
 *
 * THE DISTINCTION IS THE WHOLE POINT. daily #21 was cancelled at the 30-minute
 * job timeout while the scoring step blocked on a Batch API poll. "Record the
 * run" then completed green in a second and wrote a row -- so a presence check
 * read that morning as "the pipeline ran", when in fact nothing had been
 * scored and the data was exactly as stale as if it had never fired. An alert
 * that counts rows is defeated by the failure it exists to catch.
 */
export function runCompleted(row) {
  if (!row) return false;
  if (String(row.status || "") !== "success") return false;
  const stages = parseStages(row.stages);
  if (stages === null) {
    // GRANDFATHERED, NOT EXEMPT. Before the cutoff there was no stage data to
    // write and the job status is the best evidence the row carries. On or
    // after it, a row with no stages means the workflow stopped reporting
    // them, and that is a broken pipeline rather than a healthy run --
    // failing it here is what makes the silence audible.
    return String(row.day || "").slice(0, 10) < STAGES_REQUIRED_FROM;
  }
  return REQUIRED_STAGES.every((s) => stages[s] === "success");
}

/**
 * How stale the data is allowed to get before the digest says so.
 *
 * THIRTY HOURS, AND MEASURED IN HOURS RATHER THAN CALENDAR DAYS, because a
 * calendar day is not a duration. This cron is scheduled at 14:10 UTC and
 * actually starts 2.5 to 4.5 hours late every morning (10:48, 10:34, 09:47,
 * 09:57, 11:42 PDT over 3-7 September), so the gap between two consecutive
 * HEALTHY runs is anywhere from about 22 to 26 hours. A genuinely skipped day
 * is 46 to 50. Thirty sits in the empty space between them, with roughly four
 * hours of margin above the worst healthy gap.
 *
 * The unit is what makes a single bad morning legible. A run that fails or
 * gets reaped leaves yesterday's completed run as the most recent one, about
 * 24 hours back -- under this threshold, so the staleness alert stays quiet
 * and pipeline_failure carries that morning on its own. Counting calendar
 * days called the same situation "1 day missed" and fired both, which says
 * the data is stale when it is a normal day old.
 */
export const STALE_RUN_HOURS = 30;

/**
 * Consecutive failed fetches before a watched page becomes news.
 *
 * THREE, because one is a careers page having a bad night and a line that
 * appears on every blip is one that gets skimmed past. Three consecutive
 * mornings is a watcher that has stopped working, and these are the pages
 * nothing else in the pipeline can see -- Workday and custom sites with no
 * machine-readable board, where the watcher is the only thing that can say a
 * window opened.
 */
export const WATCHER_BROKEN_DAYS = 3;

/**
 * Consecutive bad fetches before a board escalates once and then goes quiet.
 *
 * THREE, the same shape as WATCHER_BROKEN_DAYS and for the same reason: one
 * bad morning is a board having an outage, three in a row is a slug that has
 * gone stale and needs a person. The difference is what happens AFTER --
 * a watcher keeps reporting because there is nothing to decide, while a board
 * has exactly two decisions available (fix the slug, or retire it) and saying
 * so a fourth time adds nothing.
 */
export const BOARD_ESCALATE_DAYS = 3;

const finishedAt = (r) => {
  // finished_at is written by recordrun on every row. `day` is the fallback
  // for a row that somehow has none, read as midday -- the least-wrong single
  // point in a date, and never more than 12 hours out either way.
  const t = String(r?.finished_at || "").trim();
  if (t) return t;
  const d = String(r?.day || "").slice(0, 10);
  return d ? `${d}T12:00:00+00:00` : "";
};

function hoursBetween(from, to) {
  const a = Date.parse(String(from || "").replace(" ", "T"));
  const b = Date.parse(String(to || "").replace(" ", "T"));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, (b - a) / 3600000);
}

/**
 * Hours since the last run that COMPLETED, or null when history is unreadable.
 *
 * A DAY WITH NO COMPLETED RUN IS A FAILURE, NOT AN UNKNOWN. That is the whole
 * point: pipeline_status held one overwritten row, so a run that died before
 * the record step left no trace and the next run buried the evidence. The
 * 2026-09-08 audit found 09-01 and 09-03 simply absent, with nothing to say
 * whether they failed or never fired -- and nothing had alerted either way.
 *
 * NULL, NOT ZERO, when the history cannot be read. "The table is unreachable"
 * and "the run happened this morning" must not look alike.
 */
export function hoursSinceCompletedRun(runs, now) {
  if (!Array.isArray(runs) || !runs.length) return null;
  const done = runs.filter(runCompleted).map(finishedAt).filter(Boolean).sort();
  if (done.length) return hoursBetween(done[done.length - 1], now);

  // ROWS EXIST AND NOT ONE OF THEM COMPLETED. The last good run is older than
  // anything in the window, so the span back to the OLDEST row is a floor on
  // how stale the data is -- an understatement, never an overstatement.
  const all = runs.map(finishedAt).filter(Boolean).sort();
  return all.length ? hoursBetween(all[0], now) : null;
}

/** "31 hours" / "2 days", for a sentence. */
export function staleFor(hours) {
  if (hours === null || hours === undefined) return null;
  if (hours < 48) return `${Math.round(hours)} hours`;
  const d = Math.round(hours / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}


export function evaluateTriggers({
  run = null,
  // Append-only history from pipeline_runs. An empty array means the
  // table was read and holds nothing, which is itself a finding; null
  // means it could not be read at all.
  runs = null,
  windows = [],
  items = [],
  owed = [],
  newExcellent = [],
  retro = null,
  // From boardAnomalies() in lib/boards.js. Null means the caller did not look,
  // which is NOT the same as "everything is fine" — the trigger below fires on
  // `!health.ok`, and a health object with `noData` set says so explicitly.
  health = null,
  // From consultingBanner() in lib/consulting.js.
  consulting = null,
  // Folded blocked-apply rows from db.blockedApplies(). Null means the caller
  // did not look, which is NOT the same as nothing being blocked -- the
  // trigger below stays silent on null rather than reporting a clear morning.
  blocked = null,
  // From grokStale() in lib/grok.js: how long since an apply log was
  // imported. Null means the caller did not look, which is NOT the same
  // as fresh -- see the weekly_retro block.
  grok = null,
  // { total, unknown } over open roles, for the truncation line. A zero total
  // means the count could not be read, and truncationLine() says so rather than
  // rendering nothing -- the difference between "all fine" and "did not look".
  blockerCounts = null,
  // From lib/neonusage.mjs: {bytes} when read, {error} when refused,
  // null when no key is configured. Three states, rendered differently.
  neon = null,
  // Watched-page news from db.watchedPageNews(). Null when the read failed,
  // which renders as a health line rather than as a quiet night -- "nothing
  // changed" and "we could not look" are different facts.
  pages = null,
  // { applications, messages, replies } from db.onTrackCounts(), each null
  // when unreadable. Never coerced to 0: that reads as a real month with
  // nothing in it.
  onTrack = null,
  // Today's five, from db.todaysFive(). Null when the read failed,
  // which is a health line rather than a quiet day.
  five = null,
  cfg = {},
  alreadyFired = new Set(),
  today = null,
  // THE INSTANT, not the date. Staleness is a duration, and a date cannot
  // measure one: two runs 25 hours apart and two runs 2 hours apart across
  // midnight are both "1 day". Defaults to midday on `today` so an existing
  // caller that passes only a date still gets a sane answer rather than NaN.
  nowIso = null,
  baseUrl = "",
} = {}) {
  const on = (k) => cfg?.triggers?.[k] !== false;
  const out = [];

  /* 0. WINDOW OPENED. Above everything, including a failed run.
   *
   *    A missed window costs a cycle and nothing recovers it -- McKinsey's
   *    2027 window closed on 11 August while companies.yaml said mid/late
   *    September, and Google APM's ran 28 days. A failed pipeline is
   *    recoverable by re-running the pipeline. "Irreversibility beats
   *    urgency" is already the rule that orders Daily; this is that rule
   *    applied to the digest. */
  const opened = (pages?.changed || []).filter((p) => p.last_status_hit);
  if (on("window_opened") && opened.length) {
    out.push({
      key: "window_opened",
      subject: opened.length === 1
        ? `WINDOW OPENED at ${opened[0].label}`
        : `WINDOW OPENED at ${opened.length} pages`,
      lines: opened.map(
        (p) => `WINDOW OPENED: ${p.label} now says applications are open. ${p.url}`),
    });
  }

  /* 0b. TODAY'S FIVE. Under a window opening and above everything else,
   *     because a person is the only thing here that answers back -- and the
   *     whole networking half exists because a referral routes around the two
   *     things that stop this profile. */
  if (on("todays_five") && five && five.length) {
    out.push({
      key: "todays_five",
      subject: `${five.length} to write to today`,
      lines: five.slice(0, 5).map(
        (p) => `${p.name}, ${p.title || "role not stated"} at `
             + `${p.company_label || p.company} -- ${p.rank_reason}`),
    });
  }

  /* 1a. A DAY PASSED WITH NO RUN THAT FINISHED.
   *
   *     Ranked with a failed run, because it IS one: the pipeline either did
   *     not fire, died before it could say so, or stopped partway. Today's
   *     roles, scores and counts are yesterday's in all three cases. Before
   *     the run history existed this was undetectable -- 09-01 and 09-03 are
   *     simply absent from the record and nothing alerted.
   *
   *     IT COUNTS COMPLETED RUNS, NOT ROWS. daily #21 was cancelled at the
   *     job timeout with scoring still blocked on a batch poll, and then
   *     recorded itself in one second -- a row that says a run happened and
   *     means nothing did. See runCompleted(). */
  const stale = hoursSinceCompletedRun(runs, nowIso || `${today}T12:00:00+00:00`);
  if (on("pipeline_failure") && stale !== null && stale >= STALE_RUN_HOURS) {
    const key = `missing_run:${today}`;
    if (!alreadyFired.has(key)) {
      out.push({
        key,
        group: "pipeline_failure",
        subject: `no completed run for ${staleFor(stale)}`,
        lines: [
          `The last pipeline run to finish every stage was ${staleFor(stale)} `
          + `ago, past the ${STALE_RUN_HOURS}-hour mark. That is a FAILURE, not `
          + "an unknown: the run either did not fire, died before it could "
          + "record itself, or stopped partway and recorded that.",
          "Today's roles, scores and counts are as stale as that gap.",
        ],
      });
    }
  }

  /* 1. THE RUN FAILED. Everything below is computed from data that did not
   *    refresh, so this leads and says so. */
  if (on("pipeline_failure") && run && run.status && run.status !== "success") {
    out.push({
      key: "pipeline_failure",
      subject: "yesterday's run failed",
      lines: [
        `The daily run finished as **${run.status}**. Today's roles, scores and `
        + "counts are yesterday's.",
        run.run_url ? `See why: ${run.run_url}` : "No run link was recorded.",
      ],
    });
  }

  /* 1b. A BOARD STOPPED ANSWERING. Directly under a failed run because it is
   *     the same category of problem seen through a narrower window: some of
   *     today's data is stale or missing while everything on screen still looks
   *     calm. fetch_jobs.py deliberately leaves that company's roles OPEN
   *     rather than closing them on silence, so the wrongness is invisible
   *     until somebody says it out loud. This is that somebody.
   *
   *     KEYED BY DAY AND BOARD, so a board that is broken for a week produces
   *     one line a day rather than one email per board per run — and a board
   *     that recovers simply stops appearing. */
  // THE TRANSFER FIGURE CAN FIRE ON ITS OWN.
  //
  // Riding only on board_anomaly would mean the allowance could run out in a
  // week where every board answered fine and the digest would never mention it
  // -- which is exactly what happened: it reached 100% at 11:57 pm on a day
  // when nothing else was wrong. A red transfer line is its own news.
  const transfer = transferLine(neon);
  if (on("board_anomaly") && transfer.red) {
    const key = `neon_transfer:${today}`;
    if (!alreadyFired.has(key)) {
      out.push({
        key,
        group: "board_anomaly",
        subject: "Neon transfer needs attention",
        lines: [transfer.line],
      });
    }
  }

  /* 1c. A WATCHER STOPPED WORKING.
   *
   *     watchedPageNews() has always computed `broken`, and nothing read it.
   *     So a page whose fetch had been failing for a week produced no line
   *     anywhere: the digest said "nothing changed", which is the reading a
   *     403 and a genuinely unchanged page share.
   *
   *     THESE ARE THE PAGES NOTHING ELSE CAN SEE. Consulting, the APM cohorts
   *     and the primes' rotational programmes run on Workday and custom sites
   *     with no machine-readable board, so they are structurally invisible to
   *     the fetcher and always will be. McKinsey's 2027 window closed on 11
   *     August while companies.yaml said mid/late September; nothing noticed,
   *     and that is a whole recruiting cycle. The watcher is the only thing
   *     standing between that happening again and it not.
   *
   *     A STREAK, NOT A BAD NIGHT. One failed fetch is a careers page having a
   *     moment; WATCHER_BROKEN_DAYS in a row is a watcher that has stopped
   *     working. Below the threshold it stays out of the digest, because a
   *     line that appears every time a site blips is one that gets skimmed.
   *
   *     Keyed by day and page, like the board anomaly above: one line a day
   *     while it is broken, and it stops appearing when the page recovers. */
  const brokenWatchers = (pages?.broken || [])
    .filter((p) => Number(p.fail_streak || 0) >= WATCHER_BROKEN_DAYS);
  if (on("board_anomaly") && brokenWatchers.length) {
    const key = `watcher_broken:${today}:`
      + brokenWatchers.map((p) => p.url).sort().join(",");
    if (!alreadyFired.has(key)) {
      out.push({
        key,
        group: "board_anomaly",
        subject: brokenWatchers.length === 1
          ? `a watched page has been unreadable for ${brokenWatchers[0].fail_streak} days`
          : `${brokenWatchers.length} watched pages are unreadable`,
        lines: [
          "These pages have no machine-readable board, so the watcher is the "
          + "ONLY thing that can tell you their window opened. While it is "
          + "failing, an opened window and a quiet one look identical.",
          ...brokenWatchers.slice(0, 6).map((p) =>
            `${p.label || p.url} — failing ${p.fail_streak} days: `
            + `${String(p.last_error || "").slice(0, 120)}`),
        ],
      });
    }
  }

  /* 1b-ii. A BOARD BROKEN FOR DAYS ESCALATES ONCE, THEN GOES QUIET.
   *
   *     The daily line is keyed by day, so a board that is broken stays broken
   *     and produces one line every morning forever. `ashby/mach` did exactly
   *     that: a slug that was never Mach's, flagged every day since the table
   *     was created, with no answer available except editing companies.yaml.
   *     "A nag you cannot answer is one you learn to skip" -- and a health
   *     section people skip is worse than none, because the morning a REAL
   *     board dies it looks identical to the wallpaper.
   *
   *     So after BOARD_ESCALATE_DAYS consecutive bad observations it says one
   *     distinct thing -- this needs a decision, here are the two decisions --
   *     and then stops mentioning that board entirely.
   *
   *     KEYED ON THE DAY THE OUTAGE STARTED, not on today and not on the board
   *     alone. Keyed on today it would escalate daily, which is the nag with a
   *     louder voice. Keyed on the board alone it would escalate once and never
   *     again, so a board that recovered and broke a month later would be
   *     silent. The start day changes when a board recovers and fails afresh,
   *     which is exactly when it should speak again.
   *
   *     empty_run is exempt: it is a statement about the whole run rather than
   *     one board, there is no per-board decision to take, and "every board
   *     returned nothing" must never be muted. */
  const persistent = (health?.anomalies || []).filter(
    (a) => a.kind !== "empty_run" && (a.brokenDays || 0) >= BOARD_ESCALATE_DAYS);
  for (const a of persistent) {
    const key = `board_escalation:${a.source}/${a.slug}:${a.brokenSince}`;
    if (on("board_anomaly") && !alreadyFired.has(key)) {
      out.push({
        key,
        group: "board_anomaly",
        subject: `${a.name} has been broken ${a.brokenDays} days — decide`,
        lines: [
          `**${a.name}** (${a.source}/${a.slug}) has failed every fetch since `
          + `${a.brokenSince}. It will not be mentioned again until it `
          + "recovers, because a warning that repeats forever is one you stop "
          + "reading.",
          a.line,
          `Two decisions, and only these two: fix the slug — `
          + `\`python fetch_jobs.py resolve ${a.name}\` reads the company's own `
          + "careers page for an ATS link rather than guessing — or retire it, "
          + "by adding a `retired:` reason to its entry in companies.yaml. "
          + "Retiring keeps the row and its reason so nobody re-adds the same "
          + "wrong slug on the assumption that nobody tried.",
        ],
      });
    }
  }

  // The daily line covers only boards that have NOT escalated. Without this
  // filter the escalation is an extra email rather than a replacement, and the
  // board it was written to silence keeps appearing underneath it.
  const fresh = (health?.anomalies || []).filter(
    (a) => !persistent.includes(a));

  if (on("board_anomaly") && health && !health.ok
      && (health.noData || fresh.length)) {
    const key = health.noData
      ? `board_anomaly:${today}:nodata`
      : `board_anomaly:${health.day}:`
        + fresh.map((a) => `${a.source || "-"}/${a.slug || "-"}`).sort().join(",");
    if (!alreadyFired.has(key)) {
      const n = fresh.length;
      out.push({
        key,
        group: "board_anomaly",
        // THE SUBJECT MUST MATCH WHAT ACTUALLY HAPPENED. "stopped answering" is
        // wrong for a never_worked board — it never started, and a subject line
        // that misdescribes the failure sends the owner looking for a regression
        // that does not exist. Only when EVERY anomaly is never_worked, so a
        // mixed run still reports the more urgent regression.
        subject: health.noData
          ? "no fetch was recorded"
          : (fresh[0]?.kind === "empty_run"
            ? "every board returned nothing"
            : fresh.every((a) => a.kind === "never_worked")
              ? `${plural(n, "board")} never returned a role`
              : `${plural(n, "board")} stopped answering`),
        // THE TRUNCATION LINE RIDES WITH PIPELINE HEALTH, because that is what
        // it is: a statement about how much of the corpus could actually be
        // read. the owner asked to see it every morning until it is fixed.
        lines: [...healthLines({ ...health, anomalies: fresh }),
                truncationLine(blockerCounts),
                transfer.red ? null : transfer.line].filter(Boolean),
      });
    }
  }

  /* 1c. PAGES THAT CHANGED. Below a board going silent, because a board that
   *     stopped answering means today's data is WRONG, while a page that
   *     changed is news to read. Pages that ALSO opened a window are excluded:
   *     they are already at the top, and repeating them makes the line that
   *     matters look like part of a list. */
  const moved = (pages?.changed || []).filter((p) => !p.last_status_hit);
  if (on("pages_changed") && moved.length) {
    out.push({
      key: "pages_changed",
      subject: `${moved.length} watched page${moved.length === 1 ? "" : "s"} changed`,
      lines: moved.slice(0, 6).flatMap((p) => [
        `${p.label} changed. ${p.url}`,
        // The diff, already capped at 5 KB and truncated loudly by
        // watch_pages.py. Eight lines each, so six pages cannot fill an email.
        ...(p.last_diff
          ? String(p.last_diff).split("\n").slice(0, 8).map((l) => `    ${l}`)
          : []),
      ]).concat(moved.length > 6
        ? [`    and ${moved.length - 6} more changed`] : []),
    });
  }

  /* 2. A WINDOW CLOSING WITH NOTHING SUBMITTED. Unrecoverable: miss it and the
   *    cycle is gone. Suppressed once something has been submitted against it —
   *    an email about a deadline he has already met is the definition of noise. */
  if (on("closing_window")) {
    const closing = windows
      .filter((w) => w.status === "open" && !w.applied)
      .map((w) => ({ w, step: windowStep(w.closeIn) }))
      .filter((x) => x.step !== null)
      .sort((a, b) => a.w.closeIn - b.w.closeIn
                   || String(a.w.firm).localeCompare(String(b.w.firm)));

    for (const { w, step } of closing) {
      const key = `closing_window:${w.firm}|${w.program}:${step}`;
      if (alreadyFired.has(key)) continue;
      out.push({
        key,
        group: "closing_window",
        subject: `${w.firm} closes ${inDays(w.closeIn)}`,
        lines: [
          `**${w.firm}** — ${w.program} — closes ${inDays(w.closeIn)}`
          + (w.confidence !== "verified" ? " (estimated — confirm it)" : "")
          + `. Nothing submitted yet. ${abs(baseUrl, "/forecast")}`,
        ],
      });
    }
  }

  /* 2b. THE THREE ROLLING CONSULTING WINDOWS. Open, not submitted, and
   *     structurally unable to fire the trigger above: closing_window needs a
   *     date to count down from, and these three carry a historical-estimate of
   *     30 September on windows whose own note says roles close as they fill.
   *     So the one trigger that would have caught them cannot, and they are the
   *     nearest live application path the owner has.
   *
   *     IT REPEATS UNTIL SUBMITTED, deliberately, and it is the only trigger
   *     here that does. That is defensible only because it has an ANSWER: mark
   *     the firm applied and it stops, permanently. A recurring prompt with no
   *     way to discharge it is a nag, and a nag you cannot answer is one you
   *     learn to skip — so the line says how to make it stop. */
  if (on("consulting_open") && consulting && consulting.red) {
    out.push({
      key: `consulting_open:${today}`,
      group: "consulting_open",
      subject: consulting.outstanding.length
        ? `${plural(consulting.outstanding.length, "consulting window")} open, nothing submitted`
        : "a consulting window could not be matched",
      lines: [
        ...consulting.lines,
        `Mark one applied and it stops appearing: ${abs(baseUrl, "/forecast")}`,
      ],
    });
  }

  /* 2c. AN APPLICATION THAT CANNOT BE SUBMITTED.
   *
   *     Directly under the windows, because the commonest shape of this IS a
   *     window: Deloitte's site has answered 406 since 8 September and the
   *     window closes on 30 September, so the closing_window line above is an
   *     instruction the owner cannot follow. Two halves of one fact, and they
   *     belong on the same screen of the same email.
   *
   *     THE COUNTDOWN IS THE POINT ON A WINDOW ROW. A blocked requisition sits
   *     there until the board drops it and costs a slot. A blocked window is a
   *     deadline running down while the block does not move -- the 406 had
   *     eaten three of Deloitte's nineteen remaining days before anything in
   *     this system could say so -- and without the days-remaining on the line
   *     it can expire while parked in the very section meant to prevent that.
   *
   *     IT REPEATS DAILY, like consulting_open and for the same reason: it has
   *     an answer. `python apply_blocks.py unblock <key>` ends it permanently,
   *     and the first line says so, because a recurring prompt with no way to
   *     discharge it is a nag and a nag you cannot answer is one you learn to
   *     skip.
   *
   *     NULL IS SILENCE, NOT A CLEAN MORNING. `blocked` is null when the
   *     caller could not read the table; an empty fold is the real "nothing is
   *     blocked". Reporting the first as the second is the always-empty-source
   *     failure this project has hit repeatedly -- and here it would hide the
   *     one section that says an application is impossible. */
  if (on("manual_apply") && blocked) {
    const byKey = new Map(windows.map((w) => [windowKey(w), w]));
    const entries = orderBlocked(blocked, (k) => byKey.get(k)?.closeIn ?? null);
    if (entries.length) {
      out.push({
        key: `manual_apply:${today}`,
        group: "manual_apply",
        subject: entries.length === 1
          ? "an application cannot be submitted"
          : `${entries.length} applications cannot be submitted`,
        // THE INSTRUCTION GOES FIRST, and that is a cap decision rather than a
        // stylistic one. orderSections caps this section at 10 LINES, so a
        // sentence at the bottom is the first thing truncated on the worst
        // morning -- the one where ten things are blocked and the way to
        // silence them matters most.
        lines: [
          `${plural(entries.length, "application")} cannot be submitted. `
          + "Lift one with `python apply_blocks.py unblock <key>`.",
          ...entries.map((e) => blockedLine(e, {
            closeIn: e.closeIn,
            closes: byKey.get(e.key)?.closes || null,
          })),
        ],
      });
    }
  }

  /* 3. SOMETHING WENT OVERDUE, or a follow-up came due. Recoverable, so it sits
   *    below the window — but it is the half of the tool that decides whether
   *    any of this is worth opening in December. */
  if (on("overdue")) {
    const wentOverdue = items.filter(
      (i) => !i.done && i.due_at && today && String(i.due_at) < today
             && i.dueIn !== null && i.dueIn >= -2);
    if (wentOverdue.length) {
      out.push({
        key: `overdue:${today}`,
        group: "overdue",
        subject: `${plural(wentOverdue.length, "task")} went overdue`,
        lines: wentOverdue.slice(0, 5).map(
          (i) => `**${i.title}** — was due ${i.due_at}. ${abs(baseUrl, "/#onyou")}`),
      });
    }
    if (owed.length) {
      out.push({
        key: `owed:${today}`,
        group: "overdue",
        subject: `${plural(owed.length, "follow-up")} owed`,
        lines: owed.slice(0, 5).map(
          (o) => `**${o.name}**${o.company ? ` at ${o.company}` : ""} — `
               + `${o.why || "a follow-up is due"}. ${abs(baseUrl, "/people")}`),
      });
    }
  }

  /* 4. A NEW EXCELLENT ROLE. The lowest-urgency trigger that is still news:
   *    nothing is lost by hearing about it tomorrow instead. */
  if (on("new_excellent") && newExcellent.length) {
    out.push({
      key: `new_excellent:${today}`,
      group: "new_excellent",
      subject: `${plural(newExcellent.length, "new Excellent role")}`,
      lines: newExcellent.slice(0, 5).map(
        (r) => `**${r.display_name || r.company}** — ${r.title}. `
             + `${abs(baseUrl, "/inbox")}`),
    });
  }

  /* 5. MONDAY. Not urgent by construction — it is a look backwards — so it is
   *    last, and it never sends an email on its own account... except that it
   *    does, once a week, because a retro nobody reads is a retro that does not
   *    exist. It is the one trigger whose value is the habit. */
  /*    THE APPLY LOG GOING QUIET RIDES HERE, as a line rather than a section.
   *
   *    `retro` is null on every day but Monday -- mondayRetro returns null
   *    outright -- so its presence IS the Monday signal, and nothing new had
   *    to be threaded through to get one.
   *
   *    THE FAILURE IT CATCHES IS SILENT BY CONSTRUCTION. If the owner stops
   *    pasting, or the bot stops producing a log, applied_apps simply stops
   *    growing, and a table that stops growing looks exactly like a table
   *    nobody has written to yet. Nothing else in this system can tell those
   *    apart, which is the project's own #1 failure class.
   *
   *    NEVER-IMPORTED IS NOT STALE. grokStale() reports that as its own state
   *    and this stays quiet about it: the page carries a setup line instead,
   *    and an alarm about a feature that has not been started yet is the kind
   *    of noise that teaches you to skim the section it lives in. */
  const grokLine = retro && grok && grok.stale
    ? `**The apply log has not been imported for ${Math.floor(grok.days)} days.** `
      + "Either nothing is being submitted, or the log has stopped arriving. "
      + `Those look identical from here. ${abs(baseUrl, "/applications")}`
    : null;

  if (on("weekly_retro") && retro && (!retro.empty || grokLine)) {
    out.push({
      key: `weekly_retro:${today}`,
      group: "weekly_retro",
      subject: retro.empty && grokLine
        ? "the apply log has gone quiet"
        : "last week in review",
      lines: [...(retro.lines || []), grokLine, abs(baseUrl, "/pulse")]
        .filter(Boolean),
    });
  }

  return out.sort(
    (a, b) => (TRIGGER_RANK[a.group || a.key] ?? 99) - (TRIGGER_RANK[b.group || b.key] ?? 99));
}

/**
 * The email, or null.
 *
 * PLAIN TEXT. No HTML, no images, no styling beyond `**bold**` — which most
 * clients render and the rest show as asterisks, which is legible. An email
 * that needs to load remote images to be readable is one that arrives broken in
 * half the places it lands, and this one has to be readable on a phone lock
 * screen at seven in the morning.
 */
/**
 * THE DIGEST'S SECTIONS, in order, with what each may show at most.
 *
 * The digest used to be every fired trigger concatenated by priority. That
 * was right about ORDER and silent about LENGTH -- a morning with nine new
 * roles, six packs and four drafts produced an email nobody finishes, and an
 * email nobody finishes is one where the line at the top stops being read.
 *
 * ORDER IS NOT PREFERENCE. WINDOW OPENED leads because a missed window costs
 * a cycle and nothing recovers it; a failed pipeline is recoverable by
 * re-running the pipeline. Health is last because it is the only section
 * that is always present, and a fixed thing at the top is a thing you learn
 * to scroll past.
 *
 * EVERY EMPTY SECTION IS OMITTED, except health. A heading with nothing
 * under it reads as a quiet day, and this project has three separate
 * incidents where 'nothing to show' and 'this has never worked' looked
 * identical on screen.
 */
export const SECTIONS = [
  // 1. Unrecoverable and time-critical. No cap: if two windows open on one
  //    morning, both are the point of the email.
  { key: "window_opened", cap: null },
  // Five is the cap by construction, and the query already limits it.
  { key: "todays_five", cap: 5 },
  // 2. The standing numbers. Rendered in the head rather than as a section,
  //    listed here so the order is stated in one place.
  { key: "__counter", cap: null, head: true },
  // 3. A dated window closing soon, and the pipeline failing, which says
  //    every number below it is yesterday's.
  { key: "pipeline_failure", cap: null },
  { key: "closing_window", cap: null },
  { key: "consulting_open", cap: null },
  // 3b. Applications that CANNOT be submitted. Directly under the windows,
  //     because the commonest shape of this is a blocked window — and a
  //     blocked window is a closing_window line whose instruction is
  //     impossible to follow. Reading them apart would be reading two halves
  //     of one fact on two different screens of the email.
  //
  //     CAPPED AT 10, well above the two this launched with. A blocked apply
  //     flow is rare by nature and stays until someone lifts it, so the cap is
  //     there to bound a bad month rather than to trim a normal one.
  { key: "manual_apply", cap: 10 },
  // 4. Pages that moved.
  { key: "pages_changed", cap: 6 },
  // 5-7. Things to act on. Capped, because these are the sections that grow
  //      without bound and push everything above them out of view.
  { key: "new_excellent", cap: 8 },
  { key: "overdue", cap: 5 },
  // 8. Weekly look back, Mondays only.
  { key: "weekly_retro", cap: null },
  // 9. Health, ALWAYS, and last. Boards, anomalies, Neon transfer, spend.
  { key: "board_anomaly", cap: null, always: true },
];

const SECTION_RANK = Object.fromEntries(
  SECTIONS.map((s, i) => [s.key, i]));
const SECTION_CAP = Object.fromEntries(SECTIONS.map((s) => [s.key, s.cap]));

/**
 * Order the fired triggers into the section order, and cap each one.
 *
 * A capped section says how many it left out. "and 4 more" is a different
 * fact from a section that happens to have six things in it, and the
 * difference decides whether the owner opens the app.
 */
export function orderSections(fired = []) {
  const bySection = new Map();
  for (const f of fired) {
    const k = f.group || f.key;
    // A key like `board_anomaly:2026-09-07:...` carries its own suffix; the
    // group is what the section is keyed on.
    const sec = SECTION_RANK[k] !== undefined ? k
      : Object.keys(SECTION_RANK).find((x) => String(k).startsWith(x));
    if (sec === undefined) continue;
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(f);
  }

  const out = [];
  for (const { key } of SECTIONS) {
    const group = bySection.get(key);
    if (!group || !group.length) continue;
    const cap = SECTION_CAP[key];
    const lines = group.flatMap((f) => f.lines || []);
    // EMPTINESS IS ABOUT LINES, NOT ABOUT TRIGGERS. A trigger that fired with
    // nothing to say still counted as a section, so the heading appeared over
    // nothing -- which reads as a quiet day rather than as a bug, the exact
    // confusion this project has hit on three separate surfaces.
    if (!lines.length) continue;
    if (cap != null && lines.length > cap) {
      const kept = lines.slice(0, cap);
      kept.push(`and ${lines.length - cap} more, in the app`);
      out.push({ key, lines: kept, subject: group[0].subject });
    } else {
      out.push({ key, lines, subject: group[0].subject });
    }
  }
  return out;
}


export function buildDigest({
  fired = [], cfg = {}, baseUrl = "", now = new Date(), counter = null,
  // The on-track line from lib/ontrack.js. Beside the counter, because the
  // two answer different questions: the counter says what the SEARCH did,
  // this says whether that is enough against a target the owner set.
  onTrack = null,
} = {}) {
  if (cfg?.enabled === false) return null;
  // A QUIET DAY SENDS NOTHING -- unless health is red.
  //
  // The rule that shapes this file is that a digest arriving whether or not
  // anything happened gets filtered to a folder inside a fortnight. The one
  // exception is a RED health line: the Neon allowance ran out at 11:57 pm on
  // a day when nothing else was wrong, every board answered, and by the
  // original rule no email would have gone at all.
  const healthRed = fired.some(
    (f) => String(f.group || f.key).startsWith("board_anomaly"));
  if (!fired.length && !healthRed) return null;
  if (!fired.length) return null;

  const lead = fired[0];
  const failure = fired.some((f) => (f.group || f.key) === "pipeline_failure");

  // SECTIONED AND CAPPED. The old version concatenated every fired trigger
  // in priority order, which was right about order and silent about length.
  const body = [];
  for (const sec of orderSections(fired)) {
    for (const l of sec.lines) body.push(`- ${l}`);
  }
  // A trigger that fired but belongs to no section would vanish silently.
  // That is the always-empty-source failure with an email attached, so it
  // is appended rather than dropped.
  const placed = new Set(orderSections(fired).map((s) => s.key));
  for (const f of fired) {
    const k = f.group || f.key;
    const known = [...placed].some((p) => String(k).startsWith(p));
    if (!known) for (const l of f.lines) body.push(`- ${l}`);
  }

  // THE COUNTER SITS ABOVE EVERYTHING, and it is not a trigger.
  //
  // Every other line in this email is something that FIRED -- a board broke, a
  // window is closing, a task went overdue. This one is unconditional, because
  // it is not news: it is the standing answer to "is the search actually
  // moving", and the whole reason it belongs at the top is that everything
  // below it measures what the pipeline found rather than what the owner did with
  // it. A number that only appears when it changes is one you never see.
  //
  // It does NOT fire a digest on its own. An email that arrives daily whether
  // or not anything happened is one that gets filtered, and then the one that
  // mattered lands in the same folder.
  const head = [];
  if (counter) head.push(submissionLine(counter));
  // NOT ITS OWN TRIGGER, for the same reason the counter is not: an email
  // that arrives daily whether or not anything happened is one that gets
  // filtered, and then the one that mattered lands in the same folder.
  if (onTrack?.line) head.push(onTrack.line);
  if (head.length) head.push("");

  return {
    kind: failure ? "failure" : "digest",
    subject: `JobOps: ${lead.subject}`,
    text: [
      ...head,
      ...body,
      "",
      "—",
      // The footer the brief asks for: how to change this. It names the FILE,
      // because that is where the switches are and there is no settings page —
      // saying "in settings" when there is no settings page is worse than
      // saying nothing.
      "Turn these off or change which ones fire in config.yaml, under "
      + "`notifications`. Sent once a day at most, and only when something "
      + "above actually happened.",
    ].join("\n"),
    firedKeys: fired.map((f) => f.key),
  };
}

/** The test email. Fixed text, so "did it arrive" has one obvious answer. */
export function buildTest(now = new Date()) {
  return {
    kind: "test",
    subject: "JobOps: test email",
    text: [
      "This is the test email. If you are reading it, delivery works.",
      "",
      `Sent ${now.toISOString().slice(0, 16).replace("T", " ")} UTC from the `
      + "GitHub Actions run, which is the only place this tool sends from.",
      "",
      "—",
      "Turn these off or change which ones fire in config.yaml, under "
      + "`notifications`.",
    ].join("\n"),
    firedKeys: ["test"],
  };
}
