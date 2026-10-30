/**
 * The apply-log paste box, clicked for real. Run: node test_applied_browser.mjs
 *
 * TWO PATHS, AND THE SECOND ONE IS WHY THIS EXISTS.
 *
 *   1. A real log pastes and the rows land.
 *   2. A non-empty paste that parses to nothing renders RED and echoes the
 *      text back.
 *
 * The second is not a nicety. "0 imported" on a green page is
 * indistinguishable from "there was nothing to import", and that class of
 * failure has bitten this project on three separate surfaces. It is also the
 * kind of bug no unit test can see: the route returns the right JSON, the
 * component has the right branch, and the banner is still invisible if the CSS
 * clips it -- which is exactly what happened to the optimistic-save rollback,
 * where every test passed and the error message was hidden by the width of a
 * column.
 *
 * IT WRITES A MARKED ROW INTO THE REAL TABLE, and cannot use the scratch
 * schema the other write tests use.
 *
 * That was the first attempt and it 500s. Redirecting the search path points
 * the WHOLE APP at the scratch schema, and the layout that wraps every page
 * reads a dozen tables -- jobs, actions, batches, deadlines, contacts -- none
 * of which exist there. `parserOpenTable` on the first render.
 *
 * So the isolation mechanism has a boundary worth naming: a scratch schema
 * works for a SCRIPT under test, whose whole surface is one or two tables, and
 * not for a browser test, which necessarily drives every query the app makes.
 *
 * What makes this safe instead is the marker. Every row it creates carries an
 * employer no company could ever match, it deletes them by that marker, and it
 * ASSERTS the deletion -- the assertion being the part the first version of
 * test_runhistory.mjs did not have, which is how a fake run ended up in the
 * digest as the most recent one.
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { COOKIE, sign } from "./lib/session.js";
import { all, run as exec, USING_PG } from "./lib/driver.js";

let pass = 0;
const fails = [];
const ok = (c, w) => (c ? (pass++, 0) : fails.push(w));

function abort(msg) {
  console.error(`\ntest_applied_browser: ${msg}\n`);
  process.exit(1);
}

if (!USING_PG) {
  console.log("test_applied_browser: SKIPPED — needs Postgres.");
  process.exit(0);
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
  // ABORTS RATHER THAN SKIPPING. A browser test that silently does not run
  // reports success just as cheerfully as one that passed.
  abort("no Chrome found. Set JOBOPS_CHROME.");
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

/**
 * An employer no company in companies.yaml can ever match, so this row can
 * never be mistaken for a real application and can always be found again.
 */
const MARK = "ZZ Browser Test Employer";
const MARKED_NOTE = "zz-browser-test-marker";
const PASSWORD = "test-password-for-the-apply-log";
const dist = process.env.NEXT_DIST_DIR || ".next";
if (!fs.existsSync(path.join(import.meta.dirname, dist))) {
  abort(`no build at ${dist}. Run \`npm run build\` first.`);
}

// EVERY applied_imports ROW THAT EXISTED BEFORE, so the ones this test creates
// can be removed by difference.
//
// The first version deleted by content -- the failed row keeps its raw text and
// is findable -- and left the SUCCESSFUL one behind, because `raw` is null on a
// success by design. A cleanup that can only find the rows it thought about is
// the same shape as the one that missed pipeline_status.
const startedAt = new Date().toISOString();
const importsBefore = new Set((await all("SELECT id FROM applied_imports")
  .catch(() => [])).map((r) => r.id));

let server = null;
let browser = null;
const stopServer = () => {
  if (!server || server.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    } else server.kill();
  } catch { /* already gone */ }
};
process.on("exit", stopServer);

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "start", "-p", String(port)],
    {
      cwd: import.meta.dirname,
      // NO ANTHROPIC KEY, DELIBERATELY.
      //
      // The zero-row paste reaches the model fallback for real, and this test
      // runs on every push. Left alone it would make a billed API call each
      // time and burn the 5/month extract sub-cap inside a week -- at which
      // point the test would start exercising the CAPPED path instead of the
      // one it was written for, and would look exactly the same doing it.
      //
      // Unset, askAvailability() refuses before any request is built. The
      // fallback is still called, still returns a reason, and the reason still
      // reaches the banner -- so the path is exercised end to end and costs
      // nothing. What is NOT tested here is a successful extraction; that is
      // test_grok.mjs's job, with a counting fake.
      env: { ...process.env, JOBOPS_PASSWORD: PASSWORD, NEXT_DIST_DIR: dist,
             JOBOPS_DIRECT: "1", JOBOPS_ANTHROPIC_KEY: "" },
      stdio: "ignore",
      shell: process.platform === "win32",
    },
  );
  if (!(await waitFor(`${base}/login`, 90_000, server))) {
    abort(`the server never answered on ${base}`);
  }

  browser = await puppeteer.launch({
    executablePath: chromePath(), headless: true, args: ["--window-size=1280,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setCookie({ name: COOKIE, value: await sign(PASSWORD),
                         domain: "127.0.0.1", path: "/" });

  const go = async () => {
    await page.goto(`${base}/applications`, { waitUntil: "networkidle0" });
    const body = await page.evaluate(() => document.body.innerText);
    // A PAGE THAT CAME BACK AS THE LOGIN FORM is not a page under test, and
    // seven copies of the sign-in page pass most assertions written about a
    // real one.
    if (/Sign in|password/i.test(body) && !/Applications/i.test(body)) {
      abort("the page came back as the login form; the session cookie did not take");
    }
    return body;
  };

  const type = async (text) => {
    await page.evaluate(() => {
      const t = document.querySelector("#applylog");
      if (t) { t.value = ""; }
    });
    await page.click("#applylog");
    await page.type("#applylog", text);
    await page.click(".pastebox button[type=submit]");
  };

  /* ---------------------------------------------------------- happy path */

  let body = await go();
  ok(/Applications/.test(body), "the page renders");
  ok(/Import the apply log/.test(body), "with the paste box");

  await type(`2026-09-08 | linkedin | ${MARK} | Product Manager | Costa Mesa, CA | success | ${MARKED_NOTE}`);
  await page.waitForSelector("[data-testid=import-ok]", { timeout: 20_000 })
    .catch(() => null);
  const okMsg = await page.$eval("[data-testid=import-ok]", (e) => e.innerText)
    .catch(() => null);
  ok(okMsg && /1 new/.test(okMsg), `a real log imports (${okMsg})`);

  const stored = await all(
    "SELECT employer_raw, role, status, employer_id, source FROM applied_apps "
    + "WHERE employer_raw = ?", [MARK]);
  ok(stored.length === 1, `and the row is in the database (${stored.length})`);
  ok(stored[0]?.role === "Product Manager",
     `with the role read from the log (${stored[0]?.role})`);
  ok(stored[0]?.source === "grok_paste", "and the source recorded");
  // AN EMPLOYER NO COMPANY MATCHES, on purpose: it keeps this row identifiable
  // and unmistakable for a real application, and it exercises the unmatched
  // path at the same time.
  ok(stored[0]?.employer_id === null,
     `and no company matched, which is correct for a name that is not one `
     + `(${stored[0]?.employer_id})`);

  body = await go();
  ok(body.includes(MARK), "the row renders on the page afterwards");
  ok(/Unmatched employers/.test(body),
     "and the unmatched list appears rather than the row being dropped");

  /* ------------------------------------------------------ resolving a name

   * A RESOLVE THAT ONLY CLEARS A WARNING LOOKS EXACTLY LIKE ONE THAT WORKED.
   * the owner resolved "Andurl" to Anduril: the unmatched section vanished and the
   * red flag went, and the row still read "Andurl" -- so nothing on the page
   * told a link that had been WRITTEN from a flag that had been CLEARED.
   *
   * So this asserts the LINK, in the database, and the canonical name, on the
   * page. The absence of the flag is not evidence and is not asserted. */
  const select = await page.$(`select[aria-label="Company for ${MARK}"]`);
  ok(select, "the unmatched employer offers a company select");
  await page.select(`select[aria-label="Company for ${MARK}"]`, "andurilindustries");
  await new Promise((r) => setTimeout(r, 1500));

  const linked = await all(
    "SELECT employer_id FROM applied_apps WHERE employer_raw = ?", [MARK]);
  ok(linked[0]?.employer_id === "andurilindustries",
     `the resolve WROTE the company link (${linked[0]?.employer_id}) -- this is `
     + "the assertion, not the disappearance of the warning");

  body = await go();
  ok(/Anduril/.test(body),
     "and the row now renders the canonical companies.yaml name");
  ok(body.includes(MARK),
     "with the log's own words still beside it, because a wrong link is only "
     + "findable by comparing the two");

  // AND A SLUG THAT IS NOT A COMPANY IS REFUSED, so the resolve cannot write
  // a link to something that does not exist.
  const bad = await fetch(`${base}/api/applications`, {
    method: "PATCH",
    headers: { "content-type": "application/json",
               cookie: `${COOKIE}=${await sign(PASSWORD)}` },
    body: JSON.stringify({ employer_raw: MARK, employer_id: "not-a-company" }),
  });
  ok(bad.status === 400, `an unknown slug is refused (${bad.status})`);
  const still = await all(
    "SELECT employer_id FROM applied_apps WHERE employer_raw = ?", [MARK]);
  ok(still[0]?.employer_id === "andurilindustries",
     "and the existing link is untouched by the refusal");

  /* -------------------------------------------------- the zero-row banner */

  await type("Hi Jordan, just checking in about the role. Best, Sam");
  await page.waitForSelector("[data-testid=import-failed]", { timeout: 20_000 })
    .catch(() => null);

  const banner = await page.$("[data-testid=import-failed]");
  ok(banner, "a paste that parses to nothing renders the RED banner");

  const seen = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=import-failed]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      text: el.innerText,
      // VISIBLE, not merely present. The optimistic-save rollback rendered its
      // error correctly and it was clipped by the width of a column, so a
      // failed save looked exactly like never having clicked -- the precise
      // lie the banner exists to prevent.
      visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden"
        && cs.display !== "none" && Number(cs.opacity) > 0,
      onScreen: r.top < window.innerHeight && r.bottom > 0
        && r.left < window.innerWidth && r.right > 0,
    };
  });
  ok(seen?.visible, `and it is actually VISIBLE (${JSON.stringify(seen)})`);
  ok(seen?.onScreen, "and inside the viewport rather than clipped off it");
  ok(/Nothing was imported/i.test(seen?.text || ""),
     `saying so in words (${seen?.text?.slice(0, 80)})`);
  ok(/just checking in/.test(seen?.text || ""),
     "and echoing the paste back, so which paste failed is not a memory test");

  // THE FALLBACK WAS REACHED AND SAID WHY IT COULD NOT HELP. "Nothing
  // parsed" and "nothing parsed and the model could not read it either" are
  // different findings, and the banner has to carry which one it was.
  ok(/model fallback/i.test(seen?.text || ""),
     `the banner names the model fallback too (${seen?.text?.slice(0, 160)})`);

  // NOTHING GREEN AT THE SAME TIME. A page showing both a success note and a
  // failure banner is worse than either.
  const alsoOk = await page.$("[data-testid=import-ok]");
  ok(!alsoOk, "with no success message beside it");

  // AND NOTHING WAS WRITTEN. The banner is the visible half; this is the half
  // that matters to the data.
  const after = await all(
    "SELECT id FROM applied_apps WHERE employer_raw = ?", [MARK]);
  ok(after.length === 1,
     `the failed paste stored nothing (still ${after.length} row)`);

  // THE FAILURE IS RECORDED, so a paste format that quietly stopped working
  // leaves a trail rather than only a banner the owner has already dismissed.
  const imports = await all(
    "SELECT ok, chars, raw FROM applied_imports WHERE raw LIKE ?",
    ["%just checking in%"]);

  // AND NOTHING WAS BILLED. With no key the fallback refuses before it builds
  // a request, so no ask_queries row exists for this run -- which is what
  // keeps a per-push browser test from spending money and eating the sub-cap.
  const spent = await all(
    "SELECT id FROM ask_queries WHERE asked_at >= ?", [startedAt]);
  ok(Array.isArray(spent) && spent.length === 0,
     `no model call was billed by this test (${JSON.stringify(spent)})`);
  ok(imports.length >= 1,
     `the failed import is logged (${imports.length})`);
  ok(imports.every((i) => Number(i.ok) === 0),
     "as a FAILURE rather than a quiet success");
  ok(imports.some((i) => /just checking in/.test(i.raw || "")),
     "with the raw text kept, so the shape that broke it can be read later");
} finally {
  if (browser) await browser.close().catch(() => null);
  stopServer();
  // DELETED BY MARKER, AND THE DELETION IS ASSERTED. The assertion is the
  // part that matters: the first version of test_runhistory.mjs cleaned up
  // and did not check, so a row it missed sat in the digest as the most
  // recent real run.
  await exec("DELETE FROM applied_apps WHERE employer_raw = ?", [MARK])
    .catch(() => null);
  for (const r of (await all("SELECT id FROM applied_imports").catch(() => []))) {
    if (!importsBefore.has(r.id)) {
      await exec("DELETE FROM applied_imports WHERE id = ?", [r.id]).catch(() => null);
    }
  }
  const leftApps = await all(
    "SELECT id FROM applied_apps WHERE employer_raw = ?", [MARK])
    .catch((e) => ({ error: e.message }));
  ok(Array.isArray(leftApps) && leftApps.length === 0,
     `the test application is removed (${JSON.stringify(leftApps)})`);
  const nowImports = await all("SELECT id FROM applied_imports")
    .catch((e) => ({ error: e.message }));
  const strays = Array.isArray(nowImports)
    ? nowImports.filter((r) => !importsBefore.has(r.id)) : null;
  ok(strays && strays.length === 0,
     `and EVERY import row it created is gone, counted by difference rather `
     + `than by content (${JSON.stringify(strays)})`);
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
