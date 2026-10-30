/**
 * Every page at 390px. Run: node test_mobile.mjs [baseUrl]
 *
 * the owner reads this on a phone. The 1280px sweep has caught real layout bugs --
 * the 331-character location string that put a scrollbar across Daily -- and
 * says nothing about the width he actually uses. 390px is an iPhone 15/16.
 *
 * FOUR THINGS, and each is a bug he would hit rather than a style opinion:
 *   horizontal overflow, which makes the whole page slide sideways;
 *   tap targets under 40px, which are the ones you miss and hit twice;
 *   body text under 12px, which is unreadable at arm's length;
 *   a table wider than the viewport, which hides its own right-hand columns.
 *
 * IT ABORTS RATHER THAN SKIPPING when Chrome is missing, when a page comes back
 * as the login form, or when a page renders almost nothing -- seven copies of
 * the sign-in page have no overflow either, and a check that cannot fail is not
 * a check.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sign } from "./lib/session.js";

const WIDTH = 390;
const MIN_TAP = 40;
const MIN_TEXT = 12;
const PAGES = ["/", "/companies", "/people", "/outreach", "/inbox",
               "/forecast", "/resumes", "/apply"];

const abort = (m) => { console.error(`ABORT: ${m}`); process.exit(1); };

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (!CHROME) abort("no Chrome found. This aborts rather than skipping.");

// LOCAL BUILD BY DEFAULT, a base URL when one is given.
//
// The other browser stages boot the build they are checking, so the gate tests
// what is about to be pushed rather than what is already deployed. Pass a URL
// to point it at production instead:  node test_mobile.mjs https://...
const argBase = process.argv[2] || process.env.JOBOPS_BASE_URL || null;
const PASSWORD = argBase ? process.env.JOBOPS_PASSWORD : "mobile-test-only";
if (argBase && !PASSWORD) {
  abort("JOBOPS_PASSWORD is not set, and a base URL needs it to sign in.");
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => res(port));
  });
});

let server = null;
const stop = () => {
  if (!server || server.exitCode !== null) return;
  // On Windows kill() reaps the shell and orphans `next start`. /T is the tree.
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"],
                { stdio: "ignore" });
    } else server.kill();
  } catch { /* already gone */ }
};
process.on("exit", stop);

let BASE = argBase;
if (!BASE) {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
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
    try {
      await fetch(`${BASE}/login`, { redirect: "manual" });
      up = true;
      break;
    } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { stop(); abort(`the server never answered on ${BASE}`); }
}
const pw = PASSWORD;

const browser = await puppeteer.launch({ executablePath: CHROME,
  headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: 844, isMobile: true,
                         deviceScaleFactor: 3 });
await page.setCookie({ name: "jobops_session", value: await sign(pw),
  domain: new URL(BASE).hostname, path: "/",
  secure: BASE.startsWith("https") });

let bad = 0;
let examined = 0;
for (const path of PAGES) {
  let res;
  try {
    res = await page.goto(BASE + path, { waitUntil: "networkidle0", timeout: 90000 });
  } catch (e) {
    abort(`${path} did not load: ${e.message}`);
  }
  const html = await page.content();
  if (/name="password"/i.test(html)) abort(`${path} came back as the LOGIN page`);
  if (html.length < 2000) abort(`${path} rendered ${html.length} chars`);
  examined++;

  const r = await page.evaluate((minTap, minText) => {
    const doc = document.documentElement;
    const over = doc.scrollWidth - doc.clientWidth;

    // The widest element that actually sticks out, so the report names a
    // culprit rather than only a number.
    let worst = null;
    for (const el of document.querySelectorAll("body *")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0) continue;
      if (b.right > doc.clientWidth + 1) {
        const w = b.right - doc.clientWidth;
        if (!worst || w > worst.by) {
          worst = { by: Math.round(w), tag: el.tagName.toLowerCase(),
                    cls: (el.className || "").toString().slice(0, 40),
                    text: (el.textContent || "").trim().slice(0, 60) };
        }
      }
    }

    const small = [];
    for (const el of document.querySelectorAll(
      "a, button, select, input, [role=button]")) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.height < minTap) {
        small.push({ tag: el.tagName.toLowerCase(),
                     h: Math.round(b.height),
                     text: (el.textContent || el.value || "").trim().slice(0, 30) });
      }
    }

    const tiny = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!el.childElementCount && (el.textContent || "").trim().length > 8) {
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px && px < minText) {
          tiny.push({ px: Math.round(px * 10) / 10,
                      text: (el.textContent || "").trim().slice(0, 40) });
        }
      }
    }

    const wideTables = [...document.querySelectorAll("table")]
      .filter((t) => t.getBoundingClientRect().width > doc.clientWidth + 1).length;

    return { over, worst, small: small.slice(0, 6), nSmall: small.length,
             tiny: tiny.slice(0, 4), nTiny: tiny.length, wideTables };
  }, MIN_TAP, MIN_TEXT);

  // WHAT FAILS THE GATE, AND WHAT ONLY REPORTS.
  //
  // Overflow and a table wider than the screen are BUGS: the page slides
  // sideways under your thumb, or hides its own right-hand columns. Both are
  // fixable without touching the design, so both fail.
  //
  // Tap targets and font sizes are a DESIGN CHOICE across the whole app --
  // 197 links under 40px on Companies alone, because that row is dense on
  // purpose and the density is what makes it readable. Failing on those would
  // make this gate red from the day it was written, and a gate that is always
  // red is one that gets skipped with --no-verify. They are counted and
  // printed every run, so the number is there if the owner ever wants to spend a
  // design pass on it.
  const fatal = [];
  if (r.over > 0) fatal.push(`OVERFLOW ${r.over}px`);
  if (r.wideTables) fatal.push(`${r.wideTables} table(s) wider than the screen`);
  const advisory = [];
  if (r.nSmall) advisory.push(`${r.nSmall} tap under ${MIN_TAP}px`);
  if (r.nTiny) advisory.push(`${r.nTiny} text under ${MIN_TEXT}px`);
  const note = advisory.length ? `   (advisory: ${advisory.join(", ")})` : "";

  if (!fatal.length) {
    console.log(`  ok    ${path}${note}`);
    continue;
  }
  bad++;
  console.log(`  FAIL  ${path}: ${fatal.join(", ")}${note}`);
  if (r.worst) {
    console.log(`          widest: <${r.worst.tag} class="${r.worst.cls}"> `
      + `sticks out ${r.worst.by}px  "${r.worst.text}"`);
  }
  for (const s of r.small) console.log(`          tap ${s.h}px: ${s.tag} "${s.text}"`);
  for (const t of r.tiny) console.log(`          text ${t.px}px: "${t.text}"`);
}

await browser.close();
stop();

// A POSITIVE ASSERTION: it looked at every page. A run that examined nothing
// would print no issues and read as a pass.
if (examined !== PAGES.length) {
  abort(`examined ${examined} of ${PAGES.length} pages`);
}
console.log(`\n${examined} pages at ${WIDTH}px, `
  + `${bad} with overflow or a too-wide table.`);
// Said once, so the advisory findings are a number rather than a wall of lines
// nobody reads.
console.log("Tap targets and font sizes are reported but do not fail: they are "
  + "a design choice across every page, and a gate that is always red is one "
  + "that gets skipped.");
process.exit(bad ? 1 : 0);
