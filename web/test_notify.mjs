/**
 * What gets emailed, and what does not. Run: node test_notify.mjs
 *
 * THE FIRST SECTION IS THE IMPORTANT ONE. Every other test in this repo guards
 * a wrong answer on a screen; this one guards mail leaving the machine. The
 * standing rule is that this tool never sends anything to another human — every
 * message to a real person is drafted, approved by the owner, and sent by the
 * owner — and the single exception is the tool emailing its own owner about
 * their own data.
 *
 * That exception is only safe while the address cannot vary, so the address is
 * asserted here, the absence of any way to pass one is asserted here, and the
 * source of every module that could send is scanned for a second address.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateTriggers, buildDigest, buildTest, windowStep, TRIGGERS, WINDOW_STEPS,
  SECTIONS, orderSections, runCompleted, parseStages,
  hoursSinceCompletedRun, staleFor, STALE_RUN_HOURS,
  STAGES_REQUIRED_FROM, WATCHER_BROKEN_DAYS, BOARD_ESCALATE_DAYS,
} from "./lib/notify.js";
import { boardAnomalies } from "./lib/boards.js";
import { foldBlocked, NO_BLOCKS } from "./lib/blocked.js";
import { NOTIFY_TO, NOTIFY_FROM_FALLBACK } from "./lib/constants.js";
import { NOTIFY, OWNER } from "./lib/config.generated.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));
const eq = (got, want, what) =>
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);

/* ============================ ONE RECIPIENT, AND ONLY ONE ================= */

// THE BAKED VALUE, NOT A LITERAL. The original asserted one person's address
// here; the template's recipient is whoever profile.json names, so the test
// reads the same baked module the sender reads and requires the two to agree
// -- and requires it to be a single, real address, never a list or a blank.
eq(NOTIFY_TO, OWNER.email, "the recipient is the owner, from profile.json, and is a constant");
ok(typeof NOTIFY_TO === "string" && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(NOTIFY_TO),
   `the recipient is exactly one address (${NOTIFY_TO})`);

/* THE ASYMMETRY, which is the whole design and the thing most likely to be
 * eroded by a well-meaning change.
 *
 * The FROM address is a return label: configurable in config.yaml, baked at
 * build time, changeable without touching code.
 *
 * The TO address is a rule: hardcoded, not in config.yaml, not a parameter,
 * not a column. Making one editable must never make the other editable. */
ok(/@/.test(NOTIFY.from), `the from address comes from config (${NOTIFY.from})`);
// THE FROM AND TO DOMAINS ARE NOT REQUIRED TO MATCH, and the from address is
// not asserted against any particular domain: it is whatever the owner
// verified with their provider, which the template cannot know.
ok(!/^\s*$/.test(NOTIFY.from), "and is not blank");
ok(/@/.test(NOTIFY_FROM_FALLBACK),
   "with a fallback, so a missing config cannot produce an empty From header");

{
  // config.yaml may say who it is FROM and must never say who it is TO.
  const yaml = fs.readFileSync(path.join(here, "..", "config.yaml"), "utf8");
  const block = yaml.slice(yaml.indexOf("notifications:"));
  ok(/^\s+from:/m.test(block), "config.yaml carries the from address");
  ok(!block.includes(NOTIFY_TO),
     "and does NOT carry the recipient — that lives in code, hardcoded");
  ok(!/^\s+(to|recipient|cc|bcc):/m.test(block),
     "and has no to/recipient/cc/bcc key at all");
}

const sender = fs.readFileSync(path.join(here, "lib/notify.mjs"), "utf8");

// THE SENDER TAKES NO ADDRESS. Not as an argument, not from the environment,
// not from a row. If this ever fails, someone has made the recipient variable.
ok(/to:\s*\[NOTIFY_TO\]/.test(sender),
   "the send call addresses NOTIFY_TO and nothing else");
ok(/from:\s*FROM\b/.test(sender),
   "and takes the from address from the baked config");

/* A NON-2XX MUST FAIL THE STEP.
 *
 * Resend answered 403 for an unverified sender and the step reported GREEN —
 * the third time something here claimed success while doing nothing, after the
 * migration runner silently falling back to SQLite and this script never having
 * run at all. The earlier version caught the error, printed it, and exited 0 on
 * the reasoning that a mail outage should not redden a good fetch. That
 * reasoning was wrong: a step that says it sent an email it did not send is
 * worse than a red build. */
ok(/if \(!r\.ok\)/.test(sender), "any non-2xx response is treated as a failure");
ok(/err\.body\s*=\s*body/.test(sender),
   "the response body is carried on the error rather than discarded");
ok(/process\.exitCode\s*=\s*1/.test(sender),
   "and the step exits non-zero — it is allowed to fail the run");
ok(!/exit\(0\);\s*\n\}\s*$/.test(sender.slice(sender.indexOf("catch (e)"))),
   "the catch does not swallow the failure into a green exit");
ok(/say\(e\.body\)/.test(sender),
   "the provider's own words are printed in full, not truncated");
// process.exit() mid-fetch crashes libuv on Windows and reports 127 rather
// than 1 — a failure path that itself fails confusingly is barely better than
// one that stays silent.
ok(!/process\.exit\(1\)/.test(sender),
   "and it sets exitCode rather than calling process.exit() with a socket open");
ok(!/\bcc\b|\bbcc\b/i.test(sender), "there is no CC or BCC anywhere in the sender");
ok(!/function send\([^)]*to\b/.test(sender), "send() does not accept a recipient");

// NO OTHER ADDRESS EXISTS in any module that can send. A literal address in the
// sender, the composer or the constants file is the shape this would go wrong.
for (const f of ["lib/notify.mjs", "lib/notify.js", "lib/constants.js"]) {
  const src = fs.readFileSync(path.join(here, f), "utf8");
  const addrs = [...src.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)]
    .map((m) => m[0])
    // resend.dev is the FROM domain and api.resend.com is the endpoint.
    // resend.dev is the fallback FROM domain and api.resend.com is the
    // endpoint. Neither is a recipient, and neither can become one: the send
    // call's `to` is the constant.
    .filter((a) => a !== NOTIFY_TO && !/resend\.dev$/.test(a));
  eq(addrs, [], `${f} contains no address other than the constant`);
}

// AND NO ROUTE CAN SEND. The web side must have no send path at all: a page
// render that can send email is one bug away from sending a great deal of it.
{
  const routes = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) routes.push(p);
    }
  };
  walk(path.join(here, "app"));
  const senders = routes.filter((p) => /api\.resend\.com/.test(fs.readFileSync(p, "utf8")));
  eq(senders.map((p) => path.relative(here, p)), [],
     "no file under app/ can reach the mail provider");
}

/* ------------------------------------------------------ the window steps */

eq(WINDOW_STEPS, [7, 3, 1], "a closing window speaks at 7 days, 3, and 1");
eq(windowStep(10), null, "and says nothing at 10");
eq(windowStep(8), null, "nor at 8");
eq(windowStep(7), 7, "the first word is at 7");
eq(windowStep(5), 7, "5 is still inside the 7-day step and does not repeat");
eq(windowStep(4), 7, "nor does 4");
eq(windowStep(3), 3, "3 is its own step");
eq(windowStep(2), 3, "2 is still the 3-step");
eq(windowStep(1), 1, "1 is the last word");
eq(windowStep(0), 1, "and today is still the 1-step, not a fourth email");
eq(windowStep(-1), null, "a closed window says nothing");
eq(windowStep(null), null, "and neither does an undated one");

/* ------------------------------------------------------------ the triggers */

const CFG = { enabled: true, triggers: Object.fromEntries(TRIGGERS.map((k) => [k, true])) };
const W = (firm, closeIn, extra = {}) =>
  ({ firm, program: "P", status: "open", closeIn, confidence: "verified", applied: false, ...extra });

/**
 * Blocked apply flows, in the shape db.blockedApplies() hands over.
 *
 * The window key is `window:Deloitte|P` so it MATCHES the W("Deloitte", …)
 * fixture above — which is the whole point of the window half: the countdown on
 * the line comes from joining these two by key, and a fixture whose keys did
 * not match would test the join by never exercising it.
 */
const BLOCKED_ROW = (o) => ({
  id: "bk:1", scope: "role", key: "k", reason: null, note: null,
  label: null, url: null, on_: 1, at: "2026-09-11T00:00:00+00:00", ...o,
});
const BLOCKED_FIXTURE = foldBlocked([
  BLOCKED_ROW({
    id: "bk:1", scope: "role", key: "lever:palantir:chi",
    reason: "captcha_hcaptcha", note: "hCaptcha loops on Lever apply flow",
    label: "Palantir — Deployment Strategist (Chicago, IL)",
    url: "https://jobs.lever.co/palantir/chi",
  }),
  BLOCKED_ROW({
    id: "bk:2", scope: "window", key: "window:Deloitte|P",
    reason: "http_error", note: "HTTP 406 since 2026-09-08",
    label: "Deloitte — P",
  }),
]);

// A QUIET DAY SENDS NOTHING. This is the single most important behaviour here:
// a digest that arrives regardless is one you filter away, and then the one
// that mattered lands in the same folder.
{
  const fired = evaluateTriggers({ cfg: CFG, today: "2026-09-02" });
  eq(fired, [], "nothing happening fires nothing");
  eq(buildDigest({ fired, cfg: CFG }), null, "and no email is built");
}

// PRIORITY. A failed run leads, because everything below it was computed from
// data that did not refresh.
{
  const fired = evaluateTriggers({
    run: { status: "failure", run_url: "https://gh/run/1" },
    windows: [W("Deloitte", 3)],
    cfg: CFG, today: "2026-09-02", baseUrl: "https://x.test",
  });
  eq(fired[0].key, "pipeline_failure", "a failed run leads");
  const mail = buildDigest({ fired, cfg: CFG });
  eq(mail.subject, "JobOps: yesterday's run failed", "and owns the subject line");
  eq(mail.kind, "failure", "and the email is a failure alert, not a digest");
  ok(/gh\/run\/1/.test(mail.text), "with the run link in the body");
  ok(/Deloitte/.test(mail.text), "and the window still listed below it");
}

// The window leads when the run was fine.
{
  const fired = evaluateTriggers({
    run: { status: "success" },
    windows: [W("Deloitte", 3), W("Accenture", 30)],
    cfg: CFG, today: "2026-09-02",
  });
  eq(fired.length, 1, "only the window inside the horizon fires");
  const mail = buildDigest({ fired, cfg: CFG });
  eq(mail.subject, "JobOps: Deloitte closes in 3 days", "the subject is the single most urgent thing");
  eq(mail.kind, "digest", "and it is a digest");
}

// SUBMITTED MEANS SILENT. An email about a deadline he has already met is the
// definition of noise.
{
  const fired = evaluateTriggers({
    windows: [W("Deloitte", 3, { applied: true })], cfg: CFG, today: "2026-09-02" });
  eq(fired, [], "a window already applied to says nothing");
}

// NO REPEAT INSIDE A STEP. Fired at 7, it stays quiet at 6, 5 and 4.
{
  const already = new Set(["closing_window:Deloitte|P:7"]);
  eq(evaluateTriggers({ windows: [W("Deloitte", 5)], cfg: CFG, alreadyFired: already }),
     [], "having spoken at 7, it says nothing at 5");
  const at3 = evaluateTriggers({ windows: [W("Deloitte", 3)], cfg: CFG, alreadyFired: already });
  eq(at3.length, 1, "but it speaks again at 3");
  eq(at3[0].key, "closing_window:Deloitte|P:3", "under a key carrying the new step");
}

// An estimated date says so. The McKinsey note is what not saying it cost.
{
  const fired = evaluateTriggers({
    windows: [W("BCG", 3, { confidence: "historical-estimate" })], cfg: CFG });
  ok(/estimated — confirm it/.test(fired[0].lines[0]),
     "an unconfirmed date is labelled in the email too");
}

/* --------------------------------------------------- overdue and follow-ups */

{
  const fired = evaluateTriggers({
    items: [{ title: "Confirm BCG", due_at: "2026-09-01", done: false, dueIn: -1 }],
    cfg: CFG, today: "2026-09-02",
  });
  eq(fired.length, 1, "a task that went overdue yesterday fires");
  ok(/Confirm BCG/.test(fired[0].lines[0]), "and names it");
}
{
  // Not every overdue task forever — only ones that went over recently. An
  // email about something three weeks late every single morning is a nag.
  const fired = evaluateTriggers({
    items: [{ title: "Ancient", due_at: "2026-08-01", done: false, dueIn: -32 }],
    cfg: CFG, today: "2026-09-02",
  });
  eq(fired, [], "a long-overdue task does not re-fire every day");
}
{
  const fired = evaluateTriggers({
    owed: [{ name: "A Contact", company: "Palantir", why: "day 5 follow-up" }],
    cfg: CFG, today: "2026-09-02",
  });
  eq(fired.length, 1, "an owed follow-up fires");
  ok(/A Contact/.test(fired[0].lines[0]), "and names the person");
}

/* ------------------------------------------- applications that cannot be sent
 *
 * The section exists because the tool's whole output is "apply to this" and
 * nothing in it could say that applying is impossible. The failure it is
 * guarding against is a window closing while the digest recommends it daily.
 */

{
  const fired = evaluateTriggers({
    windows: [W("Deloitte", 19, { program: "P", closes: "2026-09-30" })],
    blocked: BLOCKED_FIXTURE,
    cfg: CFG, today: "2026-09-11", baseUrl: "https://x.test",
  });
  const sec = fired.find((f) => (f.group || f.key) === "manual_apply");
  ok(sec, "a blocked apply flow fires");

  const text = sec.lines.join("\n");

  // THE LINE CARRIES THE REASON AND THE URL. Without the reason it is a
  // complaint; without the link it is a chore.
  ok(/hCaptcha loop/.test(text), "the role line names the reason");
  ok(/hCaptcha loops on Lever apply flow/.test(text), "…and the note");
  ok(/https:\/\/jobs\.lever\.co\/palantir\/chi/.test(text),
     "…and the apply url it was snapshotted with");

  // THE COUNTDOWN, which is the reason the window half exists at all. The 406
  // has eaten three days already and the window closes on the 30th; a line
  // without the number can sit here until the date passes.
  ok(/closes in 19 days/.test(text), "the window line carries days-until-close");
  ok(/2026-09-30/.test(text), "…and the date, so the number can be checked");
  ok(/HTTP 406 since 2026-09-08/.test(text), "…and how long it has been broken");

  // AND IT SAYS HOW TO MAKE IT STOP, first, because it repeats daily and a
  // recurring prompt with no discharge is a nag.
  ok(/apply_blocks\.py unblock/.test(sec.lines[0]),
     "the first line says how to lift it");

  // WINDOWS BEFORE ROLES: a window takes the cycle with it, a requisition does
  // not.
  ok(text.indexOf("Deloitte") < text.indexOf("Palantir"),
     "the window is listed above the role");
}

{
  // PLACEMENT IN THE EMAIL. Directly under the windows, because a blocked
  // window is a closing_window line whose instruction cannot be followed —
  // reading them apart is reading two halves of one fact on two screens.
  const fired = evaluateTriggers({
    windows: [W("Deloitte", 19, { closes: "2026-09-30" })],
    blocked: BLOCKED_FIXTURE,
    pages: { changed: [{ label: "A page", url: "https://p.test", last_status_hit: 0 }] },
    newExcellent: [{ display_name: "Databricks", title: "APM, New Grad" }],
    cfg: CFG, today: "2026-09-11", baseUrl: "https://x.test",
  });
  const keys = orderSections(fired).map((s) => s.key);
  ok(keys.indexOf("closing_window") < keys.indexOf("manual_apply"),
     "the closing window comes first");
  ok(keys.indexOf("manual_apply") < keys.indexOf("pages_changed"),
     "and blocked applies come above pages that changed");

  const mail = buildDigest({ fired, cfg: CFG, baseUrl: "https://x.test" });
  ok(mail.text.indexOf("cannot be submitted") < mail.text.indexOf("Databricks"),
     "…and above the new roles in the rendered email");
}

{
  // THE CAP, and that the count it reports is honest.
  const rows = [];
  for (let i = 0; i < 14; i++) {
    rows.push(BLOCKED_ROW({
      id: `bk:${String(i).padStart(3, "0")}`, key: `job-${String(i).padStart(3, "0")}`,
      reason: "captcha", label: `Role ${i}`, url: "https://u.test",
    }));
  }
  const fired = evaluateTriggers({
    blocked: foldBlocked(rows), cfg: CFG, today: "2026-09-11",
  });
  const [sec] = orderSections(fired);
  eq(sec.key, "manual_apply", "fourteen blocked flows are one section");
  // TEN KEPT PLUS THE COUNT OF WHAT WAS DROPPED — orderSections appends the
  // "and N more" line AFTER slicing to the cap, so a capped section is cap + 1
  // lines long. Worth pinning: the first version of this assertion expected 10
  // and was wrong about the code rather than the other way round.
  eq(sec.lines.length, 11, "capped at ten lines, plus the line saying so");
  ok(/and 5 more, in the app/.test(sec.lines[10]),
     "and the section says how many it left out");
  // The instruction survives the cap BECAUSE it is first. On the worst morning
  // — ten things blocked — it is the line that matters most and the one a
  // bottom-anchored sentence would lose.
  ok(/apply_blocks\.py unblock/.test(sec.lines[0]),
     "the way to stop it is not what gets truncated");
}

{
  // THREE EMPTY STATES, AND THEY ARE NOT THE SAME STATE. This project has hit
  // "nothing to show" and "this has never worked" looking identical on three
  // separate surfaces; here there is a third, "we could not look".
  const none = evaluateTriggers({ blocked: NO_BLOCKS, cfg: CFG, today: "2026-09-11" });
  ok(!none.some((f) => (f.group || f.key) === "manual_apply"),
     "nothing blocked fires nothing");
  eq(buildDigest({ fired: none, cfg: CFG }), null,
     "…and an otherwise quiet day still sends no email");

  const unread = evaluateTriggers({ blocked: null, cfg: CFG, today: "2026-09-11" });
  ok(!unread.some((f) => (f.group || f.key) === "manual_apply"),
     "an unreadable table fires nothing either — it must not claim a clear morning");

  // THE SECTION IS OMITTED, not rendered empty over a heading.
  const other = evaluateTriggers({
    windows: [W("Deloitte", 3)], blocked: NO_BLOCKS,
    cfg: CFG, today: "2026-09-11", baseUrl: "https://x.test",
  });
  ok(!orderSections(other).some((s) => s.key === "manual_apply"),
     "the section is omitted entirely when nothing is blocked");
}

{
  // A LIFTED BLOCK GOES SILENT. This is the answer that makes the daily repeat
  // defensible, so it is asserted rather than assumed.
  const lifted = foldBlocked([
    BLOCKED_ROW({ id: "bk:1", key: "j1", reason: "captcha", label: "L" }),
    BLOCKED_ROW({ id: "bk:2", key: "j1", on_: 0 }),
  ]);
  const fired = evaluateTriggers({ blocked: lifted, cfg: CFG, today: "2026-09-11" });
  ok(!fired.some((f) => (f.group || f.key) === "manual_apply"),
     "lifting the last block stops the section appearing");
}

{
  // A WINDOW WITH NO DATE SAYS SO. 16 of 25 tracked windows have no close
  // date; a silent line would be the common case wearing the costume of a bug.
  const blocked = foldBlocked([BLOCKED_ROW({
    id: "bk:1", scope: "window", key: "window:Nobody|P",
    reason: "http_error", label: "Nobody — P",
  })]);
  const fired = evaluateTriggers({
    windows: [], blocked, cfg: CFG, today: "2026-09-11",
  });
  const sec = fired.find((f) => (f.group || f.key) === "manual_apply");
  ok(/no close date on file/.test(sec.lines.join("\n")),
     "a window with no matching date says so out loud");
}

/* --------------------------------------------------------- per-trigger off */

for (const key of TRIGGERS) {
  const off = { enabled: true, triggers: { ...CFG.triggers, [key]: false } };
  const fired = evaluateTriggers({
    run: { status: "failure", run_url: "u" },
    windows: [W("Deloitte", 3)],
    items: [{ title: "T", due_at: "2026-09-01", done: false, dueIn: -1 }],
    owed: [{ name: "N" }],
    newExcellent: [{ company: "c", title: "t" }],
    retro: { empty: false, lines: ["Last week: 3 messages sent, 1 reply."] },
    // EVERY TRIGGER IN THIS LOOP NEEDS ITS INPUT PRESENT, or "it can be
    // switched off" is satisfied by a trigger that never fires in the first
    // place — the guard that passes on absence, which this project has now hit
    // in five different shapes. manual_apply fires on `blocked`, so `blocked`
    // is supplied.
    blocked: BLOCKED_FIXTURE,
    cfg: off, today: "2026-09-02",
  });
  // …and so the off-switch means something, each trigger is required to fire
  // when it is ON. A switch on a dead wire tests nothing.
  const onFired = evaluateTriggers({
    run: { status: "failure", run_url: "u" },
    windows: [W("Deloitte", 3)],
    items: [{ title: "T", due_at: "2026-09-01", done: false, dueIn: -1 }],
    owed: [{ name: "N" }],
    newExcellent: [{ company: "c", title: "t" }],
    retro: { empty: false, lines: ["Last week: 3 messages sent, 1 reply."] },
    blocked: BLOCKED_FIXTURE,
    cfg: CFG, today: "2026-09-02",
  });
  // window_opened, pipeline_failure's siblings and the Monday-only retro have
  // no input in this fixture; the ones that do are required to be live.
  if (["closing_window", "overdue", "new_excellent", "manual_apply"].includes(key)) {
    ok(onFired.some((f) => (f.group || f.key) === key),
       `${key} actually fires when it is on`);
  }
  ok(!fired.some((f) => (f.group || f.key) === key), `${key} can be switched off`);
  ok(fired.length > 0, `and the others still fire without it`);
}

// The master switch.
{
  const fired = evaluateTriggers({ run: { status: "failure" }, cfg: CFG });
  eq(buildDigest({ fired, cfg: { ...CFG, enabled: false } }), null,
     "notifications off means nothing is built, not even a failure");
}

/* ------------------------------------------------------------- the format */

{
  const fired = evaluateTriggers({
    windows: [W("Deloitte", 1)],
    newExcellent: [{ display_name: "Databricks", title: "APM, New Grad" }],
    retro: { empty: false, lines: ["Last week: 3 messages sent, 1 reply."] },
    cfg: CFG, today: "2026-09-02", baseUrl: "https://x.test",
  });
  const mail = buildDigest({ fired, cfg: CFG, baseUrl: "https://x.test" });

  ok(mail.subject.startsWith("JobOps: "), "every subject is prefixed");
  ok(mail.subject.length < 70, "and fits a phone's lock screen");

  // PLAIN TEXT. No HTML, no images, nothing that has to load to be readable —
  // this has to work on a lock screen at seven in the morning.
  ok(!/<[a-z]+[ >]/i.test(mail.text), "no HTML tags");
  ok(!/http.*\.(png|jpg|gif)/i.test(mail.text), "no images");
  ok(!/style=|<style/i.test(mail.text), "no styling");
  ok(/\*\*/.test(mail.text), "bold is the only emphasis, and it is used");

  ok(/x\.test\/forecast/.test(mail.text), "each line links to the page it is about");
  // THE FOOTER, naming the actual file. "In settings" would be a lie: there is
  // no settings page.
  ok(/config\.yaml/.test(mail.text), "the footer says where to change this");
  ok(/once a day at most/.test(mail.text), "and states the cadence");

  // The ladder, in priority order.
  const at = (s) => mail.text.indexOf(s);
  ok(at("Deloitte") < at("Databricks"), "the window comes before the new role");
  ok(at("Databricks") < at("Last week"), "and the retro is last");
}

/* ---------------------------------------------------------- the test email */

{
  const t = buildTest(new Date("2026-09-02T07:10:00Z"));
  eq(t.kind, "test", "the test email is its own kind");
  ok(/delivery works/.test(t.text), "and says plainly what it proves");
  ok(!/<[a-z]+[ >]/i.test(t.text), "plain text too");
}

/* ---------------------------------------------------------------- config */

ok(NOTIFY.enabled === true, "notifications are on by default");
for (const k of TRIGGERS) {
  ok(NOTIFY.triggers[k] === true, `${k} defaults to on`);
}
eq(Object.keys(NOTIFY.triggers).sort(), [...TRIGGERS].sort(),
   "and config.yaml lists exactly the triggers the code knows about");

/* ================== THE FAILURE PATH, EXECUTED ============================
 *
 * Everything above about failure handling is a REGEX OVER SOURCE: that
 * `if (!r.ok)` appears, that `process.exitCode = 1` appears, that the catch does
 * not end in exit(0). Every one of those was true on the day Resend answered 403
 * and the step reported GREEN. They describe the bug and cannot catch it.
 *
 * Structure verified, value unverified. So this runs notify.mjs for real, with
 * fetch stubbed to answer 403, and demands the OUTCOME: a non-zero exit, the
 * provider's words on screen, and no claim of a send.
 *
 * A CHILD PROCESS, because notify.mjs is a script with no exports — it does its
 * work at import time and there is no function to call. `--import` loads the
 * stub before the main module, so the stub is in place before send() runs.
 *
 * It is safe to run: `--test` builds a fixed test email and skips the entire
 * database block (notify.mjs:138), the stub intercepts the only outbound call
 * so nothing can reach Resend, and the one row record() writes is deleted below.
 */
{
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const { pathToFileURL } = await import("node:url");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobops-notify-stub-"));
  const stub = path.join(dir, "stub.mjs");
  // Announces every interception. Without this the test cannot tell "the stub
  // answered 403" from "the stub never loaded and the call went nowhere" —
  // which would let a green run mean nothing was exercised.
  fs.writeFileSync(stub, `
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("api.resend.com")) {
    console.log("STUB: intercepted " + url);
    const status = Number(process.env.STUB_STATUS);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "Stubbed",
      text: async () => process.env.STUB_BODY || "",
      json: async () => ({}),
    };
  }
  return real(url, init);
};
`);

  const BODY = "The domain is not verified. (stubbed provider message)";
  const runChild = (status) => spawnSync(
    process.execPath,
    ["--import", pathToFileURL(stub).href, "lib/notify.mjs", "--test"],
    {
      cwd: here,
      encoding: "utf8",
      env: {
        ...process.env,
        RESEND_API_KEY: "stub-key-never-used-the-fetch-is-replaced",
        STUB_STATUS: String(status),
        STUB_BODY: BODY,
      },
    },
  );

  // ---- 403: the exact failure that reported green ----
  const bad = runChild(403);
  const badOut = `${bad.stdout || ""}${bad.stderr || ""}`;

  ok(/STUB: intercepted https:\/\/api\.resend\.com/.test(badOut),
     "the stub actually intercepted the send — the test exercised the path");
  ok(bad.status === 1,
     `a 403 exits NON-ZERO (got ${bad.status})`);
  ok(/FAILED to send/.test(badOut),
     "and says it failed");
  ok(badOut.includes(BODY),
     "and prints the provider's own words in full, which is where the reason lives");
  ok(!/notify: sent to/.test(badOut),
     "and never claims it sent anything");

  // ---- 200: the harness can tell success from failure ----
  // Without this the three assertions above would also pass against a notify.mjs
  // that failed on EVERY response, and a test that cannot distinguish is not
  // measuring the condition it names.
  const good = runChild(200);
  const goodOut = `${good.stdout || ""}${good.stderr || ""}`;
  ok(good.status === 0, `a 200 exits zero (got ${good.status})`);
  ok(/notify: sent to/.test(goodOut), "and reports the send");

  fs.rmSync(dir, { recursive: true, force: true });

  // The two child runs each wrote one notifications row. Deleted, because a
  // 'failed' test row is a fact about this test rather than about the mailer.
  try {
    const { run: dbrun } = await import("./lib/driver.js");
    await dbrun("DELETE FROM notifications WHERE kind = ? AND detail LIKE ?",
                ["test", `%${BODY}%`]);
    await dbrun("DELETE FROM notifications WHERE kind = ? AND status = ? AND day = ?",
                ["test", "sent", new Date().toISOString().slice(0, 10)]);
  } catch {
    console.log("  note: could not clean the notifications rows the child wrote "
              + "(no database reachable). They are kind='test'.");
  }
}

/* ============ WINDOW OPENED LEADS THE DIGEST ============================== */
//
// A missed window costs a cycle and nothing recovers it. McKinsey's 2027 window
// closed 11 Aug while companies.yaml said mid/late September; Google APM's ran
// 28 days. A failed pipeline is recoverable by re-running the pipeline. That is
// "irreversibility beats urgency" -- the rule that already orders Daily --
// applied to the digest.

const OPENED_PAGE = {
  url: "https://example.invalid/apm", label: "Google APM",
  last_status_hit: 1, last_changed_at: "2026-09-07T02:00:00Z",
  last_diff: "ADDED:\n  + Applications are now open.",
};
const MOVED_PAGE = {
  url: "https://example.invalid/x", label: "Adobe university",
  last_status_hit: 0, last_changed_at: "2026-09-07T02:00:00Z",
  last_diff: "ADDED:\n  + New rotation added.",
};

{
  // The worst case: a window opened AND the run failed. The opening still wins.
  const fired = evaluateTriggers({
    run: { status: "failure", run_url: "https://example.invalid/run" },
    pages: { changed: [OPENED_PAGE, MOVED_PAGE], broken: [], total: 15, ok: true },
    cfg: { triggers: {} }, today: "2026-09-07",
  });
  const keys = fired.map((f) => f.group || f.key);
  ok(keys[0] === "window_opened",
     `WINDOW OPENED leads even a failed run, got ${JSON.stringify(keys)}`);
  ok(keys.includes("pipeline_failure"), "and the failure is still reported");
  ok(keys.indexOf("window_opened") < keys.indexOf("pipeline_failure"),
     "strictly above it");

  const mail = buildDigest({ fired, cfg: {}, now: new Date("2026-09-07T07:10:00Z") });
  ok(/^JobOps: WINDOW OPENED/.test(mail.subject),
     `and takes the subject line: ${mail.subject}`);
  const body = mail.text;
  ok(body.indexOf("WINDOW OPENED") < body.indexOf("daily run finished"),
     "and appears above the failure in the body");

  // THE PAGE THAT MERELY CHANGED IS NOT REPEATED AT THE TOP.
  const first = body.slice(0, body.indexOf("daily run finished"));
  ok(!first.includes("Adobe university"),
     "a page that only changed is not in the WINDOW OPENED block");
  ok(body.includes("Adobe university"), "but is reported further down");

  // AND THE OPENED PAGE IS NOT REPEATED BELOW. Listing it twice makes the one
  // line that matters read as part of a list -- which is the whole reason it
  // was pulled to the top. Counted, not eyeballed: the earlier version of this
  // check looked at the wrong label and passed while the page appeared twice.
  const hits = body.split("Google APM").length - 1;
  ok(hits === 1, `the opened page appears exactly once, found ${hits}`);
  ok(keys.indexOf("pages_changed") > keys.indexOf("board_anomaly")
     || !keys.includes("board_anomaly"),
     "pages_changed sits below a board anomaly");
}

/* A page that changed WITHOUT opening a window is news, not an emergency. */
{
  const fired = evaluateTriggers({
    pages: { changed: [MOVED_PAGE], broken: [], total: 15, ok: true },
    cfg: { triggers: {} }, today: "2026-09-07",
  });
  const keys = fired.map((f) => f.group || f.key);
  ok(!keys.includes("window_opened"), "no window opened, so no such line");
  ok(keys.includes("pages_changed"), "but the change is reported");
  const mail = buildDigest({ fired, cfg: {} });
  ok(/New rotation added/.test(mail.text), "and carries the diff");
}

/* THE DIFF IS CAPPED IN THE EMAIL TOO. watch_pages caps at 5 KB; six pages of
 * that would still be 30 KB of email. */
{
  const many = Array.from({ length: 9 }, (_, n) => ({
    url: `https://example.invalid/${n}`, label: `Page ${n}`,
    last_status_hit: 0, last_changed_at: "2026-09-07T02:00:00Z",
    last_diff: Array.from({ length: 40 }, (_, k) => `  + line ${k}`).join("\n"),
  }));
  const fired = evaluateTriggers({
    pages: { changed: many, broken: [], total: 15, ok: true },
    cfg: { triggers: {} }, today: "2026-09-07",
  });
  const block = fired.find((f) => f.key === "pages_changed");
  ok(block.lines.some((l) => /and 3 more changed/.test(l)),
     "only six pages are listed and the rest are counted");
  // Indented lines are diff lines PLUS the trailing "and N more changed",
  // which is also indented -- 6 pages x 8 lines + 1.
  const diffLines = block.lines.filter(
    (l) => /^ {4}/.test(l) && !/more changed/.test(l)).length;
  ok(diffLines <= 6 * 8, `each diff is capped at 8 lines (${diffLines} total)`);
  ok(diffLines > 0, "and diff lines are actually present, not silently dropped");
}

/* ============ THE ON-TRACK LINE RIDES THE HEAD ========================== */
//
// Beside the counter, and NOT its own trigger: an email that arrives daily
// whether or not anything happened gets filtered, and then the one that
// mattered lands in the same folder.

{
  const fired = evaluateTriggers({
    pages: { changed: [MOVED_PAGE], broken: [], total: 15, ok: true },
    cfg: { triggers: {} }, today: "2026-09-07",
  });
  const withLine = buildDigest({
    fired, cfg: {},
    onTrack: { line: "Week 36 of the search: 0 of 3 applications this month, "
      + "0 of 5 messages this week, 0 replies. Behind on all three.", red: true },
  });
  ok(/Behind on all three/.test(withLine.text), "the on-track line is in the mail");
  ok(withLine.text.indexOf("Behind on all three")
     < withLine.text.indexOf("Adobe university"),
     "above the sections, beside the counter");

  // AND IT DOES NOT SEND ON ITS OWN.
  ok(buildDigest({ fired: [], cfg: {}, onTrack: { line: "x", red: true } }) === null,
     "an on-track line alone does not send a digest");
}

/* ============ THE NUMBERED SECTION ORDER, AND THE CAPS =================== */
//
// The digest used to be every fired trigger concatenated by priority: right
// about order, silent about length. A morning with nine roles, six packs and
// four drafts produced an email nobody finishes -- and an email nobody
// finishes is one where the line at the top stops being read.

ok(SECTIONS[0].key === "window_opened",
   `WINDOW OPENED is section 1, got ${SECTIONS[0].key}`);
ok(SECTIONS[SECTIONS.length - 1].key === "board_anomaly",
   "health is last, because a fixed thing at the top gets scrolled past");
ok(SECTIONS[SECTIONS.length - 1].always === true, "and is always present");

/* THE CAPS ARE REAL. A section over its cap says how many it left out --
 * "and 4 more" is a different fact from a section that has six things in it. */
{
  const many = Array.from({ length: 14 }, (_, n) => `role number ${n}`);
  const out = orderSections([{ key: "new_excellent", lines: many }]);
  const sec = out.find((x) => x.key === "new_excellent");
  ok(sec.lines.length === 9, `capped at 8 plus the note (${sec.lines.length})`);
  ok(/and 6 more/.test(sec.lines[8]), `and says how many: ${sec.lines[8]}`);
}

/* UNDER THE CAP, NOTHING IS SAID. A count on a short list is noise. */
{
  const out = orderSections([{ key: "new_excellent", lines: ["one", "two"] }]);
  ok(out[0].lines.length === 2, "a short section is untouched");
  ok(!out[0].lines.some((l) => /more/.test(l)), "and carries no 'and N more'");
}

/* ORDER IS ENFORCED REGARDLESS OF INPUT ORDER. */
{
  const out = orderSections([
    { key: "weekly_retro", lines: ["retro"] },
    { key: "board_anomaly", lines: ["health"] },
    { key: "window_opened", lines: ["OPENED"] },
    { key: "new_excellent", lines: ["role"] },
  ]);
  const keys = out.map((x) => x.key);
  ok(keys[0] === "window_opened", `window_opened first, got ${keys.join(",")}`);
  ok(keys[keys.length - 1] === "board_anomaly", "health last");
  ok(keys.indexOf("new_excellent") < keys.indexOf("weekly_retro"),
     "roles above the Monday retro");
}

/* AN EMPTY SECTION IS OMITTED. A heading with nothing under it reads as a
 * quiet day, and this project has three incidents where "nothing to show" and
 * "this has never worked" looked identical. */
{
  const out = orderSections([{ key: "window_opened", lines: [] },
                             { key: "new_excellent", lines: ["role"] }]);
  ok(!out.some((x) => x.key === "window_opened"),
     "a section with no lines does not appear");
  ok(out.length === 1, "only the section with content is rendered");
}

/* A TRIGGER BELONGING TO NO SECTION IS STILL PRINTED. Dropping it silently
 * would be the always-empty-source failure with an email attached. */
{
  const mail = buildDigest({
    fired: [{ key: "some_future_trigger", subject: "x", lines: ["unplaced line"] }],
    cfg: {},
  });
  ok(/unplaced line/.test(mail.text),
     "an unknown trigger is appended rather than vanishing");
}

/* ============ A DAY WITH NO RUN IS A FAILURE ============================= */
//
// pipeline_status held ONE row, overwritten every run, so a run that died
// before the record step left no trace and the next run buried the evidence.
// The 2026-09-08 audit found 09-01 and 09-03 simply absent, with nothing to
// say whether they failed or never fired -- and nothing alerted either way.
//
// BEHAVIOURAL, not structural: these drive missedRunDays() and evaluateTriggers()
// with real history shapes and assert what actually fires.

const ALL_OK = "fetch=success,watch=success,gate=success,score=success";
// Rows as recordrun writes them: a local date AND the instant it finished.
const done = (day, extra = {}) =>
  ({ day, status: "success", finished_at: `${day}T17:40:00+00:00`, ...extra });
const at = (day, hhmm = "17:40") => `${day}T${hhmm}:00+00:00`;

/* ── HOURS, NOT CALENDAR DAYS ──────────────────────────────────────────────
 *
 * The cron is scheduled at 14:10 UTC and starts 2.5-4.5 hours late every
 * morning (10:48, 10:34, 09:47, 09:57, 11:42 PDT over 3-7 September), so two
 * consecutive HEALTHY runs sit 22 to 26 hours apart. A skipped day is 46 to
 * 50. STALE_RUN_HOURS = 30 is the empty space between them.
 *
 * A calendar day is not a duration, which is the actual defect: two runs 25
 * hours apart and two runs 2 hours apart across midnight both read as "1 day". */

ok(STALE_RUN_HOURS === 30, "the staleness threshold is 30 hours");

ok(Math.round(hoursSinceCompletedRun([done("2026-09-07")], at("2026-09-08"))) === 24,
   "24 hours since yesterday's run at the same time");
ok(hoursSinceCompletedRun([done("2026-09-08")], at("2026-09-08", "17:45")) < 1,
   "a run minutes ago is a fraction of an hour");
ok(Math.round(hoursSinceCompletedRun(
     [done("2026-09-01"), done("2026-09-05")], at("2026-09-08"))) === 72,
   "it measures from the LATEST completed run, not the first");

/* THE WORST HEALTHY GAP STILL DOES NOT FIRE. Latest possible run one day
 * (11:42 PDT = 18:42 UTC) then earliest the next (09:47 PDT = 16:47 UTC) is
 * the tightest pair; the reverse is the widest at just under 26 hours. */
const widest = hoursSinceCompletedRun(
  [{ day: "2026-09-06", status: "success", stages: ALL_OK,
     finished_at: at("2026-09-06", "16:47") }], at("2026-09-07", "18:42"));
ok(widest > 25 && widest < 26, `the widest healthy gap is ~26h (${widest})`);
ok(widest < STALE_RUN_HOURS,
   "and it does NOT reach the threshold — a late cron must not read as a "
   + "missed run, which is the whole reason this is hours and not dates");

/* AND A SKIPPED DAY DOES. Otherwise the threshold is just silence. */
ok(hoursSinceCompletedRun([done("2026-09-06")], at("2026-09-08")) >= STALE_RUN_HOURS,
   "a genuinely skipped day clears the threshold comfortably");

ok(staleFor(31) === "31 hours", "under two days it speaks in hours");
ok(staleFor(50) === "2 days", "beyond that, in days");

/* THE DIGEST MUST ACTUALLY SELECT THE COLUMNS THE RULE READS.
 *
 * This is not pedantry. The first version of the query asked for `day, status`
 * only, so every row reached runCompleted() with `stages` undefined, the
 * no-stages fallback fired, and the stage checking written for daily #21 was
 * INERT in the one place it runs. Nothing went red: the tests above hand rows
 * in directly, and a column that was never selected reads exactly like a
 * column that is null.
 *
 * So: read the real query out of notify.mjs and require every field the two
 * functions touch to be in it. */
{
  const q = sender.slice(sender.indexOf("FROM pipeline_runs") - 400,
                         sender.indexOf("FROM pipeline_runs"));
  for (const col of ["day", "status", "stages", "finished_at"]) {
    ok(new RegExp(`\\b${col}\\b`).test(q),
       `the digest's pipeline_runs query selects ${col} — runCompleted() and `
       + "hoursSinceCompletedRun() both read it, and an unselected column is "
       + "indistinguishable from a null one");
  }
  ok(/nowIso:/.test(sender),
     "and it passes nowIso, because staleness is a duration and a date "
     + "cannot measure one");
}

/* ── A ROW IS NOT A RUN ────────────────────────────────────────────────────
 *
 * daily #21, 2026-09-08. The scoring step blocked on a synchronous poll of the
 * Batch API for 27m49s; the job was cancelled at its 30-minute timeout; and
 * "Record the run" -- which is `if: always()` precisely so it can report a
 * failure -- then completed green in ONE SECOND and wrote a row.
 *
 * A presence check reads that morning as "the pipeline ran". Nothing had been
 * scored. The data was exactly as stale as if the run had never fired, and the
 * alert built to catch that stayed silent. These drive the shipped
 * runCompleted() with the row that run actually wrote. */

ok(runCompleted(done("2026-09-08", { stages: ALL_OK })) === true,
   "a run with every stage green is complete");
ok(runCompleted({ day: "2026-09-08", status: "cancelled", stages: ALL_OK }) === false,
   "a CANCELLED job is not, whatever its stages claim");
ok(runCompleted({ day: "2026-09-08", status: "failure", stages: ALL_OK }) === false,
   "nor is a failed one");

/* THE #21 SHAPE EXACTLY: fetch and gate green, score never started, so its
 * outcome is the empty string the workflow interpolates for a step that did
 * not run. The job status alone would not have to be wrong for this to
 * matter -- the stage list is what makes a partial run legible. */
const PARTIAL = "fetch=success,watch=success,gate=success,score=,deadlines=";
ok(runCompleted({ day: "2026-09-08", status: "success", stages: PARTIAL }) === false,
   "a run whose scoring stage never ran is NOT complete, even if the job "
   + "somehow came out green");
ok(runCompleted({ day: "2026-09-08", status: "success",
                  stages: "fetch=success,watch=failure,gate=success,score=success" }) === true,
   "but a failed WATCH stage does not disqualify it -- that step is "
   + "continue-on-error by design and produces nothing else reads");

/* THE MIGRATION BOUNDARY IS CLOSED BY DATE, not left open.
 *
 * Two rows predate the workflow reporting stages -- 09-07 and 09-08 -- and
 * they are grandfathered. Everything from STAGES_REQUIRED_FROM on must carry
 * a stage list, because an open-ended "no stages means trust the job status"
 * is indistinguishable from a workflow that has quietly STOPPED reporting
 * them: every future row would take the fallback, partial-run detection would
 * die, and nothing would go red. */
ok(runCompleted({ day: "2026-09-07", status: "success", stages: null }) === true,
   "a legacy row from before the cutoff falls back to the job status");
ok(runCompleted({ day: "2026-09-07", status: "cancelled", stages: null }) === false,
   "and a legacy CANCELLED row still does not count");
ok(STAGES_REQUIRED_FROM === "2026-09-09",
   "the cutoff is the day after the workflow started reporting stages");
ok(runCompleted({ day: STAGES_REQUIRED_FROM, status: "success", stages: null })
     === false,
   "ON the cutoff, a green run with NO stage list is not complete -- a "
   + "workflow that stopped reporting them must be audible, not assumed fine");
ok(runCompleted({ day: "2027-01-01", status: "success", stages: null }) === false,
   "and it stays that way, so the fallback cannot silently become permanent");
ok(runCompleted({ day: STAGES_REQUIRED_FROM, status: "success",
                  stages: ALL_OK }) === true,
   "while a row that DOES report its stages is judged on them as before");

/* THE COUNT ITSELF SKIPS THE CANCELLED RUN. This is the assertion that would
 * have gone red on the morning of 09-09. */
ok(Math.round(hoursSinceCompletedRun(
     [done("2026-09-07", { stages: ALL_OK }),
      { day: "2026-09-08", status: "cancelled", stages: PARTIAL,
        finished_at: at("2026-09-08") }], at("2026-09-09"))) === 48,
   "a cancelled run does not reset the clock -- it measures back to 09-07, "
   + "the last morning anything actually finished");

/* NOTHING IN THE WINDOW COMPLETED. The last good run is older than every row
 * here, so the span back to the OLDEST is a floor -- an understatement of the
 * gap, never an overstatement. */
ok(Math.round(hoursSinceCompletedRun(
     [{ day: "2026-09-06", status: "failure", finished_at: at("2026-09-06") },
      { day: "2026-09-07", status: "cancelled", finished_at: at("2026-09-07") }],
     at("2026-09-08"))) === 48,
   "a window with no completed run reports at least the window's own span");

/* NULL, NOT ZERO, when history cannot be read. "The table is unreachable" and
 * "the run happened this morning" must never look alike. */
ok(hoursSinceCompletedRun(null, at("2026-09-08")) === null,
   "unreadable history is null");
ok(hoursSinceCompletedRun([], at("2026-09-08")) === null,
   "and so is an empty table");
ok(hoursSinceCompletedRun([done("2026-09-07")], null) === null, "and no now");

/* THE RUN DIED BEFORE RECORDING. This is the exact scenario: yesterday's row
 * exists, today's does not, and the job status was never written. */
{
  const fired = evaluateTriggers({
    run: null,                              // nothing recorded for today
    runs: [{ day: "2026-09-06", status: "success" },
           { day: "2026-09-07", status: "success" }],
    today: "2026-09-09",                    // two days later
    cfg: { triggers: {} },
  });
  const keys = fired.map((f) => f.group || f.key);
  ok(keys.includes("pipeline_failure"),
     `a missing run fires pipeline_failure, got ${JSON.stringify(keys)}`);
  const m = fired.find((f) => (f.group || f.key) === "pipeline_failure");
  ok(/no completed run for 2 days/.test(m.subject),
     `and says how long: ${m.subject}`);
  ok(m.lines.some((l) => /FAILURE, not an unknown/.test(l)),
     "and states that a missing day is a failure");
  const mail = buildDigest({ fired, cfg: {} });
  ok(mail !== null, "and it actually sends -- silence is what it replaces");
}

/* A RUN THAT DID HAPPEN FIRES NOTHING. The rule must discriminate, or it is a
 * daily alarm rather than a signal. */
{
  const fired = evaluateTriggers({
    runs: [{ day: "2026-09-08", status: "success", stages: ALL_OK }],
    today: "2026-09-08", cfg: { triggers: {} },
  });
  ok(!fired.some((f) => String(f.key).startsWith("missing_run")),
     "a completed run recorded today fires no missing-run alert");
}

/* ── THE ONE THE OWNER ASKED FOR ───────────────────────────────────────────────
 *
 * A run cancelled mid-stage that STILL WRITES A ROW must trigger the alert.
 * This drives the whole path -- evaluateTriggers, the subject, the digest --
 * with the row daily #21 actually left behind. */
{
  const fired = evaluateTriggers({
    // The pointer says cancelled, so trigger 1 fires too. What is being
    // asserted here is that 1a ALSO fires: trigger 1 says "the last run
    // failed" and 1a is the only thing that says how stale that leaves the
    // data. They answer different questions.
    run: { status: "cancelled", run_url: "https://example.invalid/21" },
    runs: [{ day: "2026-09-07", status: "success", stages: ALL_OK },
           { day: "2026-09-08", status: "cancelled",
             stages: "fetch=success,watch=success,gate=success,score=," }],
    today: "2026-09-09",
    cfg: { triggers: {} },
  });
  const missing = fired.find((f) => String(f.key).startsWith("missing_run"));
  ok(missing,
     "a run cancelled mid-stage that still wrote a row TRIGGERS the alert -- "
     + "it is the silent-success failure the alert exists to catch");
  ok(/no completed run for 2 days/.test(missing?.subject || ""),
     `and counts back past it: ${missing?.subject}`);
  const mail = buildDigest({ fired, cfg: {} });
  ok(mail && /finish every stage/.test(
       mail.text || mail.body || JSON.stringify(mail)),
     "and its LINES reach the digest body, not just the subject -- a trigger "
     + "that is computed and dropped is the same as one that never fired");
}

/* ── A REAPING MORNING IS NOT A STALE ONE ──────────────────────────────────
 *
 * The reaper returns 1 when it clears a batch stuck past 24h, so the score
 * step goes red and `score=failure` lands in the stage list. That run is
 * therefore NOT complete, and under a calendar-day rule it would have counted
 * as "1 day missed" and fired the staleness alert on top of pipeline_failure.
 *
 * It should not. The fetch ran, the gate ran, new work was submitted -- the
 * data is one normal day old, not stale. Measuring in hours is what separates
 * the two: yesterday's completed run is ~24h back, under the 30-hour mark.
 *
 * pipeline_failure still fires, and that is the correct single alert. */
{
  const fired = evaluateTriggers({
    run: { status: "failure", run_url: "https://example.invalid/reap" },
    runs: [
      { day: "2026-09-07", status: "success", stages: ALL_OK,
        finished_at: at("2026-09-07", "16:47") },   // healthy, earliest slot
      { day: "2026-09-08", status: "failure",       // reaped this morning
        stages: "fetch=success,watch=success,gate=success,score=failure",
        finished_at: at("2026-09-08", "18:42") },   // latest slot: 25.9h later
    ],
    nowIso: at("2026-09-08", "18:45"),
    today: "2026-09-08",
    cfg: { triggers: {} },
  });
  ok(!fired.some((f) => String(f.key).startsWith("missing_run")),
     "a reaping morning fires NO staleness alert -- the data is a normal "
     + "day old, and this is the widest healthy gap the late cron produces");
  ok(fired.some((f) => f.key === "pipeline_failure"),
     "but pipeline_failure DOES fire, so the reap is still reported once");
}

/* AND TWO IN A ROW DOES FIRE. Otherwise the rule above is just silence. */
{
  const fired = evaluateTriggers({
    run: { status: "failure", run_url: "https://example.invalid/reap2" },
    runs: [
      { day: "2026-09-07", status: "success", stages: ALL_OK,
        finished_at: at("2026-09-07", "16:47") },
      { day: "2026-09-08", status: "failure", finished_at: at("2026-09-08") },
      { day: "2026-09-09", status: "failure", finished_at: at("2026-09-09") },
    ],
    nowIso: at("2026-09-09", "18:45"),
    today: "2026-09-09",
    cfg: { triggers: {} },
  });
  ok(fired.some((f) => String(f.key).startsWith("missing_run")),
     "two failed mornings running DOES fire it -- at ~50 hours the data is "
     + "genuinely stale, whatever each individual run reported");
}

/* ── A BROKEN WATCHER IS NOT A QUIET DAY ───────────────────────────────────
 *
 * watchedPageNews() computed `broken` from the day it was written and NO
 * trigger read it, so a page whose fetch had been failing for a week produced
 * no line anywhere. The digest said "nothing changed" -- which is exactly what
 * it says when a page genuinely has not changed.
 *
 * These are the pages nothing else can see. Consulting, the APM cohorts and
 * the primes' rotational programmes have no machine-readable board and never
 * will, so the watcher is the only thing that can report their window opening.
 * McKinsey's 2027 window shut on 11 August while companies.yaml said mid/late
 * September, and nothing noticed. */
{
  const brokenFor = (n) => ({
    changed: [], total: 15, ok: true,
    broken: [{ url: "https://mck.example/careers", label: "McKinsey",
               last_error: "HTTP 403", fail_streak: n }],
  });

  ok(WATCHER_BROKEN_DAYS === 3, "three consecutive failures, not one");

  const blip = evaluateTriggers({
    pages: brokenFor(1), today: "2026-09-09", cfg: { triggers: {} },
  });
  ok(!blip.some((f) => String(f.key).startsWith("watcher_broken")),
     "ONE failed fetch says nothing -- a careers page having a bad night must "
     + "not put a line in the digest, or the line gets skimmed past");

  const dead = evaluateTriggers({
    pages: brokenFor(WATCHER_BROKEN_DAYS), today: "2026-09-09",
    cfg: { triggers: {} },
  });
  const w = dead.find((f) => String(f.key).startsWith("watcher_broken"));
  ok(w, "three in a row DOES fire -- that is a watcher that has stopped "
     + "working, on a page nothing else in the pipeline can read");
  ok(/unreadable/.test(w?.subject || ""), `and says so: ${w?.subject}`);
  ok((w?.lines || []).some((l) => /McKinsey/.test(l)),
     "naming the page, so it can be checked by hand");
  ok((w?.lines || []).some((l) => /403/.test(l)),
     "and carrying the actual error rather than a generic one");
  ok(buildDigest({ fired: dead, cfg: {} }) !== null,
     "and it reaches an email rather than being computed and dropped");

  /* IT STOPS WHEN THE PAGE RECOVERS, and does not repeat within a day. */
  const recovered = evaluateTriggers({
    pages: { changed: [], broken: [], total: 15, ok: true },
    today: "2026-09-09", cfg: { triggers: {} },
  });
  ok(!recovered.some((f) => String(f.key).startsWith("watcher_broken")),
     "a recovered page simply stops appearing");
  const again = evaluateTriggers({
    pages: brokenFor(5), today: "2026-09-09", cfg: { triggers: {} },
    alreadyFired: new Set([
      "watcher_broken:2026-09-09:https://mck.example/careers"]),
  });
  ok(!again.some((f) => String(f.key).startsWith("watcher_broken")),
     "and a still-broken one speaks once a day, not once a run");

  /* AN UNREADABLE WATCH TABLE IS NOT AN EMPTY ONE. */
  const cantRead = evaluateTriggers({
    pages: null, today: "2026-09-09", cfg: { triggers: {} },
  });
  ok(!cantRead.some((f) => String(f.key).startsWith("watcher_broken")),
     "a null pages read fires no watcher line (health covers that state)");
}

/* ── A BROKEN BOARD ESCALATES ONCE, THEN GOES QUIET ────────────────────────
 *
 * The daily anomaly line is keyed by day, so a board that stays broken
 * produces one line every morning forever. `ashby/mach` did exactly that: a
 * slug that was never Mach Industries', flagged every single day since the
 * board_fetches table was created, with no answer available except editing
 * companies.yaml. A health section people learn to skip is worse than none,
 * because the morning a REAL board dies it looks like the wallpaper.
 *
 * BEHAVIOURAL, FOUR CONSECUTIVE DAYS, driven through the real boardAnomalies()
 * and evaluateTriggers() with real board_fetches rows. It simulates the digest
 * the way the digest actually works: alreadyFired accumulates across days,
 * because that set is every key ever emailed. */
{
  const days = ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"];
  // A board that used to list 40 roles and now answers with none: `zeroed`,
  // the renamed-slug case. Plus one healthy board, so "no anomalies" cannot
  // pass by there being no boards at all.
  const rows = [
    { day: "2026-09-05", source: "ashby", slug: "acme", display_name: "Acme",
      n_roles: 40, error: null },
    { day: "2026-09-05", source: "greenhouse", slug: "fine", display_name: "Fine",
      n_roles: 12, error: null },
  ];
  for (const d of days) {
    rows.push({ day: d, source: "ashby", slug: "acme", display_name: "Acme",
                n_roles: 0, error: null });
    rows.push({ day: d, source: "greenhouse", slug: "fine", display_name: "Fine",
                n_roles: 12, error: null });
  }

  ok(BOARD_ESCALATE_DAYS === 3, "a board escalates after three bad fetches");

  const alreadyFired = new Set();
  const perDay = [];
  for (const d of days) {
    const health = boardAnomalies(rows, d);
    const fired = evaluateTriggers({
      health, today: d, cfg: { triggers: {} }, alreadyFired,
    });
    for (const f of fired) alreadyFired.add(f.key);
    perDay.push(fired);
  }

  const esc = perDay.map((f) =>
    f.filter((x) => String(x.key).startsWith("board_escalation:")));
  const daily = perDay.map((f) =>
    f.filter((x) => String(x.key).startsWith("board_anomaly:")));

  // THE ASSERTION THE OWNER ASKED FOR: four days, exactly one escalation.
  const totalEsc = esc.reduce((n, f) => n + f.length, 0);
  ok(totalEsc === 1,
     `four days of the same broken board produce exactly ONE escalation `
     + `(${totalEsc}: ${JSON.stringify(esc.map((f) => f.length))})`);
  ok(esc[2].length === 1,
     `and it lands on the THIRD bad day, not the first `
     + `(${JSON.stringify(esc.map((f) => f.length))})`);
  ok(esc[0].length === 0 && esc[1].length === 0,
     "one bad morning and two are an outage, not a decision");
  ok(esc[3].length === 0, "and day four repeats nothing");

  // AND THE DAILY LINE STOPS TOO. Without this the escalation is an EXTRA
  // email rather than a replacement, and the board it was written to silence
  // keeps appearing underneath it every morning.
  ok(daily[0].length === 1 && daily[1].length === 1,
     "the ordinary anomaly line runs on days one and two");
  ok(daily[2].length === 0 && daily[3].length === 0,
     `and stops once the board has escalated `
     + `(${JSON.stringify(daily.map((f) => f.length))})`);

  const e = esc[2][0];
  ok(/broken 3 days/.test(e.subject), `the escalation says how long: ${e.subject}`);
  ok(e.lines.some((l) => /retired:/.test(l)),
     "and names the two decisions available, one of which is retiring it");
  ok(e.lines.some((l) => /2026-09-06/.test(l)),
     "and when the run of failures started");

  /* IT SPEAKS AGAIN AFTER A RECOVERY. Keyed on the board alone it would fire
   * once and never again, so a board that recovered and broke a month later
   * would be silent -- which is the failure this rule creates if the key is
   * chosen carelessly. The key carries the day the OUTAGE started. */
  const later = [...rows,
    { day: "2026-09-10", source: "ashby", slug: "acme", display_name: "Acme",
      n_roles: 40, error: null },
    ...["2026-09-11", "2026-09-12", "2026-09-13"].map((d) => (
      { day: d, source: "ashby", slug: "acme", display_name: "Acme",
        n_roles: 0, error: null })),
  ];
  const again2 = evaluateTriggers({
    health: boardAnomalies(later, "2026-09-13"), today: "2026-09-13",
    cfg: { triggers: {} }, alreadyFired,
  });
  ok(again2.some((f) => String(f.key).startsWith("board_escalation:")),
     "a board that recovered and broke AFRESH escalates again -- the key "
     + "carries the day the outage started, not just the board");

  /* AND A HEALTHY MORNING STILL SAYS NOTHING AT ALL. */
  const clean = evaluateTriggers({
    health: boardAnomalies([
      { day: "2026-09-09", source: "greenhouse", slug: "fine",
        display_name: "Fine", n_roles: 12, error: null }], "2026-09-09"),
    today: "2026-09-09", cfg: { triggers: {} },
  });
  ok(!clean.some((f) => String(f.key).startsWith("board_")),
     "a morning with every board answering fires nothing");
}

/* AN EMPTY RUN IS NEVER MUTED. It is a statement about the whole run rather
 * than one board, there is no per-board decision to take, and "every board
 * returned nothing" is the loudest thing this system can say. */
{
  const rows = [];
  for (const d of ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"]) {
    for (const slug of ["a", "b", "c"]) {
      rows.push({ day: d, source: "ashby", slug, display_name: slug,
                  n_roles: 0, error: null });
    }
  }
  const alreadyFired = new Set();
  let lastDay = [];
  for (const d of ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"]) {
    lastDay = evaluateTriggers({
      health: boardAnomalies(rows, d), today: d, cfg: { triggers: {} },
      alreadyFired,
    });
    for (const f of lastDay) alreadyFired.add(f.key);
  }
  ok(lastDay.some((f) => f.group === "board_anomaly"),
     "on the fourth day of every board returning nothing, the digest still "
     + "speaks -- an empty run is not a board that can be retired");

  /* AND THE KIND CHECK IS REACHABLE, which the test above does not settle.
   *
   * boardAnomalies() attaches brokenDays to the three PER-BOARD kinds and not
   * to empty_run, so today the `kind !== "empty_run"` guard never decides
   * anything -- the streak is undefined and the threshold rejects it anyway.
   * A limit nothing can drive is a limit nobody knows works, and the day
   * someone attaches a streak to empty_run the muting would start silently.
   *
   * So hand evaluateTriggers the shape that would exist then. */
  const withStreak = evaluateTriggers({
    health: {
      day: "2026-09-09", ok: false, boards: [], totalRoles: 0,
      anomalies: [{ kind: "empty_run", source: null, slug: null, name: null,
                    brokenDays: 9, brokenSince: "2026-09-01",
                    line: "Every board returned nothing." }],
    },
    today: "2026-09-09", cfg: { triggers: {} },
  });
  ok(!withStreak.some((f) => String(f.key).startsWith("board_escalation:")),
     "an empty_run carrying a long streak is still NOT escalated away -- "
     + "there is no per-board decision to take and it must never be muted");
  ok(withStreak.some((f) => String(f.key).startsWith("board_anomaly:")),
     "it keeps its ordinary line instead");
}

/* ── THE APPLY LOG GOING QUIET ─────────────────────────────────────────────
 *
 * If the owner stops pasting, or the bot stops producing a log, applied_apps
 * simply stops growing -- and a table that stops growing looks exactly like a
 * table nobody has written to yet. Nothing else in this system can tell those
 * apart, which is this project's own #1 failure class.
 *
 * MONDAY ONLY, and `retro` is the Monday signal: mondayRetro() returns null
 * outright on every other day, so its presence IS the day of the week and
 * nothing new had to be threaded through to get one. */
{
  const RETRO = { empty: false, lines: ["3 sent, 1 reply."] };
  const stale = { stale: true, never: false, days: 5.2 };
  const fresh = { stale: false, never: false, days: 1.1 };
  const never = { stale: false, never: true, days: null };

  const fire = (o) => evaluateTriggers({ today: "2026-09-14", cfg: { triggers: {} }, ...o });
  const retroOf = (f) => f.find((x) => x.group === "weekly_retro");

  ok(!retroOf(fire({ retro: null, grok: stale })),
     "a stale apply log says NOTHING on a Tuesday -- retro is null on every "
     + "day but Monday, and this rides on the Monday digest");

  const monday = retroOf(fire({ retro: RETRO, grok: stale }));
  ok(monday, "on Monday the retro fires");
  ok(monday.lines.some((l) => /not been imported for 5 days/.test(l)),
     `and carries the warning: ${JSON.stringify(monday?.lines)}`);
  ok(monday.lines.some((l) => /\/applications/.test(l)),
     "with a link to the page that fixes it");
  ok(monday.lines.some((l) => /3 sent, 1 reply/.test(l)),
     "without displacing what the retro already said");

  const ok1 = retroOf(fire({ retro: RETRO, grok: fresh }));
  ok(ok1 && !ok1.lines.some((l) => /not been imported/.test(l)),
     "a fresh import adds no line at all");

  /* NEVER-IMPORTED IS NOT STALE. An alarm about a feature that has not been
   * started yet is the noise that teaches you to skim the section it lives
   * in; the page carries a setup line instead. */
  const ok2 = retroOf(fire({ retro: RETRO, grok: never }));
  ok(ok2 && !ok2.lines.some((l) => /not been imported/.test(l)),
     "and never having imported is NOT reported as staleness");

  /* IT SPEAKS EVEN ON A QUIET MONDAY. An empty retro sends nothing, so
   * without this the warning would be suppressed by exactly the weeks in
   * which nothing happened -- which is when it matters most. */
  const quiet = retroOf(fire({ retro: { empty: true, lines: [] }, grok: stale }));
  ok(quiet, "a stale log fires the Monday digest even when the retro is empty");
  ok(/apply log has gone quiet/.test(quiet?.subject || ""),
     `and the subject says which of the two it is: ${quiet?.subject}`);
  ok(buildDigest({ fired: [quiet], cfg: {} }) !== null,
     "and it reaches an email rather than being computed and dropped");

  /* AND AN EMPTY RETRO WITH A FRESH LOG STILL SENDS NOTHING. Otherwise the
   * rule above is "always email on Monday", which is the habit-forming noise
   * the whole trigger design exists to avoid. */
  ok(!retroOf(fire({ retro: { empty: true, lines: [] }, grok: fresh })),
     "a quiet Monday with a healthy log sends nothing");
  ok(!retroOf(fire({ retro: { empty: true, lines: [] }, grok: null })),
     "and so does one where the log state could not be read");
}

/* ONCE A DAY, NOT EVERY LOAD. alreadyFired carries the key. */
{
  const fired = evaluateTriggers({
    runs: [{ day: "2026-09-06" }], today: "2026-09-08",
    alreadyFired: new Set(["missing_run:2026-09-08"]),
    cfg: { triggers: {} },
  });
  ok(!fired.some((f) => String(f.key).startsWith("missing_run")),
     "an already-sent missing-run alert does not repeat the same day");
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");

  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
