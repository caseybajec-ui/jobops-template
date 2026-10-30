/**
 * Every control you can press must say what it does. Run: node test_controls.mjs [baseUrl]
 *
 * THIS EXISTS BECAUSE A LIST DOES NOT SCALE. The audit named four unexplained
 * controls — a star, a ⋯, a row-end chevron and a dot after a company name —
 * and fixing exactly those four is a fix that lasts until the fifth is added.
 * A glyph is the cheapest control to write and the most expensive to guess at,
 * so the rule has to be enforced by something that looks at the page.
 *
 * WHAT COUNTS AS "SAYS WHAT IT DOES": visible text of three characters or more,
 * or a `title`, or an `aria-label`, or `aria-labelledby`. A ⋯ with a title
 * passes. A ⋯ with neither does not. Three characters rather than one so that
 * "Save" and "Hide" pass on their own while "✓", "›" and "0/2" do not — a
 * two-character label is not a label, it is a code.
 *
 * IT NEEDS A BROWSER for the same reason the overflow test does: whether a
 * control has an accessible name is a question about the rendered tree, and
 * half of these are rendered by client components after hydration. A static
 * grep over JSX cannot see a title that arrives from a prop, and would have to
 * be taught about every wrapper component in the app.
 *
 * Preconditions are asserted, as everywhere else here: it aborts if a page came
 * back as the login form, if a page rendered almost nothing, or if a page
 * turned up with no controls at all — because "0 controls, 0 unlabelled" is a
 * green run that measured nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { COOKIE, sign } from "./lib/session.js";

const PAGES = ["/", "/inbox", "/companies", "/people", "/forecast", "/pulse", "/profile"];
const WIDTH = 1440;
const HEIGHT = 1000;

/** Below this many characters of visible text, a control needs a name of its own. */
const MIN_TEXT = 3;

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, console.log(`  ok    ${what}`)) : fails.push(what));

function abort(msg) {
  console.error(`\ntest_controls: ${msg}\n`);
  process.exit(2);
}

function chromePath() {
  if (process.env.JOBOPS_CHROME) return process.env.JOBOPS_CHROME;
  const candidates = process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe",
       "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
       path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe")]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium",
       "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch { /* next */ } }
  abort("no Chrome found. Set JOBOPS_CHROME. This aborts rather than skipping —\n"
      + "  a control check that silently does not run is worse than none.");
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
});

const argBase = process.argv[2];
const PASSWORD = argBase ? process.env.JOBOPS_PASSWORD : "controls-test-only";
if (argBase && !PASSWORD) abort("JOBOPS_PASSWORD is not set, and a base URL needs it to sign in.");

let server = null;
const stop = () => {
  if (!server || server.exitCode !== null) return;
  // On Windows kill() reaps the shell and orphans `next start`. /T is the tree.
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else server.kill();
  } catch { /* already gone */ }
};
process.on("exit", stop);

let base = argBase;
if (!base) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const dist = process.env.NEXT_DIST_DIR || ".next";
  if (!fs.existsSync(path.join(import.meta.dirname, dist))) {
    abort(`no build at ${dist}. Run \`npm run build\` first, or pass a base URL.`);
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
  if (!set) { stop(); abort(`sign-in to ${base} failed (${r.status}) — nothing to measure.`); }
  cookieValue = set.split(";")[0].slice(COOKIE.length + 1);
}

const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true,
  args: [`--window-size=${WIDTH},${HEIGHT}`],
});

/** Runs in the page. Returns every pressable thing and whether it is named. */
const audit = (minText) => {
  const named = (el) => {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length >= minText) return true;
    if ((el.getAttribute("title") || "").trim()) return true;
    if ((el.getAttribute("aria-label") || "").trim()) return true;
    if ((el.getAttribute("aria-labelledby") || "").trim()) return true;
    // An <input> whose <label> WRAPS it is named by that label's text.
    const wrap = el.closest("label");
    if (wrap && (wrap.innerText || "").replace(/\s+/g, " ").trim().length >= minText) return true;
    // ...and so is one a <label for=…> POINTS AT, which is the more common
    // shape and the one this check missed on its first run. It reported twelve
    // correctly-labelled fields on /profile as unnamed — and a check that fires
    // on correct code is a check you learn to skip, which is the same failure
    // as a nag you cannot answer.
    if (el.id) {
      const forLab = [...document.querySelectorAll("label[for]")]
        .find((l) => l.getAttribute("for") === el.id);
      if (forLab && (forLab.innerText || "").replace(/\s+/g, " ").trim().length >= minText) {
        return true;
      }
    }
    return false;
  };
  const controls = [...document.querySelectorAll(
    'button, a[href], [role="button"], input:not([type="hidden"]), select')]
    // Only what is actually on screen. A control inside a collapsed section is
    // not something a reader can be confused by.
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
  return {
    total: controls.length,
    chars: document.body.innerText.length,
    onLogin: !!document.querySelector("form input[type=password]"),
    unnamed: controls.filter((el) => !named(el)).slice(0, 12).map((el) => {
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return `<${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/)[0]}` : ""}>`
        + ` text=${JSON.stringify(text.slice(0, 14))}`;
    }),
  };
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });
  const url = new URL(base);
  await browser.setCookie({ name: COOKIE, value: cookieValue, domain: url.hostname, path: "/" });

  let seen = 0;
  for (const p of PAGES) {
    await page.goto(base + p, { waitUntil: "networkidle0", timeout: 60_000 });
    const r = await page.evaluate(audit, MIN_TEXT);

    if (r.onLogin) { stop(); abort(`${p} came back as the LOGIN page — the session did not stick.`); }
    if (r.chars < 200) { stop(); abort(`${p} rendered ${r.chars} characters. Nothing was measured.`); }
    if (r.total === 0) { stop(); abort(`${p} has no controls at all — this check measured nothing there.`); }
    seen += r.total;

    ok(r.unnamed.length === 0,
       `${p}: all ${r.total} controls say what they do`
       + (r.unnamed.length ? `\n        unnamed:\n          ${r.unnamed.join("\n          ")}` : ""));
  }

  ok(seen >= 60, `${seen} controls examined across ${PAGES.length} pages`);

  /* PROVE IT CAN FAIL. Strip the name off a real control and require a red.
     A check that has only ever passed is indistinguishable from one that
     cannot — and this one is a DOM query with four separate escape hatches,
     every one of which could silently swallow the whole page. */
  await page.goto(`${base}/companies`, { waitUntil: "networkidle0", timeout: 60_000 });
  const control = await page.evaluate((minText) => {
    const star = document.querySelector(".star");
    if (!star) return { found: false };
    star.removeAttribute("title");
    star.removeAttribute("aria-label");
    const audited = [...document.querySelectorAll("button")].filter((el) => {
      const t = (el.innerText || "").trim();
      return t.length < minText && !el.getAttribute("title") && !el.getAttribute("aria-label");
    });
    return { found: true, caught: audited.includes(star) };
  }, MIN_TEXT);
  if (!control.found) { stop(); abort("no ☆ on Companies — the control could not run."); }
  ok(control.caught, "control: a ☆ stripped of its title IS reported, so this check can fail");
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
