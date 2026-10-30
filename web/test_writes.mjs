/**
 * Every write path on the People page, exercised through the actual UI.
 *
 *   node test_writes.mjs          # builds nothing; needs a build in NEXT_DIST_DIR
 *
 * WHY THIS EXISTS, in CLAUDE.md's own words: "A rendered-output diff verifies
 * reads only. Every write needs a manual exercise." The SQLite-to-Postgres
 * snapshot diff came back IDENTICAL across 911 rows while "Add an item" was
 * completely broken, because `INSERT OR IGNORE` is SQLite-only. No amount of
 * diffing could have found it. Only clicking the button did.
 *
 * So this clicks the buttons. It fills the add form, logs an interaction, drafts
 * a message, copies it, undoes that, and edits a template — and after each one
 * it goes to the DATABASE and checks the row actually landed. Confirming that a
 * button did not throw is not the same as confirming it wrote.
 *
 * IT REFUSES TO RUN AGAINST NEON unless told to. It creates real rows about a
 * fictional person and deletes them afterwards, and a cleanup that fails
 * halfway would leave a fake contact in the tracker — which is worse than an
 * untested feature, the same reasoning that deleted the two fabricated window
 * checks. JOBOPS_LOCAL_DB=1 is the default expectation; JOBOPS_WRITE_TEST_PROD=1
 * is the deliberate override.
 *
 * The cleanup runs in a `finally`, and it runs even when the test fails, and it
 * reports what it removed. A test that leaves debris is a test people stop
 * running.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { COOKIE, sign } from "./lib/session.js";
import { all, one, run, USING_PG } from "./lib/driver.js";
import { CLASS_YEAR } from "./lib/config.generated.js";

const PASSWORD = "write-test-only";
const MARK = "ZZ Testperson Delete Me";   // findable, and obviously not real
// The profile row is REAL and single — it cannot be created and deleted like
// a test contact, so this writes a findable value into one field and puts the
// previous one back.
const PROFILE_MARK = "0.00-ZZ-TEST";

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, console.log(`  ok    ${what}`))
                                 : (fails.push(what), console.log(`  FAIL  ${what}`)));

function abort(msg) {
  console.error(`\ntest_writes: ${msg}\n`);
  process.exit(2);
}

if (USING_PG && process.env.JOBOPS_WRITE_TEST_PROD !== "1") {
  abort(
    "this writes real rows and refuses to do it against Neon by default.\n"
    + "  It creates a fictional contact and deletes it again; a cleanup that failed\n"
    + "  halfway would leave a fake person in the tracker, which is worse than an\n"
    + "  untested feature.\n"
    + "  Run it with JOBOPS_LOCAL_DB=1, or pass JOBOPS_WRITE_TEST_PROD=1 on purpose.",
  );
}

function chromePath() {
  if (process.env.JOBOPS_CHROME) return process.env.JOBOPS_CHROME;
  const candidates = process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe",
       "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
       path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
       "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch { /* next */ } }
  abort("no Chrome found. Set JOBOPS_CHROME. This aborts rather than skipping: a write\n"
      + "  test that silently does not run reports success just as cheerfully.");
}

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

async function waitFor(url, ms, child) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) return false;
    try { const r = await fetch(url, { redirect: "manual" }); if (r.status) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ------------------------------------------------------------------ server */

const dist = process.env.NEXT_DIST_DIR || ".next";
if (!fs.existsSync(path.join(import.meta.dirname, dist))) {
  abort(`no build at ${dist}. Run \`npm run build\` first.`);
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "start", "-p", String(port)],
  {
    cwd: import.meta.dirname,
    env: { ...process.env, JOBOPS_PASSWORD: PASSWORD, NEXT_DIST_DIR: dist },
    stdio: "ignore",
    shell: process.platform === "win32",
  },
);
const stopServer = () => {
  if (server.exitCode !== null) return;
  // On Windows kill() reaps the npx shell and leaves `next start` holding the
  // dist directory, which then EBUSYs the next build.
  try {
    if (process.platform === "win32") {
      // spawnSync: this also runs from process.on("exit"), where an async
      // child is not guaranteed to start before the loop closes.
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else server.kill();
  } catch { /* already gone */ }
};
process.on("exit", stopServer);

if (!(await waitFor(`${base}/login`, 60_000, server))) {
  stopServer();
  abort(`the server never answered on ${base}`);
}

const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true, args: ["--window-size=1280,900"],
});
// The draft flow writes to the clipboard and logs only if that succeeded, so
// without this permission the copy path cannot be tested at all.
await browser.defaultBrowserContext().overridePermissions(base, ["clipboard-read", "clipboard-write"]);

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.setCookie({ name: COOKIE, value: await sign(PASSWORD), domain: "127.0.0.1", path: "/" });

/**
 * Wait for a query to satisfy a predicate, then return its rows.
 *
 * Written after a fixed 700ms sleep produced a FALSE FAILURE: marking applied
 * fires two writes — the action, then the lifecycle event — and the second had
 * not landed when the assertion ran, so the test reported "0 lifecycle events"
 * for a write that was seconds away from succeeding. A sleep long enough to be
 * safe is a sleep long enough to make the suite tedious, and either way it is
 * asserting on the clock rather than on the database.
 *
 * Returns whatever the last query gave, satisfied or not, so the assertion that
 * follows still fails honestly on a write that genuinely never happens.
 */
async function waitForRows(sql, params, predicate, ms = 6000) {
  const end = Date.now() + ms;
  let rows = [];
  for (;;) {
    rows = await all(sql, params);
    if (predicate(rows) || Date.now() > end) return rows;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Wait for text to appear inside a selector. Same argument as waitForRows. */
async function waitForText(selector, re, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const t = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText : "";
    }, selector);
    if (re.test(t) || Date.now() > end) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Click the button whose visible text is exactly `label`. */
async function clickText(label, selector = "button, a") {
  const handle = await page.evaluateHandle((sel, want) => {
    const el = [...document.querySelectorAll(sel)]
      .find((e) => e.textContent.trim() === want);
    return el || null;
  }, selector, label);
  const el = handle.asElement();
  if (!el) throw new Error(`no element reading "${label}"`);
  await el.click();
  await new Promise((r) => setTimeout(r, 700));
}

let contactId = null;
let appliedKey = null;
let appliedGroupKey = null;
let sf86Ids = [];
let manualId = null;
// Everything this run writes is stamped after this instant, which is how the
// cleanup below knows which rows are its own and leaves real ones alone.
const runStart = new Date().toISOString();

try {
  /* ------------------------------------------------------------ 1. add */
  await page.goto(`${base}/people?add=1`, { waitUntil: "networkidle0" });
  ok(!/name="password"/.test(await page.content()),
     "signed in — the page is not the login form");

  const inputs = await page.$$(".addperson input");
  ok(inputs.length >= 2, `the add form rendered (${inputs.length} fields)`);
  await inputs[0].type(MARK);
  await inputs[1].type("palantir");
  await clickText("Add this person");

  const added = await all("SELECT id, name, company, warmth, created_at FROM contacts WHERE name = ?", [MARK]);
  ok(added.length === 1, `the contact row landed in the database (${added.length} found)`);
  contactId = added[0]?.id;
  ok(added[0]?.company === "palantir", "with the company from the form");
  // created_at, NOT first_touch. Reading first_touch is what made the weekly
  // cadence permanently zero once already.
  ok(!!added[0]?.created_at, "and a created_at, which is what the weekly count reads");

  /* -------------------------------------------------- 2. paste a LinkedIn URL */
  await page.goto(`${base}/people?add=1`, { waitUntil: "networkidle0" });
  const inputs2 = await page.$$(".addperson input");
  await inputs2[0].type("https://www.linkedin.com/in/zz-testtwo-9f2a1b/");
  // BLUR is what converts it. Deriving on every keystroke rewrote the field
  // mid-URL and filled the box with garbage; pasting and blurring are the two
  // ways a URL actually finishes arriving.
  await page.$eval(".addperson input", (e) => e.blur());
  await new Promise((r) => setTimeout(r, 200));
  const derived = await page.$eval(".addperson input", (e) => e.value);
  ok(derived === "Zz Testtwo",
     `pasting a profile URL fills the name in ("${derived}")`);

  /* --------------------------------------------------------- 3. log */
  await page.goto(`${base}/people`, { waitUntil: "networkidle0" });
  await clickText("Log interaction");
  await page.select(".logsheet select", "outreach_sent");
  await clickText("Save it");

  const logged = await all(
    "SELECT id, type, occurred_at FROM interactions WHERE contact_id = ?", [contactId]);
  ok(logged.length === 1, `the interaction row landed (${logged.length} found)`);
  ok(logged[0]?.type === "outreach_sent", "with the type that was chosen");

  // The derived status has to have MOVED. A write that lands in a table nothing
  // reads is the same bug as one that does not land at all.
  await page.goto(`${base}/people`, { waitUntil: "networkidle0" });
  const text = await page.evaluate(() => document.body.innerText);
  // Case-insensitive: .section > h2 is text-transform: uppercase and innerText
  // returns the RENDERED text, so this reads "WAITING ON REPLY" on screen.
  ok(/waiting on reply/i.test(text),
     "and the page now groups them under Waiting on reply — the status is derived, not stored");

  /* --------------------------------------------- 4. draft, copy, and log */
  await clickText("Draft message");
  const draft = await page.$eval(".drafttext", (e) => e.value);
  ok(draft.length > 100, "the draft composed from a template");
  ok(!/[{}]/.test(draft), "with no merge field left behind for a human to read");
  ok(draft.includes("Palantir"), "and the company name filled in");

  await clickText("Copy message");
  const afterCopy = await all(
    "SELECT id, type FROM interactions WHERE contact_id = ? ORDER BY id", [contactId]);
  ok(afterCopy.length === 2, `copying logged the message as sent (${afterCopy.length} rows)`);

  /* ------------------------------------------------------------- 5. undo */
  await clickText("undo");
  const afterUndo = await all(
    "SELECT id FROM interactions WHERE contact_id = ?", [contactId]);
  ok(afterUndo.length === 1, `undo removed it again (${afterUndo.length} row left)`);

  /* -------------------------------------------------------- 6. template */
  await page.goto(`${base}/people`, { waitUntil: "networkidle0" });
  await clickText("Draft message");
  await page.type(".drafttext", "\n\nPS: written by the write test.");
  await clickText("save as the template");
  const saved = await all("SELECT key, value FROM settings WHERE key LIKE 'template:%'");
  ok(saved.length >= 1, `the template override was stored (${saved.length} rows)`);
  ok((saved[0]?.value || "").includes("write test"), "with the edited wording");

  /* ---------------------------- 7. the referral shield and the lifecycle */
  // Palantir is a shield company and this contact has no referral in motion, so
  // "Mark applied" on a Palantir role must ASK rather than apply.
  await page.goto(`${base}/inbox?co=palantir&min=0&handled=1`, { waitUntil: "networkidle0" });

  // A NAMED role, not whichever happens to be first.
  //
  // The first version clicked `.row:not(.head)` and landed on "Administrative
  // Business Partner", which matches none of the four role families — so
  // LifecycleControl correctly showed "no prep checklist for this title" and
  // the test failed on the app being right. Deployment Strategist is the role
  // this whole tool is pointed at; if it is not on the board, that is worth
  // failing over on its own.
  const roleIdx = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".row:not(.head)")];
    return rows.findIndex((r) =>
      /Deployment Strategist/i.test(r.querySelector(".title")?.innerText || ""));
  });
  const hasRole = roleIdx >= 0;
  if (hasRole) {
    const openRole = async () => {
      const rows = await page.$$(".row:not(.head)");
      await rows[roleIdx].click();
      await new Promise((r) => setTimeout(r, 500));
    };
    appliedKey = await page.evaluate((i) => {
      const r = [...document.querySelectorAll(".row:not(.head)")][i];
      return r ? r.querySelector(".title")?.innerText.trim() : null;
    }, roleIdx);

    // Hover is irrelevant headless, but the actions are only in the DOM for
    // rows that exist — click the named one's "Mark applied", not the page's
    // first one.
    await page.evaluate((i) => {
      const r = [...document.querySelectorAll(".row:not(.head)")][i];
      [...r.querySelectorAll("button")].find((b) => b.textContent.trim() === "Mark applied").click();
    }, roleIdx);
    await new Promise((r) => setTimeout(r, 700));
    const shieldText = await page.evaluate(() => {
      const s = document.querySelector(".shield");
      return s ? s.innerText : "";
    });
    ok(/No referral in motion/.test(shieldText),
       "applying to Palantir with no referral interrupts once");
    ok(/Did a referral get you in/.test(shieldText),
       "and asks the one question whose answer is the only evidence about referrals");
    ok(/Applied cold/.test(shieldText),
       "with applying anyway as a first-class answer — it interrupts, it never blocks");

    const before = await all(
      "SELECT id FROM actions WHERE kind = 'applied' AND at > ?", [runStart]);
    ok(before.length === 0, "and nothing was recorded while the question is open");

    // Answer it. Two writes: the action, and the lifecycle event carrying the
    // referral answer.
    await clickText("Applied cold");
    const after = await waitForRows(
      "SELECT key FROM actions WHERE kind = 'applied' AND at > ?", [runStart],
      (r) => r.length >= 1);
    ok(after.length === 1, `answering marked it applied (${after.length} action rows)`);
    appliedGroupKey = after[0]?.key || null;

    const events = await waitForRows(
      "SELECT group_key, status, referral FROM role_events WHERE at > ?", [runStart],
      (r) => r.length >= 1);
    ok(events.length === 1, `and wrote one lifecycle event (${events.length})`);
    ok(events[0]?.status === "applied", "at the applied stage");
    // FALSE, not null. "Applied cold" is an answer; skipping is what stores null.
    ok(Number(events[0]?.referral) === 0,
       `with referral recorded as cold, not as unknown (got ${JSON.stringify(events[0]?.referral)})`);

    // And the stage buttons in the expanded row write too.
    await page.goto(`${base}/inbox?co=palantir&min=0&handled=1`, { waitUntil: "networkidle0" });
    await openRole();
    await clickText("Phone screen");
    const moved = await waitForRows(
      "SELECT status FROM role_events WHERE at > ? ORDER BY id", [runStart],
      (r) => r.length >= 2);
    ok(moved.length === 2 && moved[1]?.status === "phone_screen",
       `moving the stage wrote a second event (${moved.map((m) => m.status).join(", ")})`);

    // The prep checklist appears from the phone screen on, and not before.
    // Case-insensitive, and scoped to the checklist itself. .prepsub is
    // text-transform: uppercase and innerText returns the RENDERED text, so a
    // case-sensitive match here failed on a checklist that was on screen.
    const detail = await waitForText(".prepkit", /expect to be asked/i);
    ok(/expect to be asked/i.test(detail),
       `and the interview prep checklist appears at the phone screen for "${appliedKey}"`);
    ok(/research/i.test(detail), "with research items as well as question types");
    // The clearance wording is a hard constraint from CLAUDE.md, and this is one
    // of the few places the tool puts words about it in front of the owner right
    // before an interview. Checked against the CHECKLIST text, not the whole
    // detail — the row already carries an unrelated clearance line under Pay
    // and dates, which would have satisfied this without the checklist existing.
    // THIS REGEX WAS DEAD FOR WEEKS. Its word-boundary escapes had
    // collapsed into literal 0x08 backspace bytes through a shell heredoc,
    // so it matched nothing and this assertion passed whatever the page
    // said -- on the one rule in this project that is a false claim on a
    // federal form if it goes wrong. test_line_endings.py now fails on a
    // stray control byte for exactly this reason: grep cannot find a
    // character that is not in the source you are reading.
    const FORBIDDEN = new RegExp(
      ['\\bis cleared\\b',
       '\\bclearance[- ]eligible\\b',
       '\\byou are eligible\\b',
       '\\beligible for (?:a )?(?:ts|top secret|secret)\\b',
       '\\bactive clearance\\b'].join("|"), "i");
    ok(!FORBIDDEN.test(detail),
       "and never claims a clearance or an eligibility determination nobody has made");
  } else {
    ok(false, "no Palantir role on the inbox to test the referral shield against");
  }
  /* ------------------------------------------- 8. the SF-86 evidence pack */
  // Autosave on blur is the only write in the app with no button, so "did it
  // save" is a question with no visible answer beyond a word that fades. That
  // makes it exactly the kind of write a green build says nothing about.
  await page.goto(`${base}/sf86`, { waitUntil: "networkidle0" });

  const seeded = await all("SELECT id, section, country FROM sf86_entries WHERE section = 'travel'");
  ok(seeded.length === 2,
     `the two known trips are seeded on first open (${seeded.length})`);
  // Blank dates. Seeding a guessed month onto a form signed under penalty of
  // perjury is the one thing this feature must never do.
  const blank = await all(
    "SELECT id FROM sf86_entries WHERE section='travel' AND from_ym IS NULL");
  ok(blank.length === 2, "with their dates deliberately blank");

  await clickText("Add an address");
  const addrs = await waitForRows(
    "SELECT id, sort FROM sf86_entries WHERE section = 'address'", [], (r) => r.length >= 1);
  ok(addrs.length === 1, `adding an address wrote a row (${addrs.length})`);
  sf86Ids = (await all("SELECT id FROM sf86_entries")).map((r) => r.id);

  // Type into the first address field and blur. Nothing else confirms it.
  await page.type(".sf-label input", "1234 Example St, Los Angeles, CA");
  await page.$eval(".sf-label input", (e) => e.blur());
  const typed = await waitForRows(
    "SELECT label FROM sf86_entries WHERE section='address'", [],
    (r) => r.length && r[0].label);
  ok(String(typed[0]?.label || "").includes("Example St"),
     `blurring a field saved it (${JSON.stringify(typed[0]?.label)})`);

  // A bad month is REFUSED, not stored. The gap detector does arithmetic on
  // these, and "2026-13" would produce a nonsense span rather than an error.
  const badDate = await fetch(`${base}/api/sf86`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${COOKIE}=${await sign(PASSWORD)}` },
    body: JSON.stringify({ action: "save", id: addrs[0].id, field: "from_ym", value: "2026-13" }),
  });
  ok(badDate.status === 400, `month 13 is refused (${badDate.status})`);

  await clickText("remove");
  const gone = await waitForRows(
    "SELECT id FROM sf86_entries WHERE section='address'", [], (r) => r.length === 0);
  ok(gone.length === 0, "and removing the row took it out again");
  /* ------------------------- 9. manual applications and the union */
  //
  // The three consulting applications with the nearest deadline could not be
  // recorded at all before this: one instruction, one checkbox, three firms.
  //
  // WHY THIS GOES THROUGH THE API RATHER THAN THE CHECKBOX. The composite card
  // only renders when the ladder's top item is the apply tier, and on this
  // database the fetch is days old, so tier 0 ("run the daily fetch") wins
  // every time — the card is genuinely not on the page to click. Rather than
  // mutate job data to fake a fresh fetch, this posts the exact payload the
  // checkbox posts, to the exact endpoint, and then checks everything
  // downstream of it. The checkbox-to-payload binding itself is the one link
  // covered by the manual browser pass instead of automatically; it is four
  // lines of onChange in CompositeToday.js.
  const authed = { "content-type": "application/json", cookie: `${COOKIE}=${await sign(PASSWORD)}` };
  const api = async (payload) => {
    const r = await fetch(`${base}/api/manual`, {
      method: "POST", headers: authed, body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const made = await api({
    action: "create",
    firm_label: "ZZ Test Consulting",
    program_name: "Strategy, undergraduate",
    class_year: CLASS_YEAR,
    window_id: "window:ZZ Test Consulting|Strategy, undergraduate",
    source: "window",
    status: "applied",
  });
  ok(made.status === 200, `recording a manual application succeeded (${made.status})`);
  manualId = made.body.id;

  const apps = await waitForRows(
    "SELECT id, firm_label, window_id, source FROM manual_applications WHERE id = ?",
    [manualId], (r) => r.length >= 1);
  ok(apps.length === 1, `the application row landed (${apps.length})`);
  ok(String(apps[0]?.window_id || "").startsWith("window:"),
     "linked back to the window it came from");

  const evs = await all(
    "SELECT status, referral FROM manual_application_events WHERE application_id = ?", [manualId]);
  ok(evs.length === 1 && evs[0].status === "applied",
     `with one applied event (${evs.map((e) => e.status).join(",")})`);
  // NULL until answered. A guessed 0 would invent evidence against the one
  // thesis this column exists to test.
  ok(evs[0]?.referral === null,
     `and referral null until asked (got ${JSON.stringify(evs[0]?.referral)})`);

  const answered = await api({ action: "referral", id: manualId, referral: false });
  ok(answered.status === 200, "answering the referral question succeeded");
  const afterRef = await all(
    "SELECT referral FROM manual_application_events WHERE application_id = ? AND status='applied'",
    [manualId]);
  ok(Number(afterRef[0]?.referral) === 0,
     `recorded as cold, not as unknown (${JSON.stringify(afterRef[0]?.referral)})`);

  // Advancing writes a second event rather than mutating the first — the
  // history is what days-in-stage is computed from.
  const adv = await api({ action: "advance", id: manualId, status: "oa" });
  ok(adv.status === 200, "advancing a stage succeeded");
  const both = await all(
    "SELECT status, at FROM manual_application_events WHERE application_id = ? ORDER BY at, id",
    [manualId]);
  ok(both.length === 2 && both[1].status === "oa",
     `two events, latest oa (${both.map((e) => e.status).join(",")})`);
  ok(both.every((e) => e.at), "each stamped with when it happened");

  // THE REFERRAL ANSWER SURVIVES THE MOVE. It belongs to the applied event, not
  // to the latest one, so advancing must not lose it.
  ok(Number(afterRef[0]?.referral) === 0 && both[1].status === "oa",
     "and the referral answer stays on the applied event after advancing");

  // THE UNION — the point of the whole phase.
  await page.goto(`${base}/`, { waitUntil: "networkidle0" });
  const inflight = await page.evaluate(() => {
    const s = document.querySelector("#inflight");
    return s ? s.innerText : "";
  });
  ok(inflight.includes("ZZ Test Consulting"),
     "In flight lists the manual application beside the scraped ones");
  ok(/manual/i.test(inflight),
     "tagged manual, so he knows nothing will update it on its own");
  ok(/day.? in this stage/.test(inflight),
     "with days-in-stage from the same function the roles use");

  // The undo fence: a rule being enforced, so 400 with a message, not 500.
  const late = await api({ action: "undo", id: "ma:definitely-not-a-real-id" });
  ok(late.status === 400, `undoing something that does not exist is refused (${late.status})`);
  ok(/nothing to undo/i.test(late.body.error || ""),
     `and says why ("${late.body.error}")`);

  /* ------------------------------------------ 10. the profile card autosave */
  //
  // Autosave on blur, with no button — the same shape as the SF-86 pack, and
  // the same reason it needs clicking rather than diffing: a write leaves no
  // trace in a rendered page until it succeeds.
  //
  // It also exercises the one field that must REFUSE a write. The clearance
  // line is read-only because eligibility is an adjudicator's determination,
  // and a free-text box under time pressure is exactly where "willing to
  // undergo the process" quietly becomes "eligible".
  await page.goto(`${base}/profile`, { waitUntil: "networkidle0" });

  const gpaSel = "#f-gpa";
  await page.waitForSelector(gpaSel);
  const priorGpa = await page.$eval(gpaSel, (e) => e.value);

  await page.focus(gpaSel);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(gpaSel, PROFILE_MARK);
  // Blur is the save. Clicking another field is what a person actually does.
  await page.click("#f-legal_name");
  await page.waitForFunction(
    () => !!document.querySelector(".cardsaved")
       || !!document.querySelector(".cardrow .acterr"),
    { timeout: 10_000 });

  const stored = await one("SELECT gpa FROM profile WHERE id = ?", ["me"]);
  ok(stored?.gpa === PROFILE_MARK,
     `the profile field reached the database on blur (gpa = ${JSON.stringify(stored?.gpa)})`);

  // COPY. The whole point of the page is that one tap puts a field on the
  // clipboard, so a copy button that silently does nothing is the feature
  // failing while looking fine.
  const copyLabel = await page.$$eval(".cardrow", (rows) => {
    const r = rows.find((x) => x.querySelector("#f-gpa"));
    const b = r && r.querySelector("button");
    if (b) b.click();
    return b ? b.textContent.trim() : null;
  });
  ok(copyLabel !== null, "each field has a copy button");
  await page.waitForFunction(
    () => [...document.querySelectorAll(".cardrow button")].some(
      (b) => b.textContent.trim() === "Copied"), { timeout: 5_000 })
    .then(() => ok(true, "and it says Copied when pressed"))
    .catch(() => ok(false, "and it says Copied when pressed"));

  // THE READ-ONLY FIELD. It must not be an input at all — a disabled input is
  // still a box that invites typing, and the rule is that this sentence is not
  // editable from the app.
  const clr = await page.$eval(".cardrow.ro", (r) => ({
    tag: (r.querySelector("[id^=f-]") || {}).tagName,
    text: (r.querySelector(".cardvalue") || {}).textContent || "",
  }));
  ok(clr.tag === "SPAN", `the clearance line renders as text, not an input (${clr.tag})`);
  ok(/no current or prior clearance/i.test(clr.text),
     "and states the position it is allowed to state");

  // And the API refuses it even when asked directly, because a rule that lives
  // only in the markup is a rule a second write path skips.
  {
    const r = await fetch(`${base}/api/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${COOKIE}=${await sign(PASSWORD)}` },
      body: JSON.stringify({ key: "clearance_line", value: "I am cleared." }),
    });
    ok(r.status === 400, `the API refuses a direct write to the clearance line (${r.status})`);
  }
  {
    const r = await fetch(`${base}/api/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${COOKIE}=${await sign(PASSWORD)}` },
      body: JSON.stringify({ key: "bullet_1", value: "I am clearance-eligible for TS/SCI." }),
    });
    ok(r.status === 400, `and refuses a bullet that claims eligibility (${r.status})`);
  }

  // Put it back exactly as it was, whatever it was.
  await run("UPDATE profile SET gpa = ? WHERE id = ?", [priorGpa || null, "me"]);

} catch (e) {
  fails.push(`threw: ${e.message}`);
  console.log(`  FAIL  threw: ${e.message}`);
} finally {
  /* ------------------------------------------------------------- cleanup */
  // Sunk verification effort is not a reason to keep fabricated data. A made-up
  // person in the contacts table is exactly the shape of the two invented
  // window checks that had to be deleted afterwards.
  await browser.close().catch(() => {});
  let removed = 0;
  try {
    if (contactId) {
      const ix = await all("SELECT id FROM interactions WHERE contact_id = ?", [contactId]);
      await run("DELETE FROM interactions WHERE contact_id = ?", [contactId]);
      await run("DELETE FROM contacts WHERE id = ?", [contactId]);
      removed = ix.length + 1;
    }
    await run("DELETE FROM contacts WHERE name = ?", [MARK]);
    await run("DELETE FROM settings WHERE key LIKE 'template:%'");

    // The lifecycle rows this run created against a REAL Palantir role. Scoped
    // by timestamp rather than by key, so it can only ever remove what this run
    // wrote — an application the owner actually made must survive a test run.
    // The evidence pack is entirely this run's: nothing else has ever written
    // to it here. Removed wholesale rather than by timestamp, because the seed
    // rows are inserted by the page itself and carry no marker of their own.
    const packs = await all("SELECT id FROM sf86_entries");
    await run("DELETE FROM sf86_entries");
    removed += packs.length;

    // The manual applications this run recorded. Scoped by timestamp so a real
    // one the owner submitted can never be swept up by a test run.
    const mev = await all(
      "SELECT id FROM manual_application_events WHERE at > ?", [runStart]);
    const mapp = await all(
      "SELECT id FROM manual_applications WHERE created_at > ?", [runStart]);
    await run("DELETE FROM manual_application_events WHERE at > ?", [runStart]);
    await run("DELETE FROM manual_applications WHERE created_at > ?", [runStart]);
    removed += mev.length + mapp.length;

    const evs = await all("SELECT id FROM role_events WHERE at > ?", [runStart]);
    await run("DELETE FROM role_events WHERE at > ?", [runStart]);
    await run("DELETE FROM actions WHERE kind = 'applied' AND at > ?", [runStart]);
    if (appliedGroupKey) {
      // recordAction('applied') also stages every posting in the group and adds
      // a follow-up item seven days out. Both are this run's debris.
      await run("DELETE FROM items WHERE id = ?", [`followup:${appliedGroupKey}`]);
      await run("UPDATE applications SET stage = 'found' WHERE key IN "
        + "(SELECT key FROM jobs WHERE company = ?)", [String(appliedGroupKey).split("|")[0]]);
    }
    removed += evs.length;

    const left = await all("SELECT id FROM contacts WHERE name = ?", [MARK]);
    const leftApps = await all(
      "SELECT id FROM manual_applications WHERE created_at > ?", [runStart]);
    if (leftApps.length) {
      console.log(`
  CLEANUP FAILED: ${leftApps.length} test application(s) still in the database.`);
      fails.push("cleanup left manual applications behind");
    }
    const leftEvents = await all("SELECT id FROM role_events WHERE at > ?", [runStart]);
    if (leftEvents.length) {
      console.log(`
  CLEANUP FAILED: ${leftEvents.length} lifecycle event(s) still in the database.`);
      fails.push("cleanup left lifecycle rows behind");
    }
    // The cleanup asserts ITSELF. A tidy-up that quietly failed would leave a
    // fake person in the tracker and print a green run.
    if (left.length) {
      console.log(`\n  CLEANUP FAILED: ${left.length} test contact(s) still in the database.`);
      fails.push("cleanup left test rows behind");
    } else {
      console.log(`\n  cleaned up ${removed} test row(s)`);
    }
  } catch (e) {
    console.log(`\n  CLEANUP FAILED: ${e.message}`);
    fails.push("cleanup threw");
  }
  stopServer();
}

console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
