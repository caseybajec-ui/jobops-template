/**
 * Every tour step must point at something that exists. Run: node test_tour_targets.mjs
 *
 * THE POINT. At runtime a step whose selector matches nothing is SKIPPED — the
 * tour must never block the app because a section happened not to render. That
 * is right for a live reader and wrong forever: rename a class and the step
 * skips silently, every time, and the tour quietly gets shorter with nothing to
 * say so. It is the always-empty-source bug wearing a different hat.
 *
 * So: skip live, fail here. This loads each page the tour visits and asserts
 * every selector for that page matches a VISIBLE element — not merely present
 * in the DOM, because a step pointing at a zero-height node rings nothing.
 *
 * It aborts rather than passing if Chrome is missing, if a page came back as the
 * login form, or if a page rendered almost nothing — "0 selectors checked, 0
 * failures" is what this would print pointed at a wall.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";
import { COOKIE, sign } from "./lib/session.js";
import { TOURS } from "./lib/tour.js";

/**
 * Whether a simple selector's class or id is written anywhere under app/.
 *
 * For CONDITIONAL steps only — see the loop below. Simple selectors (".x" or
 * "#x") are what the tours use; anything more elaborate returns null and the
 * step is held to the live-page rule.
 */
function classInSource(selector) {
  const m = String(selector).match(/^([.#])([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const attr = m[1] === "." ? "className" : "id";
  const needle = new RegExp(`${attr}=(?:"[^"]*\\b${m[2]}\\b[^"]*"|\\{[^}]*\\b${m[2]}\\b)`);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(dir)) {
    if (!/\.(js|jsx|mjs)$/.test(f)) continue;
    if (needle.test(fs.readFileSync(f, "utf8"))) return path.relative(dir, f).replace(/\\/g, "/");
  }
  return null;
}

const WIDTH = 1440;
const HEIGHT = 1000;

let pass = 0;
const fails = [];
const ok = (c, what) => (c ? (pass++, console.log(`  ok    ${what}`)) : fails.push(what));

function abort(msg) {
  console.error(`\ntest_tour_targets: ${msg}\n`);
  process.exit(2);
}

function chromePath() {
  if (process.env.JOBOPS_CHROME) return process.env.JOBOPS_CHROME;
  const c = process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe",
       "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
       path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium",
       "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const p of c) { try { if (p && fs.existsSync(p)) return p; } catch { /* next */ } }
  abort("no Chrome found. Set JOBOPS_CHROME. This aborts rather than skipping.");
}

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const argBase = process.argv[2];
const PASSWORD = argBase ? process.env.JOBOPS_PASSWORD : "tour-test-only";
if (argBase && !PASSWORD) abort("JOBOPS_PASSWORD is not set and a base URL needs it.");

let server = null;
const stop = () => {
  if (!server || server.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else server.kill();
  } catch { /* gone */ }
};
process.on("exit", stop);

let base = argBase;
if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const dist = process.env.NEXT_DIST_DIR || ".next";
  if (!fs.existsSync(path.join(import.meta.dirname, dist))) {
    abort(`no build at ${dist}. Run \`npm run build\` first.`);
  }
  server = spawn(process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "start", "-p", String(port)],
    { cwd: import.meta.dirname,
      env: { ...process.env, JOBOPS_PASSWORD: PASSWORD, NEXT_DIST_DIR: dist },
      stdio: "ignore", shell: process.platform === "win32" });
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try { await fetch(`${base}/login`, { redirect: "manual" }); up = true; break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { stop(); abort(`the server never answered on ${base}`); }
}

let cookieValue;
if (server) {
  cookieValue = await sign(PASSWORD);
} else {
  const r = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }), redirect: "manual",
  });
  const set = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${COOKIE}=`));
  if (!set) { stop(); abort(`sign-in failed (${r.status})`); }
  cookieValue = set.split(";")[0].slice(COOKIE.length + 1);
}

const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true,
  args: [`--window-size=${WIDTH},${HEIGHT}`],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  const url = new URL(base);
  await browser.setCookie({ name: COOKIE, value: cookieValue, domain: url.hostname, path: "/" });

  let checked = 0;
  for (const [tourName, steps] of Object.entries(TOURS)) {
    const pages = [...new Set(steps.map((s) => s.page))];
    for (const p of pages) {
      await page.goto(base + p, { waitUntil: "networkidle0", timeout: 60_000 });
      const info = await page.evaluate(() => ({
        chars: document.body.innerText.length,
        onLogin: !!document.querySelector("form input[type=password]"),
      }));
      if (info.onLogin) { stop(); abort(`${p} came back as the LOGIN page.`); }
      if (info.chars < 200) { stop(); abort(`${p} rendered ${info.chars} characters.`); }

      const mine = steps.filter((s) => s.page === p);
      const got = await page.evaluate((sels) => sels.map((sel) => {
        let el = null;
        try { el = document.querySelector(sel); } catch { return { sel, bad: true }; }
        if (!el) return { sel, found: false };
        const r = el.getBoundingClientRect();
        return { sel, found: true, w: Math.round(r.width), h: Math.round(r.height) };
      }), mine.map((s) => s.selector));

      for (let k = 0; k < mine.length; k++) {
        const s = mine[k];
        const g = got[k];
        checked++;
        if (g.bad) { fails.push(`${tourName}/${s.id}: "${s.selector}" is not a valid selector`); continue; }
        // A CONDITIONAL step is one whose target legitimately depends on the
        // data — the composite checklist exists only when two windows share a
        // close date. Demanding it be on the page today would assert the
        // calendar, not the code, and fail the day the data changes (it did:
        // ingesting the real 2026-27 dates left one firm closing alone). What
        // the test is actually for — a renamed class turning a step into a
        // silent skip — is still checked, against the source: the class must
        // be written somewhere under app/. If it is on the page as well,
        // better, and it says so.
        if (s.conditional && !g.found) {
          const where = classInSource(s.selector);
          ok(!!where,
             `${p.padEnd(11)} ${s.id.padEnd(20)} ${s.selector}`
             + (where ? `  (not on page today — ${s.conditional}; class is real, in ${where})`
                      : `  <-- MATCHES NOTHING, and the class appears nowhere under app/`));
          continue;
        }
        ok(g.found && g.w > 0 && g.h > 0,
           `${p.padEnd(11)} ${s.id.padEnd(20)} ${s.selector}`
           + (g.found ? ` (${g.w}x${g.h})` : "  <-- MATCHES NOTHING"));
      }
    }
  }

  // A run that checked nothing is not a passing run.
  if (checked === 0) { stop(); abort("no tour steps were checked at all."); }
  // And the source check can fail too, or a conditional step could point at
  // a class that was deleted last month and pass forever.
  ok(!classInSource(".tour-class-that-does-not-exist"),
     "control: a conditional step's class that is in no source file IS detectable");
  ok(checked >= 15, `${checked} tour targets checked across every page a tour visits`);

  /* PROVE IT CAN FAIL. A selector that cannot match must be reported — this
     check is a DOM query behind a page load and a login, every one of which
     could silently return nothing. */
  await page.goto(`${base}/`, { waitUntil: "networkidle0", timeout: 60_000 });
  const control = await page.evaluate(() => !document.querySelector(".tour-selector-that-does-not-exist"));
  ok(control, "control: a selector matching nothing IS detectable, so this test can fail");
} finally {
  await browser.close();
  stop();
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED of ${pass + fails.length}\n`);
  for (const f of fails) console.log(`  ${f}`);
  console.log("\n  A step whose selector matches nothing is SKIPPED at runtime and the");
  console.log("  tour silently gets shorter. Fix the selector in lib/tour.js, or delete");
  console.log("  the step — do not leave it pointing at a class that no longer exists.");
  process.exit(1);
}
console.log(`\n${pass}/${pass} passed`);
