/**
 * No page may scroll horizontally at 1280px. Run: node test_overflow.mjs [baseUrl]
 *
 * The bug: Anduril's "2027 Early Career Software Engineer" is ONE Greenhouse
 * posting listing nine cities, joined with "; " into a single 331-character
 * location field. `.loc` is `white-space: nowrap`, the grid track had no reason
 * to shrink, and the Daily row ran **1270 pixels past the viewport** — a
 * horizontal scrollbar on the whole page. groupRoles only ever collapsed
 * separate ROWS, so it never saw this shape.
 *
 * test_display.mjs covers the data half. It cannot cover this half: whether a
 * page scrolls is a question about LAYOUT, and answering it needs a browser.
 * puppeteer-core drives the Chrome already installed on this machine rather than
 * downloading its own — which also keeps it honest on win_arm64, where a bundled
 * Chromium would be an x64 build under emulation.
 *
 * Three things this refuses to do quietly, because a layout check that measures
 * nothing reports success just as cheerfully as one that measures everything:
 *
 *   - it ABORTS if Chrome cannot be found, rather than skipping;
 *   - it ABORTS if a page came back as the login form, or with almost no text.
 *     Seven copies of the sign-in page have no overflow either;
 *   - it runs a POSITIVE CONTROL: the old 331-character string is put back on a
 *     real row and the check must FAIL on it. A check that has only ever passed
 *     is indistinguishable from one that cannot fail.
 *
 * With no argument it builds nothing and starts its own `next start` against
 * whatever NEXT_DIST_DIR holds, on an ephemeral port, with a throwaway password.
 * With a base URL it tests that instead — including the deployed site, the same
 * shape as test_auth_bypass.mjs — and then it needs JOBOPS_PASSWORD.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { COOKIE, sign } from "./lib/session.js";

/* TWO widths, not one.
 *
 * 1280 is the desktop check this file was written for. 390 is an iPhone, and it
 * is where this app actually gets read: between classes, on a phone. Checking
 * only the wide case is how a five-item nav bar ends up running 25px past the
 * viewport with a green build — which is exactly what adding People did, and
 * what this second width caught.
 */
// 1440 is the width the rail was designed against and the width this phase's
// acceptance criteria are stated at; 1280 is the older desktop check and is
// ALSO above the 1200px breakpoint, so the two exercise the layout with
// different amounts of slack. 1100 is the width that matters most and was
// missing: just under the breakpoint, where the rail vanishes and everything in
// it has to land back where it came from.
const WIDTHS = [1440, 1280, 1100, 390];

// Where the rail must and must not be. A layout that only ever renders one way
// is one where the other way is broken and nobody has looked.
const RAIL_BREAKPOINT = 1200;
const HEIGHT = 900;
const PAGES = ["/", "/inbox", "/inbox?worth=1", "/companies", "/people",
               "/forecast", "/gate", "/about", "/profile", "/pulse"];

// The string that caused it, verbatim from the jobs table.
const OLD_STRING = [
  "Atlanta, Georgia, United States", "Boston, Massachusetts, United States",
  "Broomfield, Colorado, United States", "Colorado Springs, Colorado, United States",
  "Costa Mesa, California, United States", "Fort Collins, Colorado, United States",
  "Irvine, California, United States", "Reston, Virginia, United States",
  "Seattle, Washington, United States",
].join("; ");

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, console.log(`  ok    ${what}`))
                                 : fails.push(what));

function abort(msg) {
  console.error(`\ntest_overflow: ${msg}\n`);
  process.exit(2);
}

/** Chrome, or a clear explanation of where it was looked for. */
function chromePath() {
  if (process.env.JOBOPS_CHROME) return process.env.JOBOPS_CHROME;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === "win32"
    ? [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
      ]
    : [
        "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium", "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* next */ }
  }
  abort(
    "no Chrome found. Set JOBOPS_CHROME to the executable.\n"
    + "  Looked in:\n" + candidates.map((c) => `    ${c}`).join("\n")
    + "\n  This aborts rather than skipping: a layout test that silently does not\n"
    + "  run is worse than no layout test, because the build still goes green.",
  );
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function waitFor(url, deadlineMs, child) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    // Three exit conditions, not one: success, the producer dying, and a
    // deadline. Waiting on only the first spins forever when the server is gone.
    if (child && child.exitCode !== null) return false;
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ------------------------------------------------------------ target + session
const argBase = process.argv[2];
const PASSWORD = argBase ? process.env.JOBOPS_PASSWORD : "overflow-test-only";
if (argBase && !PASSWORD) {
  abort("JOBOPS_PASSWORD is not set, and the site behind a base URL needs it to sign in.");
}

const stop = () => {
  if (!server || server.exitCode !== null) return;
  // ON WINDOWS kill() REAPS THE SHELL AND ORPHANS THE SERVER.
  //
  // spawn() here runs through `shell: true` -> cmd.exe -> npx.cmd -> node, so
  // server.pid is the SHELL. Killing it leaves `next start` running forever,
  // holding a port and the dist directory. This test runs on every commit, so
  // it leaked two processes per commit: 28 orphaned servers were found alive
  // before anyone noticed, and the symptom is not a failing test — it is a
  // build that EBUSYs weeks later for no visible reason.
  //
  // test_writes.mjs already had this fix and even documents the bug; this file
  // never got it. /T is the whole tree.
  //
  // spawnSync, not spawn: this runs from a process.on("exit") handler, where
  // the event loop is already closing and an async child is not guaranteed to
  // start at all.
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else server.kill();
  } catch { /* already gone */ }
};
process.on("exit", stop);

let server = null;
let base = argBase;
if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const dist = process.env.NEXT_DIST_DIR || ".next";
  if (!fs.existsSync(path.join(import.meta.dirname, dist))) {
    abort(`no build at ${dist}. Run \`npm run build\` first, or pass a base URL.`);
  }
  server = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "start", "-p", String(port)],
    {
      cwd: import.meta.dirname,
      env: { ...process.env, JOBOPS_PASSWORD: PASSWORD, NEXT_DIST_DIR: dist },
      stdio: "ignore",
      shell: process.platform === "win32",
    },
  );
  if (!(await waitFor(`${base}/login`, 60_000, server))) {
    stop();
    abort(`the server never answered on ${base}`);
  }
}


// A local run mints the cookie directly; a remote one has to go through the
// login route, because only the deployment knows its own secret.
let cookieValue;
if (server) {
  cookieValue = await sign(PASSWORD);
} else {
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
    redirect: "manual",
  });
  const set = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${COOKIE}=`));
  if (!set) { stop(); abort(`sign-in to ${base} failed (${r.status}) — nothing to measure.`); }
  cookieValue = set.split(";")[0].slice(COOKIE.length + 1);
}

// ---------------------------------------------------------------------- measure
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: true,
  // The widest of the widths; setViewport below is what actually decides each
  // measurement, and the window only has to be big enough not to clamp it.
  args: [`--window-size=${Math.max(...WIDTHS)},${HEIGHT}`],
});

const measure = () => {
  const de = document.documentElement;
  const over = de.scrollWidth - de.clientWidth;
  const offenders = [...document.querySelectorAll("body *")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((o) => o.r.right > de.clientWidth + 1)
    .slice(0, 5)
    // className is empty on plenty of elements, which printed a bare "SPAN." and
    // named nothing. Fall back to the tag chain so an offender is identifiable.
    .map((o) => {
      const id = String(o.el.className || "").trim().split(" ")[0]
        || [...(o.el.parentElement ? [o.el.parentElement] : [])]
             .map((p) => String(p.className || "").trim().split(" ")[0]).filter(Boolean)[0]
        || "(no class)";
      return `<${o.el.tagName.toLowerCase()}> in .${id} right=${Math.round(o.r.right)} `
        + `w=${Math.round(o.r.width)} "${(o.el.textContent || "").replace(/\s+/g, " ").slice(0, 50)}"`;
    });
  return {
    over, offenders, clientWidth: de.clientWidth,
    chars: document.body.innerText.length,
    onLogin: !!document.querySelector("form input[type=password]"),
  };
};

try {
  const page = await browser.newPage();
  const url = new URL(base);
  await browser.setCookie({
    name: COOKIE, value: cookieValue, domain: url.hostname, path: "/",
  });

  for (const WIDTH of WIDTHS) {
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    for (const p of PAGES) {
      await page.goto(base + p, { waitUntil: "networkidle0", timeout: 60_000 });
      const m = await page.evaluate(measure);

      // Preconditions first. If these are wrong, "no overflow" means nothing.
      if (m.onLogin) { stop(); abort(`${p} came back as the LOGIN page — the session did not stick.`); }
      if (m.chars < 200) { stop(); abort(`${p} rendered ${m.chars} characters. Nothing was measured.`); }
      if (m.clientWidth > WIDTH) { stop(); abort(`${p} measured at ${m.clientWidth}px, not ${WIDTH}px.`); }

      ok(m.over <= 0, `${p} does not scroll horizontally at ${WIDTH}px`
        + (m.over > 0 ? `\n        +${m.over}px:\n          ${m.offenders.join("\n          ")}` : ""));

      // THE RAIL, BOTH DIRECTIONS. It is display:none below the breakpoint and
      // everything in it falls back to where it already lived further down the
      // page. The failure with no symptom is the fallback not happening — the
      // page simply stops saying how many months are left and looks fine — so
      // the FACTS are asserted at every width, not merely the rail's absence.
      if (p === "/") {
        const rail = await page.evaluate(() => {
          const el = document.querySelector(".rail");
          const box = el && el.getBoundingClientRect();
          const vis = !!(box && box.width > 0);
          return {
            visible: vis,
            right: vis ? Math.round(box.right) : 0,
            blocks: el ? el.querySelectorAll(".railblock").length : 0,
            saysGraduation: /months? to graduation/i.test(document.body.innerText),
          };
        });
        if (WIDTH >= RAIL_BREAKPOINT) {
          ok(rail.visible, `the rail is on screen at ${WIDTH}px`);
          ok(rail.blocks >= 3, `the rail carries ${rail.blocks} blocks at ${WIDTH}px`);
          ok(rail.right <= WIDTH, `the rail ends inside the viewport at ${WIDTH}px`);
        } else {
          ok(!rail.visible, `the rail is gone at ${WIDTH}px`);
        }
        ok(rail.saysGraduation, `months-to-graduation is still stated at ${WIDTH}px`);
      }
    }
  }
  // Back to the wide viewport for the control below, which measures a string
  // that is only guaranteed to overflow at the width it originally broke.
  await page.setViewport({ width: WIDTHS[0], height: HEIGHT });

  /* -------------------------------------------- THE ROLE COLUMN IS THE PAGE
   *
   * Three things, because the obvious one does not discriminate.
   *
   * "Every row has a non-empty title" is the assertion this bug asks for, and
   * it would have PASSED throughout: the titles were always in the DOM, at
   * full length, with a correct `title` attribute. What had happened is that
   * the column holding them was 94px wide at 1100, so "Deployment Strategist -
   * US Government", "Deployment Strategist, Build to Apply" and "Forward
   * Deployed Software Engineer" all ellipsised to the same dozen pixels and
   * three different Palantir roles rendered as one row repeated. Present in the
   * markup, absent from the page. So the emptiness check is kept — it catches a
   * real and different failure — and two that actually bite are added beside it.
   *
   * THE WIDTH ONE IS AN INVARIANT, NOT A THRESHOLD. It does not assert some
   * number of pixels; it asserts that the role title gets more room than the
   * CONTROLS beside it. A control cluster wider than the content it acts on is
   * wrong at any size, and that is exactly what had happened: 242px of verbs
   * that are `opacity: 0` until hover were reserving a quarter of every row,
   * against 94px of role.
   *
   * THE ALIGNMENT ONE is a fact with no judgement in it at all. Every .row is
   * its own grid container — these are not tables — so an `auto` track is sized
   * by each row's own content. The header's last cell is an empty <span />, so
   * its track collapsed to zero and every heading from "location" rightward sat
   * 360px away from the column it named, at every width, with nothing to say so.
   */
  for (const WIDTH of [1440, 1280, 1100]) {
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    await page.goto(`${base}/inbox`, { waitUntil: "networkidle0", timeout: 60_000 });
    const t = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".row:not(.head)")];
      const head = document.querySelector(".row.head");
      const cellsOf = (el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().left));
      const titles = rows.map((r) => (r.querySelector(".title")?.textContent || "").trim());
      const first = rows[0];
      return {
        rows: rows.length,
        empty: titles.filter((x) => !x).length,
        titleW: first ? Math.round(first.querySelector(".title").getBoundingClientRect().width) : 0,
        actionsW: first ? Math.round(first.querySelector(".rowend").getBoundingClientRect().width) : 0,
        headCells: head ? cellsOf(head) : [],
        bodyCells: first ? cellsOf(first) : [],
        headKids: head ? head.children.length : 0,
        panelH: Math.round(
          document.querySelector(".filterpanel")?.getBoundingClientRect().height ?? -1),
      };
    });
    if (t.rows < 5) { stop(); abort(`Inbox rendered ${t.rows} rows at ${WIDTH}px — the title checks measured nothing.`); }

    // THE PANEL'S RENDERED HEIGHT, not its `hidden` property. The property was
    // true and the panel was on screen the whole time: `[hidden]` is a UA rule
    // and `.controls { display: flex }` beats it. A check that reads back the
    // attribute you just set is a check that can only ever agree with you.
    ok(t.panelH === 0,
       `${WIDTH}px: the folded filter panel takes no space (measured ${t.panelH}px tall)`);

    ok(t.empty === 0, `${WIDTH}px: all ${t.rows} Inbox rows have a role title`);
    ok(t.titleW > t.actionsW,
       `${WIDTH}px: the role column (${t.titleW}px) is wider than the controls beside it (${t.actionsW}px)`);

    const off = t.headCells
      .map((x, i) => ({ i, dx: x - (t.bodyCells[i] ?? x) }))
      .filter((c) => Math.abs(c.dx) > 2);
    ok(t.headKids === t.bodyCells.length && off.length === 0,
       `${WIDTH}px: every column heading sits over its own column`
       + (off.length ? `\n        adrift: ${off.map((c) => `cell ${c.i} by ${c.dx}px`).join(", ")}` : ""));
  }
  await page.setViewport({ width: WIDTHS[0], height: HEIGHT });

  /* ------------------------------------------------ NOT CLIPPED IS NOT ENOUGH
   *
   * "The page does not scroll sideways" and "you can read the row" are
   * different questions, and only the first one was ever asked here.
   *
   * The place chip — the three characters that say whether a role is in one of
   * the two cities he wants — sat INSIDE `.loc`, which is overflow:hidden with
   * an ellipsis. On any row whose location was long, the chip was pushed past
   * the clip edge and vanished: measured at 27 of 32 rows on Inbox, and
   * vanishing on exactly the long-location rows that are the entire reason the
   * chip exists. It rendered. It had a tooltip. It passed every test in this
   * repository, including this one, because a clipped element does not overflow
   * anything — clipping is the opposite of overflowing.
   *
   * So: every chip that renders must lie inside its own cell. And the count is
   * asserted too, because "0 chips, 0 of them clipped" is a green run that
   * measured nothing at all.
   */
  await page.goto(`${base}/inbox`, { waitUntil: "networkidle0", timeout: 60_000 });
  const chips = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".row")].filter((r) => !r.classList.contains("head"));
    const out = { rows: rows.length, chips: 0, clipped: [] };
    for (const r of rows) {
      const cell = r.querySelector(".loc");
      const tag = r.querySelector(".ptag");
      if (!cell || !tag) continue;
      out.chips++;
      const c = cell.getBoundingClientRect();
      const t = tag.getBoundingClientRect();
      if (!(t.width > 0 && t.right <= c.right + 1 && t.left >= c.left - 1)) {
        if (out.clipped.length < 4) {
          out.clipped.push(`"${cell.textContent.trim().slice(0, 40)}" chip right=${Math.round(t.right)} cell right=${Math.round(c.right)}`);
        }
      }
    }
    return out;
  });
  if (chips.rows < 5) { stop(); abort(`Inbox rendered ${chips.rows} rows — the chip check measured nothing.`); }
  if (chips.chips < 1) { stop(); abort("no .ptag on any Inbox row — the chip check measured nothing."); }
  ok(chips.clipped.length === 0,
     `all ${chips.chips} place chips are inside their own cell`
     + (chips.clipped.length ? `\n        clipped:\n          ${chips.clipped.join("\n          ")}` : ""));

  // And prove THAT can fail: put the cell back to a plain overflow:hidden box
  // with a wide filler in front of the chip, which is what the bug was.
  const clipControl = await page.evaluate(() => {
    const cell = [...document.querySelectorAll(".row .loc")].find((c) => c.querySelector(".ptag"));
    if (!cell) return { found: false };
    cell.style.display = "block";
    const filler = document.createElement("span");
    filler.textContent = "x".repeat(200);
    filler.style.whiteSpace = "nowrap";
    cell.insertBefore(filler, cell.firstChild);
    const c = cell.getBoundingClientRect();
    const t = cell.querySelector(".ptag").getBoundingClientRect();
    return { found: true, clipped: !(t.width > 0 && t.right <= c.right + 1) };
  });
  if (!clipControl.found) { stop(); abort("no Inbox row carries a place chip — the control could not run."); }
  ok(clipControl.clipped,
     "control: a chip inside a plain overflow:hidden cell IS reported as clipped, so this check can fail");

  // ---------------------------------------------------------- positive control
  // Put the 331-character string back on a real row. If the check does not go
  // red here, it is not a check.
  await page.goto(base + "/", { waitUntil: "networkidle0", timeout: 60_000 });
  const control = await page.evaluate((s) => {
    const el = document.querySelector(".role .loc") || document.querySelector(".loc");
    if (!el) return { found: false };
    el.textContent = s;
    const de = document.documentElement;
    return { found: true, over: de.scrollWidth - de.clientWidth };
  }, OLD_STRING);
  if (!control.found) { stop(); abort("no .loc element on Daily — the control could not run."); }
  ok(control.over > 0,
     `control: the old 331-char location string DOES overflow (+${control.over}px), `
     + "so this test can fail");
} finally {
  await browser.close();
  stop();
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED of ${pass + fails.length}\n`);
  for (const f of fails) console.log(`  ${f}\n`);
  process.exit(1);
}
console.log(`\n${pass}/${pass} passed`);
