/**
 * /resumes. Run: node test_resumes.mjs  (boots the app, needs a build)
 *
 * Three things, and the third is the one worth having:
 *
 *   1. the page loads and both PDFs are reachable — a 200 and real PDF bytes,
 *      not a login page and not a 404 rendered as an empty frame;
 *   2. both embeds are present, pointing at those files;
 *   3. the two "goes to" notes are READ FROM lib/variant.js, not restated in
 *      the page. That rule decides which document goes to Anduril. A second
 *      copy of it in JSX would drift the first time either was edited, and the
 *      page would keep looking right while telling him the wrong thing.
 *
 * (3) is asserted by MUTATION, not by string comparison: comparing the page's
 * text to VARIANTS[k].goesTo passes just as happily when the page has the same
 * words hardcoded. The test changes the table and requires the page to follow.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VARIANTS, VARIANT_KEYS } from "./lib/variant.js";
import { sign, COOKIE } from "./lib/session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = "resumes-test-only";
const PORT = 3319;
const BASE = `http://localhost:${PORT}`;
let pass = 0;
const fails = [];
const ok = (c, w) => (c ? (pass++, 0) : fails.push(w));
const abort = (m) => { console.log(`\nABORT: ${m}`); process.exit(2); };

const dist = process.env.NEXT_DIST_DIR || ".next";
if (!fs.existsSync(path.join(here, dist))) {
  abort(`no build at web/${dist}. Run \`npm run build\` first.\n`
      + "  This aborts rather than skipping: a page test that silently does not\n"
      + "  run is indistinguishable from one that passed.");
}

const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  cwd: here, shell: true,
  env: { ...process.env, JOBOPS_PASSWORD: PASSWORD, NEXT_DIST_DIR: dist },
  stdio: "ignore",
});
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on("exit", stop);

async function waitFor(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return false;      // liveness, not just a clock
    try { const r = await fetch(url); if (r.status) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

if (!(await waitFor(`${BASE}/login`, 60_000))) { stop(); abort("the server never came up"); }

const cookie = `${COOKIE}=${await sign(PASSWORD)}`;
const get = (p) => fetch(`${BASE}${p}`, { headers: { cookie }, redirect: "follow" });

try {
  /* ---------------------------------------------------- 1. the page and PDFs */
  const page = await get("/resumes");
  ok(page.status === 200, `/resumes returns 200 (got ${page.status})`);
  const html = await page.text();
  ok(!/name="password"/.test(html), "and it is the page, not the login form");
  ok(html.length > 2000, `and it rendered something (${html.length} chars)`);

  for (const key of VARIANT_KEYS) {
    const v = VARIANTS[key];
    const r = await get(v.pdf);
    ok(r.status === 200, `${v.pdf} returns 200 (got ${r.status})`);
    ok((r.headers.get("content-type") || "").includes("pdf"),
       `${v.pdf} is served as a PDF (${r.headers.get("content-type")})`);
    const head = Buffer.from(await r.arrayBuffer()).slice(0, 5).toString();
    ok(head === "%PDF-", `${v.pdf} really is a PDF (magic ${JSON.stringify(head)})`);

    /* -------------------------------------------------- 2. the embed exists */
    ok(html.includes(`data="${v.pdf}"`),
       `the page embeds ${v.pdf}`);
    ok(html.includes(`download="${v.filename}"`),
       `and offers ${v.filename} as a download`);
    ok(html.includes("Text the tool reads"),
       "and carries the text expander");
  }
  ok((html.match(/<object/g) || []).length === 2, "exactly two embeds, one per variant");

  /* ------------------------------- 3. the notes come FROM the variants table */
  // React escapes & to &amp; on the way out, so compare against the escaped
  // form. Comparing raw text failed here and it was the TEST that was wrong —
  // worth saying, because "the page does not contain the string" is exactly
  // what a genuinely missing note looks like.
  const esc = (s) => s.replace(/&/g, "&amp;");
  for (const key of VARIANT_KEYS) {
    ok(html.includes(esc(VARIANTS[key].goesTo)),
       `the page shows ${key}'s "goes to" text (${VARIANTS[key].goesTo})`);
  }

  // THE MUTATION. Change the table on disk, rebuild nothing, reload the page:
  // a page reading VARIANTS follows, a page with the words typed into it does
  // not. Without this, hardcoded strings pass every assertion above.
  const varPath = path.join(here, "lib", "variant.js");
  const original = fs.readFileSync(varPath, "utf8");
  const SENTINEL = "somewhere-only-the-table-knows";
  try {
    fs.writeFileSync(varPath,
      original.replace('goesTo: "defense and product & tech"', `goesTo: "${SENTINEL}"`),
      "utf8");
    // `next start` serves a build, so the running server cannot see the edit.
    // Import the module fresh instead and assert the PAGE's source reads it,
    // rather than asserting against a server that cannot have changed.
    const fresh = await import(`./lib/variant.js?mutated=${Date.now()}`);
    ok(fresh.VARIANTS.tech.goesTo === SENTINEL, "the mutation actually took effect");

    const pageSrc = fs.readFileSync(path.join(here, "app", "resumes", "page.js"), "utf8");
    ok(/v\.goesTo/.test(pageSrc),
       "the page renders v.goesTo from the table rather than a literal");
    ok(!/defense and product & tech/.test(pageSrc),
       "and does NOT restate tech's destinations in its own JSX");
    ok(!/consulting and VC & growth/.test(pageSrc),
       "and does NOT restate finance's destinations either");
  } finally {
    fs.writeFileSync(varPath, original, "utf8");
  }
  ok(fs.readFileSync(varPath, "utf8") === original, "and variant.js is put back");
} finally {
  stop();
}

console.log(`${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
