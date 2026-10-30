/**
 * Fetch a page WITH JavaScript, and print its rendered HTML.
 *
 *   node render_page.mjs <url> [<url> ...]
 *
 * WHY. Portfolio and careers pages overwhelmingly render their lists
 * client-side: a16z's portfolio returns only exit labels to a plain GET, and
 * six of Item 2's companies "have no ATS link" only because the link does not
 * exist until React runs. A plain fetch cannot tell "no board" from "board
 * arrives 400ms later", and those are completely different facts.
 *
 * ONE BROWSER, MANY URLS, so the python caller pays the launch cost once.
 * Output is NDJSON: one {url, ok, html, error} per line.
 *
 * IT WAITS FOR CONTENT, not for a timer. networkidle2 plus a short settle,
 * because a list that arrives after the last XHR is the whole point.
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (!CHROME) {
  console.error("ABORT: no Chrome. Rendering aborts rather than silently "
    + "falling back to a plain fetch, which would report every JS page as "
    + "having no board.");
  process.exit(1);
}

const urls = process.argv.slice(2);
if (!urls.length) { console.error("ABORT: no urls given"); process.exit(1); }

const browser = await puppeteer.launch({ executablePath: CHROME,
  headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });

for (const url of urls) {
  const out = { url, ok: false, html: "", error: null };
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 2400 });
    // Images and fonts are megabytes and tell us nothing; the link we want is
    // in the DOM. Scripts and XHR must be allowed -- they ARE the point.
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const t = r.resourceType();
      if (t === "image" || t === "font" || t === "media") r.abort();
      else r.continue();
    });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
    // A settle for lists that render after the last request resolves.
    await new Promise((r) => setTimeout(r, 1500));
    // Scroll once: many portfolio grids lazy-load on viewport entry.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise((r) => setTimeout(r, 1200));
    out.html = await page.content();
    out.ok = out.html.length > 1000;
    if (!out.ok) out.error = `rendered only ${out.html.length} chars`;
  } catch (e) {
    out.error = `${e.constructor.name}: ${String(e.message).slice(0, 120)}`;
  } finally {
    if (page) await page.close().catch(() => {});
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}
await browser.close();
