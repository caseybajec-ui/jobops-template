/**
 * Send the daily digest. Called by the last step of daily.yml.
 *
 *   node lib/notify.mjs               # send if something fired
 *   node lib/notify.mjs --dry-run     # print what it would send, send nothing
 *   node lib/notify.mjs --test        # the fixed test email
 *   node lib/notify.mjs --force       # send even if one already went today
 *
 * FROM ACTIONS, NEVER FROM A REQUEST HANDLER. There is no route in this app
 * that sends mail and there must not be: a page render that can send email is
 * one bug away from sending a lot of it, and the whole safety of this feature
 * rests on the send path being somewhere a person deliberately triggers.
 *
 * ONE RECIPIENT, and it is a constant. This function takes no address, accepts
 * none, and test_notify.mjs asserts the address it uses is NOTIFY_TO. CLAUDE.md
 * rule 3 — the tool never sends to another human — stays true by construction.
 *
 * DRY RUN IS THE DEFAULT WHEN THERE IS NO KEY. Without RESEND_API_KEY it prints
 * the exact email and records the attempt as 'dry-run', which is a real outcome
 * and must never look like a send. That is how this was built and tested before
 * the account existed.
 */
import { all, one, run as exec, USING_PG } from "./driver.js";
import { NOTIFY_TO, NOTIFY_FROM_FALLBACK, USER_TZ } from "./constants.js";
import { daysFromToday } from "./day.js";
import { NOTIFY } from "./config.generated.js";
import { evaluateTriggers, buildDigest, buildTest } from "./notify.js";
import { grokStale } from "./grok.js";
import { GROK } from "./config.generated.js";
import { boardAnomalies } from "./boards.js";
import { neonTransfer } from "./neonusage.mjs";
import { onTrackLine } from "./ontrack.js";
import { consultingBanner } from "./consulting.js";
import { getDeadlines, applyChecks } from "./deadlines.js";
import { windowChecks, listItems, bandOf, groupKeyOf, watchedPageNews,
         onTrackCounts, todaysFive, blockedApplies } from "./db.js";
import { getPeople, pulseRows } from "./contacts.js";
import { owedFollowUps } from "./people.js";
import { computePulse, mondayRetro } from "./pulse.js";
import { windowsApplied, submissionSnapshot } from "./applications.js";
import { submissionCounts } from "./submissions.js";

const DRY = process.argv.includes("--dry-run") || !process.env.RESEND_API_KEY;
const TEST = process.argv.includes("--test");

/**
 * Send today's digest even though one has already gone. BY HAND ONLY.
 *
 * The once-a-day rule is right for the cron and stays the default: two identical
 * emails in a morning is how a JobOps email becomes something you filter. But it
 * also means that after the 07:10 run there is no way to send a corrected or
 * newly-interesting digest for the rest of the day, and the first time that
 * mattered was the day the board-anomaly flag started working — the finding
 * existed, the digest said it, and the guard refused to send it until tomorrow.
 *
 * It is a command-line flag and nothing else. daily.yml does not pass it and
 * must not: a scheduled run that can bypass the rate limit is the rate limit
 * removed. The run is recorded like any other, so a forced send is visible in
 * `notifications` afterwards rather than being invisible.
 */
const FORCE = process.argv.includes("--force");
/**
 * The deployed app's URL, from the JOBOPS_BASE_URL repository variable the
 * workflow maps. No default: the original hardcoded one person's hostname,
 * and a template with a default URL would email strangers links to his site.
 * Unset, every link in the digest is a relative path and the health line says
 * the variable is missing, which is a one-click fix and an honest message.
 */
const BASE = (process.env.JOBOPS_BASE_URL || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("notify: JOBOPS_BASE_URL is not set; digest links will be relative. "
    + "Add it as a repository variable (Settings -> Secrets and variables -> "
    + "Actions -> Variables) set to your Vercel URL.");
}

/**
 * WHO IT COMES FROM: config.yaml, baked at build time.
 *
 * Editable without touching code. The recipient is NOT — it is NOTIFY_TO, a
 * constant, and `send` below takes no address at all. The from line is a return
 * label; the to line is the rule.
 */
const FROM = NOTIFY.from || NOTIFY_FROM_FALLBACK;

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");
const today = new Date().toLocaleDateString("en-CA", { timeZone: USER_TZ });
const say = (s) => console.log(s);

/** Every trigger key already emailed. This is what makes the repeat rules work. */
async function alreadyFired() {
  try {
    const rows = await all("SELECT fired FROM notifications WHERE status <> ?", ["dry-run"]);
    const out = new Set();
    for (const r of rows) {
      try {
        for (const k of JSON.parse(r.fired || "[]")) out.add(k);
      } catch { /* a malformed row must not stop today's email */ }
    }
    return out;
  } catch {
    return new Set();
  }
}

async function record(kind, subject, firedKeys, status, detail) {
  try {
    await exec(
      `INSERT INTO notifications (id, day, kind, subject, fired, status, detail, sent_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [`nt:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
       today, kind, subject, JSON.stringify(firedKeys), status, detail || null, stamp()]);
  } catch (e) {
    say(`notify: could not record the send (${e.message}).`);
  }
}

/**
 * The one call that talks to Resend. `fetch`, not their SDK: this is a single
 * authenticated POST, and a dependency for it would be a package, its
 * transitive tree and its supply-chain surface for eleven lines.
 */
async function send({ subject, text }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    // `to` is the CONSTANT. Not a parameter, not a variable read from anywhere.
    // `from` comes from config.yaml; the recipient never does.
    body: JSON.stringify({ from: FROM, to: [NOTIFY_TO], subject, text }),
  });
  const body = await r.text();

  // ANY NON-2XX IS A FAILURE, AND THE WHOLE BODY IS PRINTED.
  //
  // Resend answered 403 for an unverified sender and this step reported green,
  // which is the third time something here has claimed success while doing
  // nothing — after the migration runner silently falling back to SQLite, and
  // this very script never having run at all. The body is where the reason
  // lives ("The domain is not verified", "You can only send testing emails to
  // your own address"), so it is printed in full rather than truncated to a
  // width that cuts the sentence in half.
  if (!r.ok) {
    const err = new Error(`Resend returned ${r.status} ${r.statusText}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body.slice(0, 200);
}

function preview(mail) {
  say("");
  say("─".repeat(68));
  say(`To:      ${NOTIFY_TO}`);
  say(`From:    ${FROM}`);
  say(`Subject: ${mail.subject}`);
  say("─".repeat(68));
  say(mail.text);
  say("─".repeat(68));
}

/* ------------------------------------------------------------------ run it */

say(`notify -> ${USING_PG ? "Neon Postgres" : "local SQLite"}`
  + `${DRY ? "  (DRY RUN — nothing will be sent)" : ""}`);

if (!NOTIFY.enabled && !TEST) {
  say("notify: notifications are off in config.yaml. Nothing sent.");
  process.exit(0);
}

let mail = null;
let fired = [];

if (TEST) {
  mail = buildTest();
} else {
  const [windows, items, people, applied, prevFired] = await Promise.all([
    applyChecks(getDeadlines(), await windowChecks()),
    listItems({ includeDone: false }).catch(() => []),
    getPeople().catch(() => ({ people: [] })),
    windowsApplied().catch(() => new Set()),
    alreadyFired(),
  ]);

  // NEW EXCELLENT ROLES SINCE THE LAST DIGEST. Measured against the last email
  // rather than against a fixed window: "new since you last heard from me" is
  // the only definition that cannot repeat itself or skip a day.
  const last = await one(
    "SELECT sent_at FROM notifications WHERE kind <> ? ORDER BY id DESC", ["test"])
    .catch(() => null);
  const since = last?.sent_at || null;
  let newExcellent = [];
  if (!since) {
    // THE FIRST RUN ESTABLISHES A BASELINE AND CLAIMS NOTHING.
    //
    // "New since the last digest" is undefined when there has been no digest,
    // and falling back to the beginning of time would announce every Excellent
    // role in the corpus as new — which is false, and false in the direction
    // that makes the first email the least trustworthy one he ever gets. Same
    // instinct as a window check with no date: record that you looked, do not
    // invent a finding.
    say("notify: no previous digest, so nothing counts as new yet. "
      + "This run sets the baseline.");
  } else {
    try {
      const rows = await all(
        `SELECT j.company, COALESCE(j.display_name, j.company) AS display_name,
                j.title, j.location, s.score
         FROM jobs j JOIN scores s ON s.key = j.key
         WHERE j.closed_at IS NULL AND j.entry_level IN ('program','entry')
           AND COALESCE(j.class_fit,'ok') <> 'wrong_year'
           AND j.first_seen > ?
         ORDER BY s.score DESC, j.key`,
        [since]);
      // GROUPED, like every other list in this app. A role posted in nine
      // cities is one role, and the first dry run listed Palantir's Build to
      // Apply twice because these came back ungrouped.
      const seen = new Set();
      for (const r of rows) {
        if (bandOf(r.score) !== "Excellent") continue;
        const k = groupKeyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
        newExcellent.push(r);
        if (newExcellent.length >= 5) break;
      }
    } catch { /* no scores yet is not a failure */ }
  }

  const { contacts, interactions } = await pulseRows();
  const pulse = computePulse({ interactions, contacts, tz: USER_TZ });

  // PIPELINE HEALTH. Fourteen days of board results is enough to tell a board
  // that answered with 0 today and 80 yesterday from one that has always been
  // small — which is the entire judgement boardAnomalies() makes.
  //
  // A FAILED READ IS NOT A CLEAN RESULT. If this query throws, `health` gets
  // the noData shape rather than null, so the digest says "no fetch was
  // recorded" instead of quietly reporting that all boards are fine. That
  // distinction is the whole point of the feature.
  let health = null;
  try {
    // daysFromToday, NOT toISOString(). A UTC date string is not the owner's
    // "today" — near midnight in Los Angeles they are different days, and
    // day.js is the one module allowed to answer that question. test_day.mjs
    // greps for exactly this mistake and caught it here.
    const since = daysFromToday(-14, new Date(), USER_TZ);
    const rows = await all(
      `SELECT day, source, slug, display_name, n_roles, error
       FROM board_fetches WHERE day >= ? ORDER BY day DESC`, [since]);
    health = boardAnomalies(rows);
  } catch (e) {
    say(`notify: could not read board_fetches (${e.message}). `
      + "Reporting that as missing data, not as healthy.");
    health = { day: null, boards: [], anomalies: [], totalRoles: 0, ok: false, noData: true };
  }

  // HOW MUCH OF THE CORPUS THE BLOCKER FLAG COULD NOT READ.
  //
  // the owner asked for this every morning until it is fixed, and he is right to:
  // storage_policy truncates every non-candidate description at 2,000
  // characters, and the requirements section almost always sits past the cut.
  // A blocker feature quietly working on a sixth of the corpus while reporting
  // nothing would be the exact silent failure it was built to catch.
  //
  // A FAILED READ REPORTS ZERO TOTAL, which truncationLine() renders as missing
  // data rather than as "nothing to report".
  let blockerCounts = { total: 0, unknown: 0 };
  try {
    const r = await one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN blockers IS NULL
                        OR (blockers = '[]' AND blockers_full_text <> 1)
                       THEN 1 ELSE 0 END) AS unknown
         FROM jobs WHERE closed_at IS NULL`);
    blockerCounts = { total: Number(r?.total || 0), unknown: Number(r?.unknown || 0) };
  } catch (e) {
    say(`notify: could not count blockers (${e.message}). `
      + "Reporting that as missing data, not as a clean result.");
  }

  // NEON'S OWN TRANSFER FIGURE. Not the estimate in transfer_budget.py, which
  // prices row payload and is explicitly not what Neon bills. Three distinct
  // states -- no key, refused, read -- and lib/transfer.js renders each.
  // WATCHED PAGES and the ON-TRACK COUNTS. Both fail to null rather than to
  // an empty result, because "nothing changed" and "we could not look" are
  // different nights and only one of them is good news.
  let pages = null;
  try {
    pages = await watchedPageNews();
  } catch (e) {
    say(`notify: could not read watched pages (${e.message}). `
      + "Reporting that as missing data, not as a quiet night.");
  }

  let five = null;
  try {
    five = await todaysFive(5);
  } catch (e) {
    say(`notify: could not read today's five (${e.message}). `
      + "Reporting that as missing data, not as nobody to write to.");
  }

  let onTrack = null;
  try {
    onTrack = onTrackLine(await onTrackCounts(), { now: new Date() });
  } catch (e) {
    say(`notify: could not compute the on-track line (${e.message}).`);
  }

  // APPLY FLOWS THAT ARE BLOCKED. Null on a failed read, never an empty fold:
  // "nothing is blocked" and "we could not look" are different mornings, and
  // only one of them is good news. _blockedApplies() already swallows a missing
  // TABLE — that is a migration that has not run and is genuinely "nothing
  // blocked yet" — so anything reaching this catch is the connection.
  let blocked = null;
  try {
    blocked = await blockedApplies();
  } catch (e) {
    say(`notify: could not read blocked applies (${e.message}). `
      + "Reporting that as missing data, not as nothing being blocked.");
  }

  let neon = null;
  try {
    neon = await neonTransfer();
  } catch (e) {
    neon = { error: `the usage read threw (${e.message})` };
  }

  const consulting = consultingBanner(windows, applied);

  // THE SUBMISSIONS COUNTER. From the same union every other application count
  // reads, so the digest and the dashboard cannot disagree about how many went
  // in. A failed read passes null, which submissionLine renders as missing data
  // rather than as a week with nothing in it.
  let counter = null;
  try {
    const snap = await submissionSnapshot();
    counter = submissionCounts({
      submissions: snap.submissions,
      interviews: snap.interviews,
      outstanding: consulting?.outstanding?.length || 0,
    });
  } catch (e) {
    say(`notify: could not count submissions (${e.message}). `
      + "Reporting that as missing data, not as a quiet week.");
  }

  fired = evaluateTriggers({
    run: await one("SELECT status, run_url FROM pipeline_status WHERE id = ?", ["last"])
      .catch(() => null),
    // THE HISTORY, for the missing-run alert. Null when it cannot be read,
    // which renders differently from an empty table: "unreachable" and "no
    // run has ever been recorded" are different findings.
    //
    // EVERY COLUMN runCompleted() AND hoursSinceCompletedRun() READ. The first
    // version selected only day and status, so `stages` arrived undefined,
    // runCompleted took its no-stages fallback, and the stage checking added
    // for daily #21 was inert in the one place it runs. Nothing failed: the
    // tests hand rows in directly, and a column that is not selected reads
    // exactly like a column that is null. test_notify.mjs greps this query
    // against what those two functions touch.
    runs: await all(
      "SELECT day, status, stages, finished_at FROM pipeline_runs "
      + "ORDER BY day DESC LIMIT 120")
      .catch(() => null),
    nowIso: new Date().toISOString(),
    // The apply log going quiet. Read here rather than inside
    // evaluateTriggers, which is pure and does no I/O.
    grok: grokStale(
      (await one("SELECT max(COALESCE(updated_at, created_at)) AS at "
                 + "FROM applied_apps WHERE source IN (?, ?)",
                 ["grok_paste", "bot_api"]).catch(() => null))?.at,
      new Date().toISOString(), GROK.staleDays),
    health,
    pages,
    onTrack,
    five,
    blockerCounts,
    neon,
    consulting,
    blocked,
    windows: windows.map((w) => ({
      ...w,
      applied: applied.has?.(`${w.firm}|${w.program}`) || false,
    })),
    items,
    owed: owedFollowUps(people.people || []),
    newExcellent,
    retro: mondayRetro(pulse, items, new Date(), USER_TZ),
    cfg: NOTIFY,
    alreadyFired: prevFired,
    today,
    baseUrl: BASE,
  });

  mail = buildDigest({ fired, cfg: NOTIFY, baseUrl: BASE, counter, onTrack });

  // ONE A DAY. A digest that already went today does not go again — but a
  // FAILURE does, because a run that fails twice is worth hearing about twice.
  //
  // A DRY RUN IS EXEMPT, because this rule exists to stop a second EMAIL and a
  // dry run does not send one. Without the exemption there is no way to see
  // what today's digest says once the morning's has gone — which is exactly
  // when you want to look, and it made "show me the anomaly in the digest"
  // impossible to answer on the day the anomaly appeared.
  if (mail && mail.kind === "digest" && !DRY && !FORCE) {
    const dupe = await one(
      "SELECT id FROM notifications WHERE day = ? AND kind = ? AND status <> ?",
      [today, "digest", "dry-run"]).catch(() => null);
    if (dupe) {
      say("notify: a digest already went today. Nothing sent.");
      process.exit(0);
    }
  }
}

if (!mail) {
  // THE COMMON CASE, and the feature rather than a gap in it. A daily email
  // that arrives whether or not anything happened is one you filter away, and
  // then the one that mattered goes to the same folder.
  say("notify: nothing fired today. No email — which is the point.");

  // BUT THE BASELINE STILL HAS TO EXIST. "New since the last digest" is
  // measured against the newest notification row, and a quiet first day writes
  // no row — so without this, `since` stays null forever and new_excellent can
  // never fire at all. The row records that the run happened and sent nothing,
  // which is exactly what it did.
  if (!TEST) {
    const any = await one("SELECT id FROM notifications WHERE kind <> ?", ["test"])
      .catch(() => null);
    if (!any) {
      await record("digest", null, [], "nothing-fired", "baseline; no email sent");
      say("notify: recorded a baseline, so tomorrow can tell what is new.");
    }
  }
  process.exit(0);
}

preview(mail);

if (DRY) {
  say(process.env.RESEND_API_KEY
    ? "notify: --dry-run, so nothing was sent."
    : "notify: RESEND_API_KEY is not set, so nothing was sent. The email above "
      + "is exactly what would go.");
  await record(mail.kind, mail.subject, mail.firedKeys, "dry-run", null);
  process.exit(0);
}

try {
  const detail = await send(mail);
  say(`notify: sent to ${NOTIFY_TO}.`);
  await record(mail.kind, mail.subject, mail.firedKeys, "sent", detail);
} catch (e) {
  // LOUD, AND RED. This used to exit 0 on the reasoning that a mail provider
  // having a bad afternoon should not redden an otherwise good fetch. That
  // reasoning was wrong, and a 403 reported as success is what proved it: a
  // step that claims to have sent an email it did not send is worse than a red
  // build, because the whole point of this system is telling the owner when
  // something is broken.
  //
  // THE BODY IS PRINTED IN FULL. Resend puts the actual reason there and it is
  // the only thing that distinguishes "domain not verified" from "wrong key"
  // from "you may only send to your own address".
  say("");
  say(`notify: FAILED to send — ${e.message}`);
  if (e.body) {
    say("notify: the provider said:");
    say(e.body);
  }
  say("");
  say(`notify: nothing was delivered to ${NOTIFY_TO}. This step is failing on`);
  say("        purpose — a green step that sent no email is the bug this");
  say("        exists to prevent.");
  await record(mail.kind, mail.subject, mail.firedKeys, "failed",
               `${e.message} ${e.body || ""}`.slice(0, 900));
  // exitCode, NOT process.exit(). Calling process.exit() while undici still
  // holds the response socket crashes libuv on Windows —
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — and the shell
  // then reports 127 rather than 1. A failure path that itself fails in a
  // confusing way is barely better than one that stays silent.
  //
  // Setting exitCode lets the loop drain and exit cleanly with the right code.
  process.exitCode = 1;
}
