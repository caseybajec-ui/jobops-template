/**
 * The zero-jobs anomaly flag, the consulting banner, and the outreach queue.
 * Run: node test_boards.mjs
 *
 * WHAT THIS GUARDS. Three features whose failure mode is silence: a board that
 * stops answering, three consulting windows that no countdown can reach, and a
 * queue that reads as empty when it is actually broken. Every one of them, done
 * wrong, produces a calm green screen — which is this project's #1 failure
 * class and the reason each assertion below is paired with a mutation showing
 * it can go red.
 *
 * THE MUTATIONS ARE THE POINT. An assertion that has only ever passed is
 * indistinguishable from one that cannot fail — the clearance rule passed for
 * weeks while matching nothing at all. So each section ends by feeding the
 * function the input the rule exists to reject, and requiring the verdict to
 * flip.
 */
import {
  boardAnomalies, healthLines, ANOMALY_RANK, NEVER_WORKED_DAYS,
  badStreak,
} from "./lib/boards.js";
import { consultingBanner, FIRMS } from "./lib/consulting.js";
import { OWNER, ROLLING_FIRMS } from "./lib/config.generated.js";
import { outreachQueue, queueLines, QUEUE_BANDS } from "./lib/outreachQueue.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OUTREACH_PINS, SEARCH_AS, TRANSFER_ALLOWANCE_BYTES,
         TRANSFER_WARN_AT } from "./lib/config.generated.js";
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
import { schoolPeopleSearchUrl, SCHOOL_SEARCH_PREFIX } from "./lib/constants.js";
import {
  verdictOf, chipsOf, tagsOf, hardTags, truncationLine, HARD, SOFT, EXPLAIN,
} from "./lib/blockers.js";
import { transferLine, ALLOWANCE_BYTES, WARN_AT } from "./lib/transfer.js";
import { evaluateTriggers, TRIGGERS, TRIGGER_RANK } from "./lib/notify.js";
import { bandOf } from "./lib/display.js";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

const row = (day, slug, n, error = null, source = "ashby") =>
  ({ day, source, slug, display_name: slug, n_roles: n, error });

/* ===================== 1. THE ZERO-JOBS ANOMALY ========================== */

/* A board that used to list roles and now lists none. THE CASE THE WHOLE
 * FEATURE EXISTS FOR: it answered cleanly, so nothing errored, and the run was
 * green. */
{
  const h = boardAnomalies([
    row("2026-09-04", "elevenlabs", 252),
    row("2026-09-05", "elevenlabs", 0),
    row("2026-09-05", "exa", 55),
  ]);
  eq(h.anomalies.length, 1, "a board that went from 252 to 0 is flagged");
  eq(h.anomalies[0].kind, "zeroed", "and is flagged as zeroed, not as an error");
  eq(h.anomalies[0].was, 252, "the line carries what it used to list");
  ok(/discover/.test(h.anomalies[0].line),
     "and tells you the command that diagnoses it");
  ok(h.ok === false, "the run is not ok");
}

/* A SMALL BOARD THAT HAS ALWAYS BEEN SMALL IS NOT AN ANOMALY. Judgment Labs
 * lists 5 roles; a company can legitimately have none. Without history, zero
 * says nothing — which is why history is what is stored. */
{
  // A healthy board alongside it, so the run total is non-zero and the
  // empty_run backstop stays out of the way — otherwise this case cannot
  // isolate the rule it is testing. (The first version of this test asserted
  // zero anomalies against a corpus of nothing but empty boards and failed on
  // empty_run, correctly.)
  const h = boardAnomalies([
    row("2026-09-04", "judgmentlabs", 0),
    row("2026-09-05", "judgmentlabs", 0),
    row("2026-09-05", "exa", 55),
  ]);
  eq(h.anomalies.map((a) => a.kind), ["never_worked"],
     "it is NOT 'zeroed' — there is no history to have regressed from");

  // THIS ASSERTION USED TO READ "is not flagged", AND THAT WAS THE BUG.
  // `zeroed` compares a board against its own past, so a board with no past
  // cannot trip it — which means a slug that was wrong the day it was added is
  // invisible by construction. ashby/mach did exactly this on the first real
  // run: clean 0, no history, no rule matched, digest said "No anomalies."
  // Silence is the one thing this module must never produce.
  ok(h.ok === false, "a board that has NEVER returned a role is not a clean bill of health");
}

/* THE ashby/mach SHAPE, EXACTLY AS IT CAME OUT OF THE FIRST FETCH: a clean zero,
 * no error, and no history at all because the table was created that morning. */
{
  const h = boardAnomalies([
    row("2026-09-06", "mach", 0),
    row("2026-09-06", "elevenlabs", 252),
  ]);
  eq(h.anomalies.map((a) => a.kind), ["never_worked"], "day-one empty board is flagged");
  eq(h.anomalies[0].slug, "mach", "and it names the board");
  eq(h.anomalies[0].emptyFor, 0, "empty for 0 days — it counts UP from when it appeared");
  ok(/first run/.test(h.anomalies[0].line),
     "and says 'first run' rather than inventing an elapsed period");
  ok(/cannot tell those apart/.test(h.anomalies[0].line),
     "and does NOT claim to know whether the slug is wrong — the data cannot say");
  eq(h.neverWorked, 1, "the count is carried separately from the anomaly");
}

/* IT COUNTS UP AS THE DAYS PASS. "2 days overdue, never touched" is the honest
 * reading; a countdown would imply a deadline that does not exist. */
{
  const h = boardAnomalies([
    row("2026-09-01", "mach", 0),
    row("2026-09-06", "mach", 0),
    row("2026-09-06", "elevenlabs", 252),
  ]);
  eq(h.anomalies[0].emptyFor, 5, "five days since it first appeared");
  ok(/5 days since it was added/.test(h.anomalies[0].line), "and the line says so");
}

/* AFTER THE FORTNIGHT IT STOPS NAGGING — but the COUNT does not stop. A nag you
 * cannot answer is one you learn to skip, and the only answer here is checking
 * the slug by hand. Bounding the nagging must not bound the fact. */
{
  const h = boardAnomalies([
    row("2026-08-01", "mach", 0),
    row("2026-09-06", "mach", 0),
    row("2026-09-06", "elevenlabs", 252),
  ]);
  eq(h.anomalies.length, 0, "past the window it is no longer flagged as an anomaly");
  ok(h.ok === true, "so it does not hold the run red forever");
  eq(h.neverWorked, 1, "but it is STILL counted");
  const line = healthLines(h)[0];
  ok(/1 board has never returned a role/.test(line),
     "and the count rides on the head line even when nothing is flagged");
}

/* THE BOUNDARY IS INCLUSIVE AND IS THE CONSTANT, not a number typed twice. */
{
  const at = (d) => boardAnomalies([
    row("2026-09-06", "mach", 0), row("2026-09-06", "ok", 9),
    { day: d, source: "ashby", slug: "mach", display_name: "mach", n_roles: 0, error: null },
  ]).anomalies.length;
  const day0 = new Date(Date.UTC(2026, 8, 6) - NEVER_WORKED_DAYS * 86400000)
    .toISOString().slice(0, 10);
  const day1 = new Date(Date.UTC(2026, 8, 6) - (NEVER_WORKED_DAYS + 1) * 86400000)
    .toISOString().slice(0, 10);
  eq(at(day0), 1, `exactly ${NEVER_WORKED_DAYS} days old is still reported`);
  eq(at(day1), 0, `${NEVER_WORKED_DAYS + 1} days old is not`);
}

/* AN ERRORING BOARD IS NOT "NEVER WORKED". It gave no information at all, which
 * is a different thing from answering with nothing, and it has its own kind. */
{
  const h = boardAnomalies([
    row("2026-09-06", "mach", null, "HTTP 500"),
    row("2026-09-06", "elevenlabs", 252),
  ]);
  eq(h.anomalies.map((a) => a.kind), ["error"], "an error is an error, not never_worked");
  eq(h.neverWorked, 0, "and an errored board is not counted as never having worked");
}

/* A BOARD THAT RECOVERS DROPS OUT ENTIRELY. */
{
  const h = boardAnomalies([
    row("2026-09-05", "mach", 0),
    row("2026-09-06", "mach", 7),
  ]);
  eq(h.anomalies.length, 0, "a board that starts answering is no longer flagged");
  eq(h.neverWorked, 0, "and no longer counted");
}

/* ...but a run where every board came back empty IS flagged, even when no
 * single board is individually suspicious. The backstop and the per-board rule
 * are different rules and both have to be live. */
{
  const h = boardAnomalies([
    row("2026-09-04", "judgmentlabs", 0),
    row("2026-09-05", "judgmentlabs", 0),
  ]);
  eq(h.anomalies.map((a) => a.kind), ["empty_run", "never_worked"],
     "the backstop fires FIRST, and the per-board rule fires beside it");
  ok(h.ok === false, "and is not ok");
}

/* AN ERROR AND A ZERO ARE DIFFERENT THINGS and must stay different: a board
 * that threw gave no information, and fetch_jobs.py deliberately leaves its
 * roles OPEN rather than closing them on silence. */
{
  const h = boardAnomalies([
    row("2026-09-04", "anduril", 2200, null, "greenhouse"),
    row("2026-09-05", "anduril", null, "HTTP 500 — check slug with `discover`", "greenhouse"),
    row("2026-09-05", "exa", 55),
  ]);
  eq(h.anomalies[0].kind, "error", "a failed fetch is an error, not a zero");
  ok(/left open rather than closed/.test(h.anomalies[0].line),
     "and says the roles were not closed on silence");
  ok(ANOMALY_RANK.error < ANOMALY_RANK.zeroed,
     "an error outranks a zero: it carries strictly less information");
}

/* EVERY BOARD RETURNING NOTHING IS ITS OWN, LOUDER FINDING. Each board looks
 * like one ordinary failure; the run as a whole is a catastrophe. */
{
  const h = boardAnomalies([
    row("2026-09-04", "exa", 55),
    row("2026-09-05", "exa", 0),
    row("2026-09-05", "elevenlabs", 0),
  ]);
  eq(h.anomalies[0].kind, "empty_run", "an empty run leads the list");
  eq(h.totalRoles, 0, "and the total is zero");
  ok(ANOMALY_RANK.empty_run < ANOMALY_RANK.error, "and outranks a single error");
}

/* NO ROWS IS NOT A CLEAN BILL OF HEALTH. This is the exact green-on-nothing the
 * project keeps rediscovering: a verification tool pointed at nothing must not
 * print what it prints when everything is fine. */
{
  const h = boardAnomalies([]);
  ok(h.noData === true, "an empty table reports noData");
  ok(h.ok === false, "and is NOT reported as healthy");
  ok(/not a clean bill of health/.test(healthLines(h).join(" ")),
     "and the digest line says so in those words");
}

/* THE HEALTHY CASE STILL STATES THE COUNT, so a later drop is legible. A health
 * report you only see when it is bad cannot be sanity-checked when it is good. */
{
  const h = boardAnomalies([row("2026-09-05", "exa", 55), row("2026-09-05", "docker", 62)]);
  ok(h.ok === true, "two healthy boards are ok");
  const line = healthLines(h).join(" ");
  ok(/2 boards polled/.test(line), "and the line names the board count");
  ok(/117 roles/.test(line), "and the role total");
}

/* MUTATION: if the zeroed rule stopped consulting history, a board that has
 * always been empty would be flagged and the "small board" case above would go
 * red. Prove the rule is live by removing the history it depends on. */
{
  const withHistory = boardAnomalies([
    row("2026-09-04", "semgrep", 9), row("2026-09-05", "semgrep", 0),
  ]);
  const noHistory = boardAnomalies([row("2026-09-05", "semgrep", 0)]);
  ok(withHistory.anomalies.some((a) => a.kind === "zeroed"),
     "MUTATION: with history, a 9 -> 0 board IS flagged");
  ok(!noHistory.anomalies.some((a) => a.kind === "zeroed"),
     "MUTATION: without history, the same zero is NOT flagged — the rule reads history");
}

/* ===================== 2. THE ANOMALY REACHES THE EMAIL =================== */

/* THE mach CASE, ALL THE WAY TO A SUBJECT LINE. The rule passing in isolation
 * is not the point — the owner reads this in an inbox, so the trigger has to fire
 * and the subject has to describe what actually happened. */
{
  const health = boardAnomalies([
    row("2026-09-06", "mach", 0), row("2026-09-06", "elevenlabs", 252),
  ]);
  const fired = evaluateTriggers({ health, today: "2026-09-06", cfg: {} });
  const hit = fired.find((f) => f.group === "board_anomaly");
  ok(hit, "a board that has never returned a role fires the digest trigger");

  // "stopped answering" would be a LIE about this board: it never started, and
  // a subject that misdescribes the failure sends him hunting a regression that
  // does not exist.
  ok(/never returned a role/.test(hit.subject),
     `subject describes it accurately, got ${JSON.stringify(hit.subject)}`);
  ok(!/stopped answering/.test(hit.subject),
     "and does NOT say 'stopped answering'");
  ok(hit.lines.join(" ").includes("mach"), "and the body names the board");
}

/* A MIXED RUN STILL REPORTS THE REGRESSION, which is the more urgent of the
 * two. The accurate-wording rule must not swallow a real breakage. */
{
  const health = boardAnomalies([
    row("2026-09-05", "elevenlabs", 252),
    row("2026-09-06", "elevenlabs", 0),
    row("2026-09-06", "mach", 0),
    // A healthy board, so the run total is non-zero and the empty_run backstop
    // stays out of the way. Without it this fixture is an all-empty run, which
    // the backstop correctly reports instead — as the first version did.
    row("2026-09-06", "exa", 55),
  ]);
  const hit = evaluateTriggers({ health, today: "2026-09-06", cfg: {} })
    .find((f) => f.group === "board_anomaly");
  ok(/stopped answering/.test(hit.subject),
     `a mixed run reports the regression, got ${JSON.stringify(hit.subject)}`);
}

{
  const health = boardAnomalies([
    row("2026-09-04", "elevenlabs", 252), row("2026-09-05", "elevenlabs", 0),
    row("2026-09-05", "exa", 55),
  ]);
  const fired = evaluateTriggers({ health, today: "2026-09-05", cfg: {} });
  ok(fired.some((f) => f.group === "board_anomaly"),
     "a board anomaly fires a trigger");
  ok(TRIGGER_RANK.board_anomaly < TRIGGER_RANK.closing_window,
     "and outranks a closing window: it says the data under the window may be wrong");
  ok(TRIGGER_RANK.pipeline_failure < TRIGGER_RANK.board_anomaly,
     "but not an outright failed run");

  /* IT DOES NOT REPEAT. A board broken for a week is one line a day, not one
   * email per board per run. */
  const key = fired.find((f) => f.group === "board_anomaly").key;
  const again = evaluateTriggers({
    health, today: "2026-09-05", cfg: {}, alreadyFired: new Set([key]),
  });
  ok(!again.some((f) => f.group === "board_anomaly"),
     "and does not fire twice for the same boards on the same day");

  /* MUTATION: switched off in config, it must not fire. */
  const off = evaluateTriggers({
    health, today: "2026-09-05", cfg: { triggers: { board_anomaly: false } },
  });
  ok(!off.some((f) => f.group === "board_anomaly"),
     "MUTATION: board_anomaly: false in config silences it");
}

/* A HEALTHY RUN SENDS NOTHING. The rule that shapes the whole digest. */
{
  const health = boardAnomalies([row("2026-09-05", "exa", 55)]);
  const fired = evaluateTriggers({ health, today: "2026-09-05", cfg: {} });
  ok(!fired.some((f) => f.group === "board_anomaly"),
     "a healthy fetch fires nothing");
}

/* NULL HEALTH IS NOT HEALTHY — it means nobody looked. It must not fire (there
 * is nothing to report) but it must also never be produced by the sender: the
 * sender substitutes the noData shape on a failed read, and that DOES fire. */
{
  const fired = evaluateTriggers({ health: null, today: "2026-09-05", cfg: {} });
  ok(!fired.some((f) => f.group === "board_anomaly"),
     "a null health object fires nothing (the caller did not look)");
  const noData = evaluateTriggers({
    health: boardAnomalies([]), today: "2026-09-05", cfg: {},
  });
  ok(noData.some((f) => f.group === "board_anomaly"),
     "but the noData shape DOES fire — a failed read is a finding");
}

/* ===================== 3. THE CONSULTING BANNER =========================== */

const W = (firm, extra = {}) => ({
  firm, program: "Consulting, undergraduate", status: "open",
  closes: "2026-09-30", confidence: "historical-estimate", ...extra,
});

// THE FIRMS COME FROM companies.yaml (`rolling: true`), baked as
// ROLLING_FIRMS. The banner takes the list as an argument so this suite can
// fix it rather than depend on whatever the shipped yaml happens to flag --
// but the default is asserted to BE the baked list, or the page would watch
// a different set from the one the yaml names.
eq(FIRMS, ROLLING_FIRMS, "the default firm list is the baked rolling: true set");
ok(Array.isArray(FIRMS), "and it is a list even when nothing is flagged");
const THREE = ["Accenture", "Deloitte", "EY-Parthenon"];
const banner = (windows, applied) => consultingBanner(windows, applied, THREE);
const ALL_THREE = THREE.map((f) => W(f));

{
  const b = banner(ALL_THREE, new Set());
  eq(b.outstanding.length, 3, "all three consulting firms are outstanding");
  eq(b.missing.length, 0, "and all three matched a window");
  ok(b.red === true, "so the banner is red");
  ok(/ROLLING|rolling/.test(b.lines.join(" ")),
     "and says ROLLING rather than counting down to an estimated date");
  ok(!/\d+ days/.test(b.lines.join(" ")),
     "NO COUNTDOWN: their close date is an estimate, and a countdown would "
     + "render it with the authority of a date the firm actually set");
}

/* SUBMITTING ONE REMOVES IT. This is what makes the banner answerable rather
 * than a nag: it has an end state, reachable in one click. */
{
  const b = banner(ALL_THREE, new Set(["Deloitte|Consulting, undergraduate"]));
  eq(b.outstanding.map((w) => w.firm), ["Accenture", "EY-Parthenon"],
     "a submitted firm drops out of outstanding");
  eq(b.submitted.map((w) => w.firm), ["Deloitte"], "and is counted as done");
  ok(b.red === true, "the banner stays red while two remain");
}

/* ALL THREE SUBMITTED TURNS IT OFF FOR GOOD. */
{
  const b = banner(
    ALL_THREE, new Set(THREE.map((f) => `${f}|Consulting, undergraduate`)));
  eq(b.outstanding.length, 0, "nothing outstanding once all three are in");
  ok(b.red === false, "and the banner goes away — the prompt has an end state");
}

/* A CLOSED WINDOW IS NOT OUTSTANDING. The banner must never tell him to apply
 * to something that has shut. */
{
  const b = banner(
    [W("Accenture", { status: "closed" }), W("Deloitte"), W("EY-Parthenon")],
    new Set());
  eq(b.outstanding.map((w) => w.firm), ["Deloitte", "EY-Parthenon"],
     "a closed window is not outstanding");
}

/* A NAMED FIRM THAT MATCHES NOTHING IS REPORTED, NEVER SWALLOWED. A banner
 * keyed on a string it can no longer find would render nothing and look like
 * it worked — an always-empty source and an always-zero count are the same bug. */
{
  const b = banner([W("Deloitte"), W("EY-Parthenon")], new Set());
  eq(b.missing, ["Accenture"], "a firm with no matching window is reported missing");
  ok(b.red === true, "and keeps the banner red: missing data is not a clear result");
  ok(/companies\.yaml/.test(b.lines.join(" ")),
     "and the line names the file to fix");
}

/* MUTATION: an empty window list must NOT read as "nothing to do". */
{
  const b = banner([], new Set());
  eq(b.missing.length, 3, "MUTATION: with no windows at all, all three are missing");
  // And with NO firms flagged at all the banner is simply absent: an empty
  // list is a legitimate state for a template, not a broken one.
  const none = consultingBanner(ALL_THREE, new Set(), []);
  ok(none.red === false && none.missing.length === 0 && none.outstanding.length === 0,
     "with no rolling firms flagged the banner renders nothing and is not red");
  ok(b.red === true, "MUTATION: and the banner is red rather than silent");
}

/* THE PLANNING-TARGET DISTINCTION. A planning-target is a date THE OWNER set for a
 * firm that has published nothing — it is not a company deadline and must never
 * be rendered as one. The banner only ever considers the three named firms, so
 * a planning-target row cannot reach it however it is shaped. */
{
  const b = banner([
    ...ALL_THREE,
    { firm: "ZS Associates", program: "Associate", status: "unconfirmed",
      confidence: "planning-target", target: "2026-10-15" },
  ], new Set());
  ok(!b.outstanding.some((w) => w.firm === "ZS Associates"),
     "a planning-target firm never enters the consulting banner");
  ok(!b.lines.join(" ").includes("ZS Associates"),
     "and is never named in its lines");
}

/* AND IT REACHES THE EMAIL, with the same end state. */
{
  const consulting = banner(ALL_THREE, new Set());
  const fired = evaluateTriggers({ consulting, today: "2026-09-05", cfg: {} });
  const t = fired.find((f) => f.group === "consulting_open");
  ok(!!t, "the consulting banner fires a digest trigger");
  ok(/Mark one applied/.test(t.lines.join(" ")),
     "and the email says how to make it stop — a prompt with no answer is a nag");
  ok(TRIGGER_RANK.consulting_open > TRIGGER_RANK.closing_window,
     "it sits below dated windows: it is a standing reminder, not news");
  ok(TRIGGER_RANK.consulting_open < TRIGGER_RANK.overdue,
     "and above overdue tasks: it is the nearest live application path");

  const done = evaluateTriggers({
    consulting: banner(
      ALL_THREE, new Set(THREE.map((f) => `${f}|Consulting, undergraduate`))),
    today: "2026-09-05", cfg: {},
  });
  ok(!done.some((f) => f.group === "consulting_open"),
     "MUTATION: with all three submitted the trigger stops firing");
}

/* ===================== 4. THE OUTREACH QUEUE ============================== */

const C = (name, extra = {}) => ({
  name, display_name: name, contacts: 0, best: 75, bestTitle: "Product Ops",
  bestKey: `k:${name}`, reachable40: 3, n2027: 0, ...extra,
});

{
  const q = outreachQueue([
    C("alpha", { best: 92, n2027: 2 }),
    C("beta", { best: 75 }),
    C("gamma", { best: 20 }),             // Weak — below the floor
    C("delta", { contacts: 2 }),          // already has both names
    C("epsilon", { best: null }),         // no reachable role
  ], bandOf);
  eq(q.map((r) => r.name), ["alpha", "beta"], "only companies needing a name, best first");
  eq(q[0].needed, 2, "and each says how many names are still wanted");
  ok(QUEUE_BANDS.has(q[0].band), "every queued company is in a queued band");
}

/* A COMPANY AT THE TARGET DROPS OUT. This is what makes the queue FINITE — a
 * queue that refills itself occupies whatever slot it holds forever. */
{
  const before = outreachQueue([C("alpha")], bandOf);
  const after = outreachQueue([C("alpha", { contacts: 2 })], bandOf);
  eq(before.length, 1, "MUTATION: a company with 0 names is queued");
  eq(after.length, 0, "MUTATION: the same company with 2 names is not — the queue ends");
}

/* BEST REACHABLE, NOT BEST OVERALL. A company whose only strong role is one
 * the owner cannot take is not an outreach target — the same two-numbers-one-row
 * mistake that made Stripe read "Good" against a role they cannot take. */
{
  const q = outreachQueue([C("zeta", { best: null, bestAny: 99 })], bandOf);
  eq(q.length, 0, "a company with no REACHABLE role is not queued");
}

/* CLASS-YEAR-DATED ROLES RANK FIRST. They are the ones the owner can actually start. */
{
  const q = outreachQueue([
    C("noyear", { best: 95, reachable40: 9 }),
    C("has2027", { best: 62, reachable40: 1, n2027: 1 }),
  ], bandOf);
  eq(q[0].name, "has2027",
     "a class-year-dated role outranks a higher-scoring one with no start window");
}

/* THE SORT ENDS IN SOMETHING UNIQUE. Three separate reshuffling bugs in this
 * project came from a comparator that could return 0 for two distinct rows. */
{
  const tied = ["c", "a", "b"].map((n) => C(n));
  const once = outreachQueue(tied, bandOf).map((r) => r.name);
  const twice = outreachQueue([...tied].reverse(), bandOf).map((r) => r.name);
  eq(once, twice, "identical companies sort identically whatever order they arrive in");
  eq(once, ["a", "b", "c"], "and the tie-break is the slug");
}

/* THE DIGEST TAKES THREE. The email is a prompt, not the page. */
{
  const q = outreachQueue(
    ["a", "b", "c", "d", "e"].map((n) => C(n)), bandOf);
  eq(queueLines(q, "https://x.test").length, 3, "the digest lists three, not the queue");
  ok(/\/outreach/.test(queueLines(q, "https://x.test")[0]),
     "and links to the page that has the rest");
}

/* ============ 4b. A PIN IS A DECISION, AND IT IS NOT A SCORE ============= */

/* THE CASE THAT FORCED THE FEATURE. Mistral's best scored role is 28/skip, so
 * nothing derived from the corpus would ever queue it, and the company is still
 * worth a relationship: seventeen Deployment Strategist reqs, one in Palo Alto.
 * A pin is how a human says that, and the ONLY thing that can. */
{
  const pins = { mistral: "17 DS reqs, one in Palo Alto" };
  const bare = outreachQueue([C("mistral", { best: 28 })], bandOf);
  eq(bare.length, 0, "without a pin, a company below the band floor is not queued");

  const q = outreachQueue([C("mistral", { best: 28 })], bandOf, { pins });
  eq(q.length, 1, "a pin queues a company the scorer skipped");
  ok(q[0].pinned, "and the row says it was pinned");
  eq(q[0].pinReason, pins.mistral, "and carries the reason, so the pin cannot go unexplained");
}

/* A PIN ALSO WORKS WHEN THERE IS NO REACHABLE ROLE AT ALL, which is the
 * commonest shape: every req on the board is out of reach and the company is
 * still where the relationship belongs. */
{
  const q = outreachQueue([C("mistral", { best: null })], bandOf,
                          { pins: { mistral: "why" } });
  eq(q.length, 1, "a pinned company with no reachable role is still queued");
}

/* IT MUST NOT BORROW A BAND IT DOES NOT HAVE. "Good" printed beside a company
 * whose best role scores 28 is the two-numbers-one-population failure: the
 * label reads as a verdict the scorer never gave. */
{
  const [r] = outreachQueue([C("mistral", { best: 28, bestTitle: "AI Deployment Strategist" })],
                            bandOf, { pins: { mistral: "why" } });
  eq(r.band, null, "a pinned row that does not qualify shows NO band");
  eq(r.score, null, "and no score");
  eq(r.roleTitle, null, "and no role title, which would imply the role is the reason");
  const line = queueLines([r], "https://x.test")[0];
  ok(/pinned/.test(line) && !/Good|Strong|Excellent/.test(line),
     "and the digest line says pinned rather than naming a band");
}

/* A PINNED COMPANY THAT QUALIFIES ON ITS OWN KEEPS ITS REAL BAND. The pin adds
 * a company to the queue; it does not strip information from one already in it. */
{
  const [r] = outreachQueue([C("alpha", { best: 92 })], bandOf,
                            { pins: { alpha: "why" } });
  ok(r.pinned, "a qualifying company can also be pinned");
  ok(r.band, "and keeps the band it genuinely earned");
}

/* THE FINITENESS RULE OUTRANKS THE PIN. "A queue that refills itself will
 * occupy whatever slot it holds, forever" — a pin says which companies get IN,
 * never that one stays after the names are found. */
{
  const q = outreachQueue([C("mistral", { best: 28, contacts: 2 })], bandOf,
                          { pins: { mistral: "why" } });
  eq(q.length, 0, "a pinned company drops out once it hits the name target");
}

/* PINNED SORTS FIRST, because a human decision outranks a model score — and the
 * sort still ends in something unique, so two pinned rows cannot reshuffle. */
{
  const q = outreachQueue([
    C("zulu", { best: 95, n2027: 5 }),
    C("mistral", { best: 28 }),
  ], bandOf, { pins: { mistral: "why" } });
  eq(q[0].name, "mistral", "a pinned company outranks a higher-scoring class-year role");

  const two = { m1: "a", m2: "b" };
  const once = outreachQueue([C("m2", { best: null }), C("m1", { best: null })],
                             bandOf, { pins: two }).map((r) => r.name);
  const twice = outreachQueue([C("m1", { best: null }), C("m2", { best: null })],
                              bandOf, { pins: two }).map((r) => r.name);
  eq(once, twice, "two pinned rows sort identically whatever order they arrive in");
  eq(once, ["m1", "m2"], "and the tie-break is still the slug");
}

/* AN UNPINNED QUEUE IS UNCHANGED. The default must be exactly the old
 * behaviour, or every existing row silently changes meaning. */
{
  const rows = [C("alpha", { best: 92, n2027: 2 }), C("beta"), C("gamma", { best: 20 })];
  eq(outreachQueue(rows, bandOf).map((r) => r.name),
     outreachQueue(rows, bandOf, { pins: {} }).map((r) => r.name),
     "passing no pins and passing an empty pin map agree");
}

/* THE PIN THE OWNER ACTUALLY SET IS REAL AND REACHES THE BUNDLE. A pin that fails
 * to parse out of companies.yaml leaves an empty map and NOTHING SAYS SO — the
 * queue just quietly goes back to being score-only, which is the exact
 * always-empty-source failure this project keeps hitting. */
{
  ok(typeof OUTREACH_PINS === "object" && OUTREACH_PINS !== null,
     "OUTREACH_PINS is baked into config.generated.js");
  ok(Object.keys(OUTREACH_PINS).length >= 1,
     "at least one pin survived the parse out of companies.yaml");
  ok(OUTREACH_PINS["mistral.ai"],
     "and mistral.ai specifically is pinned, with a reason");
  ok(/deployment strategist/i.test(OUTREACH_PINS["mistral.ai"] || ""),
     "whose reason names why: the Deployment Strategist reqs");
}

/* ========= 4c. WHAT TO SEARCH FOR IS NOT WHAT TO PRINT ================== */

/* THE LINK IS A KEYWORD MATCH, so every token in the name is a term the profile
 * has to contain. "Mistral AI" makes LinkedIn require the literal "AI"
 * alongside; people write "Mistral". The display name is right for the page and
 * wrong for the query, and they are simply two different strings. */
{
  const [r] = outreachQueue([C("mistral.ai", { display_name: "Mistral AI" })],
                            bandOf, { searchAs: { "mistral.ai": "Mistral" } });
  eq(r.display_name, "Mistral AI", "the row still PRINTS the display name");
  eq(r.searchAs, "Mistral", "and SEARCHES for the override");
}

/* NO OVERRIDE MEANS THE DISPLAY NAME, which is right for nearly every company —
 * so the common path must not need an entry. */
{
  const [r] = outreachQueue([C("anduril", { display_name: "Anduril" })], bandOf);
  eq(r.searchAs, "Anduril", "with no override the search term is the display name");
  const [r2] = outreachQueue([C("anduril", { display_name: "Anduril" })], bandOf,
                             { searchAs: { other: "x" } });
  eq(r2.searchAs, "Anduril", "and an override for a DIFFERENT company does not leak");
}

/* IT IS KEYED BY SLUG, NOT BY DISPLAY NAME. Keying on the label would break the
 * moment a display name was edited, silently and with no error. */
{
  const [r] = outreachQueue([C("mistral.ai", { display_name: "Mistral AI" })],
                            bandOf, { searchAs: { "Mistral AI": "Mistral" } });
  eq(r.searchAs, "Mistral AI", "a map keyed by LABEL does not match — slug is the key");
}

/* THE OVERRIDE THE OWNER SET REACHES THE BUNDLE. A search_as that fails to parse
 * leaves an empty map and nothing says so; the link silently goes back to the
 * display name, which is the always-empty-source failure in miniature. */
{
  eq(SEARCH_AS["mistral.ai"], "Mistral",
     "mistral.ai's search_as survived the parse out of companies.yaml");
  ok(!SEARCH_AS.anduril,
     "and the override is not being applied to companies that never asked for it");
}

/* AND THE URL IT BUILDS. The whole point is the words that reach LinkedIn.
 * The school half of the query is the baked first search term, so the
 * expectation is built from it rather than typed. */
{
  const url = schoolPeopleSearchUrl(SEARCH_AS["mistral.ai"] || "Mistral AI");
  const prefix = encodeURIComponent(SCHOOL_SEARCH_PREFIX);
  ok(new RegExp(`keywords=${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}%20Mistral$`).test(url),
     `the search is for "${SCHOOL_SEARCH_PREFIX} Mistral", got ${url}`);
  ok(!/Mistral%20AI/.test(url), "and does NOT require the literal token AI");
}

/* ============ 4d. BLOCKER TAGS: UNKNOWN IS NOT CLEAR ==================== */

/* THE DISTINCTION THE WHOLE FEATURE RESTS ON. A row with no tags is only clear
 * if the text was WHOLE. 9,691 of 9,708 non-candidate descriptions are cut at
 * exactly 2,000 characters, with the requirements section past the cut. */
{
  eq(verdictOf({ blockers: "[]", blockers_full_text: 1 }), "clear",
     "no tags + complete text = clear");
  eq(verdictOf({ blockers: "[]", blockers_full_text: 0 }), "unknown",
     "no tags + TRUNCATED text = unknown, NOT clear");
  eq(verdictOf({ blockers: null }), "unknown",
     "never classified = unknown");
  eq(verdictOf({}), "unknown", "and a row with nothing on it is unknown");
  eq(verdictOf({ blockers: '["years_4plus"]', blockers_full_text: 0 }), "blocked",
     "a blocker found INSIDE truncated text is still a real blocker");
}

/* SOFT TAGS ARE NOT BLOCKERS. The profile this is built for is a US citizen;
 * a clearance they could obtain is not a wall. These render green and must
 * never read as a screen-out. */
{
  eq(verdictOf({ blockers: '["clearance_obtainable"]', blockers_full_text: 1 }), "clear",
     "an obtainable clearance does not block");
  eq(verdictOf({ blockers: '["citizenship_only"]', blockers_full_text: 1 }), "clear",
     "US-citizens-only does not block either");
  eq(hardTags(["clearance_obtainable", "citizenship_only", "cs_degree"]), ["cs_degree"],
     "only the hard tags count as hard");
  for (const t of SOFT) {
    ok(!HARD.includes(t), `${t} is soft, never hard`);
    // THE ESCAPES HERE WERE ONCE LITERAL 0x08 BACKSPACE BYTES. Written
    // through a shell heredoc, backslash-b collapsed, the file still
    // parsed, the regex matched nothing, and this assertion passed while
    // guarding nothing at all. test_line_endings.py caught it.
    ok(!/\bcleared\b|eligible for TS|clearance-eligible/i.test(EXPLAIN[t] || ""),
       `${t}'s wording claims no adjudicated result`);
  }
}

/* THE PALANTIR ROW, END TO END, as blockers.py actually stamps it. */
{
  const row = { blockers: '["clearance_obtainable"]', blockers_full_text: 1 };
  eq(verdictOf(row), "clear", "Palantir FDSE renders as clear, not blocked");
  const [chip] = chipsOf(row);
  ok(chip && !chip.hard, "its one chip is soft, so it renders green");
  ok(/obtain/i.test(chip.explain), "and explains that the clearance is obtainable");
}

/* THE MISTRAL ROW. */
{
  const row = { blockers: '["cs_degree","years_4plus"]', blockers_full_text: 1 };
  eq(verdictOf(row), "blocked", "Mistral DS renders as blocked");
  eq(chipsOf(row).map((c) => c.tag), ["cs_degree", "years_4plus"],
     "with both chips, in the fixed HARD order so the row cannot reshuffle");
  ok(chipsOf(row).every((c) => c.hard), "and both are hard");
}

/* UNPARSEABLE JSON IS NOT A CLEAN ROW. Returning [] there would render a
 * corrupt row as "no blockers", the one answer it cannot support. */
{
  eq(tagsOf({ blockers: "{not json" }), null, "unparseable blockers parse to null");
  eq(verdictOf({ blockers: "{not json", blockers_full_text: 1 }), "unknown",
     "and the row reads unknown rather than clear");
}

/* THE TRUNCATION LINE THE OWNER ASKED TO SEE EVERY MORNING. */
{
  const line = truncationLine({ total: 11500, unknown: 8804 });
  ok(/8,804/.test(line) && /11,500/.test(line), "it states both numbers");
  ok(/77%/.test(line), "and the percentage");
  ok(/not read/.test(line) && !/clear/.test(line.split("means")[0]),
     "and says the rows were not READ rather than cleared");

  eq(truncationLine({ total: 11500, unknown: 0 }), null,
     "nothing unknown means no line at all, not an empty section");

  // A FAILED COUNT MUST NOT RENDER AS 'NOTHING TO REPORT'.
  ok(/no roles counted/i.test(truncationLine({ total: 0, unknown: 0 })),
     "a zero total reports MISSING DATA, not a clean result");
  ok(/no roles counted/i.test(truncationLine(null)),
     "and an explicit null does not throw -- `= {}` does not catch null");
}

/* IT REACHES THE DIGEST, under pipeline health, where it belongs. */
{
  const health = boardAnomalies([
    row("2026-09-06", "mach", 0), row("2026-09-06", "elevenlabs", 252),
  ]);
  const hit = evaluateTriggers({
    health, blockerCounts: { total: 11500, unknown: 8804 },
    today: "2026-09-06", cfg: {},
  }).find((f) => f.group === "board_anomaly");
  ok(hit && hit.lines.join(" ").includes("8,804"),
     "the digest health section carries the truncation count");
}

/* ============ 4e. NEON TRANSFER: THREE STATES, NOT TWO =================== */

/* THE ALLOWANCE RAN OUT AT 11:57 PM ON A DAY WHEN NOTHING ELSE WAS WRONG, and
 * the first anyone knew was an email from Neon. Each of these three states has
 * to read differently, because "no key", "the API refused" and "3% used" are
 * three different facts and only one of them is good news. */
{
  const unset = transferLine(null);
  ok(!unset.red, "no key configured is not an alarm");
  ok(/not being read/.test(unset.line) && /missing data, not headroom/.test(unset.line),
     "but it says the number is MISSING rather than fine");

  const refused = transferLine({ error: "Neon returned 403", hint: "needs admin" });
  ok(refused.red, "a refused read is RED");
  ok(/could not be read/.test(refused.line), "and says so");
  ok(/needs admin/.test(refused.line), "carrying the hint about which scope");
  ok(/not known to be fine/.test(refused.line),
     "and refuses to imply headroom it cannot see");
}

/* THE THRESHOLD IS THE CONSTANT, and it is red at or above it. */
{
  const under = transferLine({ bytes: 0.69 * ALLOWANCE_BYTES });
  ok(!under.red, "just under the threshold is not red");
  const at = transferLine({ bytes: WARN_AT * ALLOWANCE_BYTES });
  ok(at.red, `exactly ${Math.round(WARN_AT * 100)}% IS red — the boundary is inclusive`);
  ok(/over 70%/.test(at.line), "and the prose names the same number as the constant");
}

/* EXHAUSTED IS ITS OWN MESSAGE, because "100%" and "72%" call for different
 * actions and one of them is "stop". */
{
  const gone = transferLine({ bytes: ALLOWANCE_BYTES });
  ok(gone.red, "at 100% it is red");
  ok(/EXHAUSTED/.test(gone.line), "and says exhausted rather than a percentage");
  ok(/suspension/.test(gone.line), "and names the actual consequence");
  ok(!/over 70%/.test(gone.line), "without also reporting the lesser threshold");
}

/* THE ALLOWANCE IS THE PLAN'S, AND IT COMES FROM config.yaml =============
 *
 * It was hardcoded to the free tier's 5 GB. The original owner moved to Launch (500 GB) on
 * 2026-09-06, which made the denominator wrong by 100x -- and wrong in the
 * dangerous direction: WARN_AT would have fired at 3.5 GB and "ALLOWANCE
 * EXHAUSTED, nothing should run against the database" at 5 GB, which on Launch
 * is 1% of the real budget. The digest would have told him to stop running the
 * pipeline while 99% of the allowance sat unused, every day, until he learned
 * to ignore it.
 *
 * That is the deployed cost meter's failure exactly -- "$29.88 / $5.00 OVER
 * CAP" against a cap that had been reset. The number was not missing, it was
 * confidently wrong, which is worse.
 *
 * So the plan's allowance is a fact about the account and lives in config.yaml
 * beside monthly_cap, baked at build time by genconfig for the reason in
 * CLAUDE.md: a value production needs cannot travel by filesystem. */
{
  ok(ALLOWANCE_BYTES === 500e9,
     `the allowance is the Launch plan's 500 GB, got ${ALLOWANCE_BYTES / 1e9} GB`);
  ok(Math.abs(WARN_AT - 0.70) < 1e-9, `warns at 70%, got ${WARN_AT * 100}%`);

  // IT IS READ FROM THE BAKED CONFIG, not retyped here. Two spellings of one
  // number is how schema.sql drifted twenty columns; what matters is that the
  // module and the generated file agree, not that both happen to say 500.
  ok(TRANSFER_ALLOWANCE_BYTES === ALLOWANCE_BYTES,
     `lib/transfer.js uses the baked allowance (module ${ALLOWANCE_BYTES}, `
     + `generated ${TRANSFER_ALLOWANCE_BYTES})`);
  ok(TRANSFER_WARN_AT === WARN_AT,
     `and the baked warn threshold (module ${WARN_AT}, generated ${TRANSFER_WARN_AT})`);

  // AND config.yaml IS THE SOURCE, so editing the plan there moves the number.
  const yaml = fs.readFileSync(path.join(REPO_ROOT, "config.yaml"), "utf8");
  const m = yaml.match(/transfer_allowance_gb:\s*([0-9]+(?:\.[0-9]+)?)/);
  ok(m, "config.yaml carries database.transfer_allowance_gb");
  ok(m && Number(m[1]) * 1e9 === ALLOWANCE_BYTES,
     `config.yaml says ${m ? m[1] : "?"} GB and the module agrees`);
}

/* THE NUMBERS THE OLD HARDCODED 5 GB WOULD HAVE GOT WRONG. These are figures
 * the digest would actually have printed on this account. */
{
  // 4 GB on Launch is under 1% and unremarkable. Under the old constant it was
  // 80% -- red, "check the transfer line before running any backfill".
  const four = transferLine({ bytes: 4e9 });
  ok(!four.red, "4 GB is not an alarm on a 500 GB plan");
  ok(!/over 70%/.test(four.line), "and is not reported as over the threshold");

  // The migration fetch itself: 77.8 MB, the run that prompted all of this.
  const fetch1 = transferLine({ bytes: 77.8e6 });
  ok(!fetch1.red, "the 77.8 MB migration fetch is not an alarm");
  ok(/0\.08 GB of 500\.00 GB/.test(fetch1.line),
     `it states both figures against the real plan, got: ${fetch1.line}`);

  // The threshold still works, at the right place: 350 GB, not 3.5.
  ok(transferLine({ bytes: 0.69 * 500e9 }).red === false,
     "345 GB is under the threshold");
  ok(transferLine({ bytes: 0.70 * 500e9 }).red === true,
     "350 GB is at it, and red");
}

/* A HEALTHY READ STILL PRINTS THE NUMBER. A figure you only see when it is bad
 * cannot be sanity-checked when it is good -- the same reason healthLines
 * always states the board count. */
{
  // 48 GB, not 0.48: on a 500 GB plan half a gigabyte rounds to 0%, and a test
  // asserting "0%" would pass just as happily against a broken denominator.
  // The figure has to be big enough that the percentage means something.
  const fine = transferLine({ bytes: 48e9, periodStart: "2026-09-01T00:00:00Z" });
  ok(!fine.red, "48 GB of 500 is fine");
  ok(/48\.00 GB of 500\.00 GB/.test(fine.line), `it states both figures, got: ${fine.line}`);
  ok(/10%/.test(fine.line), "and the percentage");
  ok(/since 2026-09-01/.test(fine.line), "and the period it covers");
}

/* IT FIRES ON ITS OWN, not only when a board also broke. The allowance reached
 * 100% on a day when every board answered perfectly. */
{
  const healthy = boardAnomalies([row("2026-09-06", "exa", 55)]);
  ok(healthy.ok, "the boards are fine in this fixture");
  const fired = evaluateTriggers({
    health: healthy, neon: { bytes: 0.9 * ALLOWANCE_BYTES },
    today: "2026-09-06", cfg: {},
  });
  const hit = fired.find((f) => f.group === "board_anomaly");
  ok(hit, "a red transfer figure fires the digest with no board anomaly at all");
  ok(/transfer/i.test(hit.subject), `and the subject names it, got: ${hit.subject}`);

  // AND IT DOES NOT REPEAT within a day.
  const again = evaluateTriggers({
    health: healthy, neon: { bytes: 0.9 * ALLOWANCE_BYTES },
    today: "2026-09-06", cfg: {}, alreadyFired: new Set([hit.key]),
  });
  ok(!again.some((f) => f.group === "board_anomaly"), "and does not fire twice in a day");
}

/* A HEALTHY FIGURE DOES NOT FIRE ANYTHING, it just rides along. */
{
  const healthy = boardAnomalies([row("2026-09-06", "exa", 55)]);
  const fired = evaluateTriggers({
    health: healthy, neon: { bytes: 0.1e9 }, today: "2026-09-06", cfg: {},
  });
  ok(!fired.some((f) => f.group === "board_anomaly"),
     "a healthy transfer figure sends no email of its own");
}

/* ===================== 5. NOTHING HERE CAN SEND ========================== */

/* The queue names a company and never a person, and produces a SEARCH URL
 * rather than a result. Nothing in these modules may hold an address. */
{
  const q = outreachQueue([C("alpha")], bandOf);
  const text = JSON.stringify(q) + queueLines(q, "https://x.test").join(" ");
  ok(!/@/.test(text.replace(/https?:\/\/[^"\s]+/g, "")),
     "no email address appears anywhere in the queue or its digest lines");
  ok(TRIGGERS.includes("board_anomaly") && TRIGGERS.includes("consulting_open"),
     "both new triggers are registered in TRIGGERS so config can switch them off");
}

/* ------------------------------------------------ how long it has been broken
 *
 * Feeds the escalation rule in notify.js: three consecutive bad observations
 * and a board says one distinct thing, then goes quiet.
 */
{
  const d = (day, n, error = null) => ({ day, n_roles: n, error });

  ok(badStreak(d("2026-09-09", 12), []).days === 0,
     "a board that answered is not on a streak at all");
  ok(badStreak(d("2026-09-09", 0), []).days === 1,
     "one bad fetch with no history is a streak of one");
  ok(badStreak(d("2026-09-09", 0), [d("2026-09-08", 0)]).days === 2,
     "two in a row is two");
  ok(badStreak(d("2026-09-09", 0),
               [d("2026-09-08", 0), d("2026-09-07", 40)]).days === 2,
     "and it STOPS at the last day the board worked, rather than counting "
     + "every bad day it ever had");
  ok(badStreak(d("2026-09-09", 0),
               [d("2026-09-08", 0), d("2026-09-07", 0)]).since === "2026-09-07",
     "the start day is the first bad one in the run -- that is what keys the "
     + "escalation, so a board that recovers and fails again speaks anew");

  /* AN ERROR COUNTS, not just a zero. A board that throws every morning is as
   * broken as one that answers with nothing, and only one of the two would be
   * caught if this read n_roles alone. */
  ok(badStreak(d("2026-09-09", null, "HTTP 500"),
               [d("2026-09-08", null, "HTTP 500")]).days === 2,
     "a board that errors every morning is on a streak too");

  /* A DAY WITH NO ROW IS A DAY NOBODY LOOKED. The pipeline missed 09-08
   * entirely -- there is no observation, so it neither counts as a failure nor
   * clears the run. Treating a gap as "fine" would silently reset every
   * board's streak on any morning the cron did not fire, which is the
   * direction that loses the finding. */
  ok(badStreak(d("2026-09-09", 0),
               [d("2026-09-07", 0), d("2026-09-06", 0)]).days === 3,
     "a missing day does not break the run -- an absence of evidence is not "
     + "evidence that the board was fine");
}

/* ------------------------------------------------------------------ report */
if (fails.length) {
  console.error(`\ntest_boards: ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`test_boards: ${pass} passed`);
