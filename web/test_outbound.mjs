/**
 * What this app is allowed to talk to. Run: node test_outbound.mjs
 *
 * TWO RULES, both from CLAUDE.md, both currently true by construction and both
 * one careless import away from not being:
 *
 *   THE WEB APP NEVER CALLS THE ANTHROPIC API. Scoring lives in the Python
 *   scripts and runs on cron under a $5/month cap that refuses before it spends.
 *   A fetch from a page render would bypass the cap entirely and bill per
 *   VISITOR — and the failure mode is a bill, discovered late.
 *
 *   THE APP NEVER SCRAPES ANYBODY. Rule 2: contacts are typed by hand from the
 *   alumni directory, and LinkedIn's terms prohibit fetching. Building a linkedin
 *   URL and opening it in the user's own tab is fine and is what the alumni
 *   search does; fetching one from a server is not.
 *
 * A grep is what confirmed this once. A grep run once is a fact about a
 * Tuesday, so it is a test.
 *
 * IT DISTINGUISHES A LINK FROM A FETCH, which is the whole difficulty: the
 * codebase is full of https:// strings that are hrefs, and an href is a person
 * clicking something in their own browser.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, 0) : fails.push(what));

/**
 * The only third-party host any code here may FETCH, and where from.
 *
 * Resend is in the sender, which runs in GitHub Actions. Nothing under app/ may
 * reach it — test_notify.mjs asserts that separately and from the other
 * direction.
 */
const ALLOWED_FETCH = {
  "api.resend.com": ["lib/notify.mjs"],
  // The read-only Ask box, capped at 30 questions a month. See lib/ask.js and
  // the amended rule in CLAUDE.md: the web app may not call Anthropic for
  // scoring or for anything that writes, and this is the single exception.
  "api.anthropic.com": ["lib/ask.js"],
};

/**
 * The ONE file that may name Anthropic at all.
 *
 * This guard used to say "no Anthropic, anywhere", which was the rule until the
 * Ask box. The rule is now "not for scoring, not for anything that writes, and
 * exactly one read-only capped exception" — so the check becomes an allow-list
 * of one rather than a blanket ban. Widening it beyond this file means editing
 * this line, which is the point: it cannot happen by accident.
 *
 * test_ask_isolation.py carries the rest of the fence — the key, the cap before
 * the request, and the single writable table.
 */
const ANTHROPIC_FILE = "lib/ask.js";

/** Hosts that may appear as a LINK but never as a fetch. */
const LINK_ONLY = [
  "www.linkedin.com",       // rule 2: opened in the user's tab, never fetched
  "github.com",             // the run log and the test-email workflow
  "duckduckgo.com",         // a search the user runs
  "console.neon.tech",      // a console the user opens
  "YOUR-APP.vercel.app", // placeholder for this app's own deployed URL
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".next")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [...walk(path.join(here, "lib")), ...walk(path.join(here, "app"))];
ok(files.length > 40, `there are ${files.length} source files to check`);

/* ------------------------------------------------- 1. no Anthropic, anywhere */

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(here, f).replace(/\\/g, "/");
  ok(!/api\.anthropic\.com/.test(src) || rel === ANTHROPIC_FILE,
     `${rel} names the Anthropic API and is not ${ANTHROPIC_FILE}`);
  // The HOST and the SDK IMPORT, not the bare word. "anthropic" also names a
  // company in the category map and appears in a dozen honest comments;
  // flagging those is how a check gets ignored, which is how the real one gets
  // missed.
  ok(!/from\s+["']@anthropic-ai\//.test(src) && !/require\(["']@anthropic-ai\//.test(src),
     `${rel} does not import the Anthropic SDK`);
}

/* ------------------------------------------- 2. every real fetch is allowed */

const FETCH = /\bfetch\(\s*["'`](https?:\/\/[^"'`]+)/g;
const found = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(here, f).replace(/\\/g, "/");
  for (const m of src.matchAll(FETCH)) {
    found.push({ file: rel, url: m[1], host: new URL(m[1]).host });
  }
}

console.log(`\n  ${found.length} absolute fetch(es) in the whole app:`);
for (const f of found) console.log(`    ${f.file}  ->  ${f.host}`);

for (const f of found) {
  const allowed = ALLOWED_FETCH[f.host];
  ok(!!allowed, `${f.host} is on the allowed list (from ${f.file})`);
  if (allowed) {
    ok(allowed.includes(f.file),
       `${f.host} is fetched only from ${allowed.join(", ")} — found in ${f.file}`);
  }
}

/* ---------------------------- 3. nothing under app/ fetches ANY absolute URL */
//
// A page render or a route that reaches out to a third party is the shape of
// both failures above. Relative fetches to this app's own /api are fine and are
// how every write works.

for (const f of found) {
  ok(!f.file.startsWith("app/"),
     `nothing under app/ fetches an absolute URL — ${f.file} fetches ${f.host}`);
}

/* -------------------------------------- 4. link-only hosts are never fetched */

for (const host of LINK_ONLY) {
  const fetched = found.filter((f) => f.host === host);
  ok(fetched.length === 0,
     `${host} is only ever linked, never fetched`
     + (fetched.length ? ` (fetched in ${fetched.map((x) => x.file).join(", ")})` : ""));
}

// LinkedIn is already covered by the LINK_ONLY loop above, from the PARSED
// host. A looser version of this check lived here and was wrong: matching
// `fetch(` followed by "linkedin" anywhere before the closing paren flagged
// `fetch("/api/people", { ... linkedin_url ... })` — a POST to this app's own
// route carrying a field the user typed by hand. A check that fires on correct
// code is one people learn to skip, which is how the real one gets missed.

/* --------------------------------------------- prove the check can go red */
//
// A guard that has only ever passed is indistinguishable from one that cannot
// fail, and this one is a regex over source text — exactly the kind that dies
// silently.

{
  const probe = 'const x = await fetch("https://evil.example.com/steal");';
  const hits = [...probe.matchAll(FETCH)].map((m) => new URL(m[1]).host);
  ok(hits.length === 1 && hits[0] === "evil.example.com",
     "the negative control: an unlisted fetch IS detected by this pattern");

  const link = '<a href="https://www.linkedin.com/school/x">alumni</a>';
  ok([...link.matchAll(FETCH)].length === 0,
     "and an href is NOT mistaken for a fetch");
}

console.log(`\n${pass} checks passed`);
if (fails.length) {
  console.log("\nFAILED:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
