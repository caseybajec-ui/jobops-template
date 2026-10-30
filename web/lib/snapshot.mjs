/**
 * Snapshot every page's rendered content, so a SQLite -> Postgres diff can prove
 * nothing changed.
 *
 *   node lib/snapshot.mjs http://localhost:3399 ../snapshots/sqlite.json
 *   node lib/snapshot.mjs http://localhost:3399 ../snapshots/postgres.json
 *   node lib/snapshot.mjs --diff ../snapshots/sqlite.json ../snapshots/postgres.json
 *
 * The async conversion's failure shape is a BLANK SECTION, and "nothing today",
 * "none owed" and "nothing closing inside 21 days" are all legitimate states on
 * these pages. So an empty section looks like an ordinary quiet Tuesday, and the
 * only way to catch it is to have written down what the page said beforehand.
 *
 * What is captured, and why each part:
 *
 *   sections       every <h2> with its row count, INCLUDING zero-count ones, so
 *                  a 0 is compared against a 0 rather than against a missing key
 *                  — a disappeared section and an empty section must not look
 *                  the same in the diff
 *   rows           first five per list: company, title, band, pay. Enough that a
 *                  silently reordered or filtered list shows up
 *   emptyStates    which sections rendered "Nothing ..." rather than a list
 *   numbers        every integer and money figure in the footers and notes
 *   aboutCounts    the four /about figures specifically — that page reads counts
 *                  from four different sources in one paragraph, which is why the
 *                  CRLF bug surfaced there first while Forecast looked fine
 *   navBadge       the "closing soon" count, or null
 *
 * The HTML is parsed with regex, which is fragile in general and fine here: both
 * snapshots go through the identical parser, so any quirk cancels out in the diff.
 */
import fs from "node:fs";
import path from "node:path";

const PAGES = [
  ["daily", "/"],
  ["inbox", "/inbox"],
  ["inbox-worth", "/inbox?worth=1"],
  ["companies", "/companies"],
  ["forecast", "/forecast"],
  ["gate", "/gate"],
  ["about", "/about"],
];

const strip = (h) =>
  h.replace(/<script[\s\S]*?<\/script>/g, " ")
   .replace(/<style[\s\S]*?<\/style>/g, " ")
   .replace(/<[^>]+>/g, " ")
   .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&nbsp;/g, " ").replace(/&#x27;|&apos;/g, "'")
   .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, "…")
   .replace(/\s+/g, " ").trim();

/** Text of the first element with a given class inside a fragment. */
function cls(frag, name) {
  const m = frag.match(new RegExp(`class="[^"]*\\b${name}\\b[^"]*"[^>]*>([\\s\\S]*?)</`, ""));
  return m ? strip(m[1]) : null;
}

/** Split the body into <h2>-delimited sections, keeping order. */
function sections(html) {
  const out = [];
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>/g;
  const marks = [];
  let m;
  while ((m = re.exec(html))) marks.push({ title: strip(m[1]), at: m.index, end: re.lastIndex });
  for (let i = 0; i < marks.length; i++) {
    const body = html.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].at : html.length);
    out.push({ title: marks[i].title, body });
  }
  return out;
}

const ROW_CLASSES = ["role", "row", "crow", "frow", "drow", "prow", "krow", "item"];

function countRows(body) {
  const counts = {};
  for (const c of ROW_CLASSES) {
    // class="row " or class="row open" — but never the header row
    const re = new RegExp(`class="${c}(?:[ "])`, "g");
    let n = (body.match(re) || []).length;
    if (["row", "crow", "frow", "drow", "prow", "krow"].includes(c)) {
      const heads = (body.match(new RegExp(`class="${c} head"`, "g")) || []).length;
      n -= heads;
    }
    // The "next step" line under a target company is a .crow but not a company.
    if (c === "crow") n -= (body.match(/class="crow nextrow"/g) || []).length;
    if (n > 0) counts[c] = n;
  }
  return counts;
}

function firstRows(body, limit = 5) {
  const out = [];
  const re = /<div class="(role|row|crow|frow|drow|prow|krow)(?![^"]*head)[^"]*"[\s\S]*?(?=<div class="(?:role|row|crow|frow|drow|prow|krow|detail)|<\/div>\s*<\/section>|$)/g;
  let m;
  while ((m = re.exec(body)) && out.length < limit) {
    const frag = m[0];
    out.push({
      company: cls(frag, "co"),
      title: cls(frag, "title") || cls(frag, "who"),
      band: cls(frag, "band"),
      pay: cls(frag, "pay") || cls(frag, "num"),
    });
  }
  return out;
}

/** Every integer and $ figure in the visible text, in order. */
function numbers(text) {
  return (text.match(/\$?\d[\d,]*(?:\.\d+)?K?/g) || []).map((s) => s.trim());
}

async function snap(base) {
  const out = { pages: {} };
  for (const [name, url] of PAGES) {
    const res = await fetch(base + url, { headers: authHeaders });

    // SELF-CHECK, SIGNED-IN. The same shape as the row-count guard below, for
    // the same reason: a snapshot that captured seven copies of the login page
    // would diff as IDENTICAL and mean nothing at all. That is the second time
    // in this project a verification tool measured nothing while reporting
    // success, so it aborts rather than records.
    const peek = await res.clone().text();
    if (res.url?.includes("/login") || peek.includes("JobOps is private")) {
      // console.error + exit, not throw: throwing while a fetch is in flight
      // trips a libuv assertion on Windows and the real message scrolls away
      // behind a native crash dump. Node still prints that assertion after the
      // message and exits 127 rather than 6, because Windows objects to exiting
      // with keep-alive sockets open. The three properties that matter hold: the
      // reason is legible, the exit is non-zero, and NO FILE IS WRITTEN.
      console.error(
        `snapshot got the LOGIN PAGE for /${url} — the session is not valid.
` +
        `  Recording this would produce a diff that passes while measuring
` +
        `  nothing. Check JOBOPS_PASSWORD matches the server's.`);
      process.exit(6);
    }
    const html = await res.text();
    const text = strip(html);
    const page = { status: res.status, sections: {}, rows: {}, emptyStates: [], numbers: {} };

    // Rows counted over the WHOLE page, always. Inbox and Gate have no <h2> at
    // all, so a section-only walk captured nothing for them and a completely
    // blank Inbox would have diffed clean. Page totals catch that.
    page.pageRows = countRows(html);
    page.pageFirstRows = firstRows(html);

    for (const s of sections(html)) {
      const counts = countRows(s.body);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      // Zero-count sections are RECORDED, not omitted.
      page.sections[s.title] = { rows: total, byClass: counts };
      const rows = firstRows(s.body);
      if (rows.length) page.rows[s.title] = rows;
      const nothing = s.body.match(/class="nothing"[^>]*>([\s\S]*?)<\/p>/);
      if (nothing) page.emptyStates.push({ section: s.title, text: strip(nothing[1]) });
    }

    // Footers and standing notes: every figure, in order.
    for (const [label, re] of [
      ["footer", /class="filters foot"[\s\S]*?<\/div>/g],
      ["note", /class="note"[\s\S]*?<\/p>/g],
      ["status", /class="status"[\s\S]*?<\/p>/g],
      ["freshness", /class="freshness[^"]*"[^>]*>([\s\S]*?)<\/p>/g],
    ]) {
      const hits = html.match(re) || [];
      if (hits.length) page.numbers[label] = hits.map((h) => numbers(strip(h)));
    }

    const badge = html.match(/class="cnt[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    page.navBadge = badge ? strip(badge[1]) : null;

    if (name === "about") {
      // The four counts this page derives from four different sources.
      const g = (re) => { const m = text.match(re); return m ? m[1] : null; };
      page.aboutCounts = {
        rolesScored: g(/across (\d[\d,]*) roles/),
        strongBand: g(/(\d[\d,]*) of them land in Strong/),
        deadlineWindows: g(/Those (\d[\d,]*) windows/),
        postingsOpen: g(/Right now: (\d[\d,]*) postings open/),
        reachable: g(/postings open, (\d[\d,]*) a new grad can get/),
        strongPlus: g(/a new grad can get, (\d[\d,]*) strong or better/),
      };
    }
    // SELF-CHECK. A page with no rows AND no sections means the snapshot failed
    // to see anything, not that the page is empty — which is exactly how the
    // first version of this tool was blind to Inbox and Gate while reporting
    // success. /about legitimately has 0 rows but 4 sections, so it passes.
    const totalRows = Object.values(page.pageRows).reduce((a, b) => a + b, 0);
    if (totalRows === 0 && Object.keys(page.sections).length === 0) {
      throw new Error(
        `snapshot saw NOTHING on /${name} — 0 rows and 0 sections.
` +
        `  That is a broken snapshot, not an empty page. Either the page failed to
` +
        `  render, or its markup uses classes this tool does not know about.
` +
        `  Check ROW_CLASSES in this file against the page's actual markup.`
      );
    }
    out.pages[name] = page;
  }
  return out;
}

// ------------------------------------------------------------------- diff
function walk(a, b, trail, diffs) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== "object" || tb !== "object" || ta !== tb) {
    diffs.push({ at: trail, sqlite: a, postgres: b });
    return;
  }
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    walk(a?.[k], b?.[k], trail ? `${trail}.${k}` : k, diffs);
  }
}

if (process.argv[2] === "--diff") {
  const A = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const B = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
  const diffs = [];
  walk(A, B, "", diffs);
  if (!diffs.length) {
    console.log("IDENTICAL — every page, section, row, number and empty state matches");
    process.exit(0);
  }
  console.log(`${diffs.length} DIFFERENCE${diffs.length === 1 ? "" : "S"} — each is a failure until explained\n`);
  for (const d of diffs) {
    console.log(`  ${d.at}`);
    console.log(`      sqlite  : ${JSON.stringify(d.sqlite)}`);
    console.log(`      postgres: ${JSON.stringify(d.postgres)}`);
  }
  process.exit(1);
}

const base = process.argv[2];
const dest = process.argv[3];

// The app is behind a password now, so a snapshot without a session would
// capture seven copies of the login page and report them as identical — a diff
// that passes while measuring nothing. Sign in first, and refuse to continue if
// that fails rather than silently snapshotting the gate.
let authHeaders = {};
async function signIn(baseUrl) {
  const pw = process.env.JOBOPS_PASSWORD;
  if (!pw) {
    console.error("JOBOPS_PASSWORD is not set — cannot sign in to snapshot.");
    process.exit(3);
  }
  const r = await fetch(baseUrl + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: pw }),
    redirect: "manual",
  });
  if (!r.ok) {
    console.error(`sign-in failed: HTTP ${r.status}. Snapshot aborted.`);
    process.exit(4);
  }
  const raw = r.headers.getSetCookie?.() || [];
  const cookie = raw.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) {
    console.error("sign-in returned no cookie. Snapshot aborted.");
    process.exit(5);
  }
  authHeaders = { cookie };
}

if (!base || !dest) {
  console.error("usage: node lib/snapshot.mjs <base-url> <out.json>   |   --diff <a> <b>");
  process.exit(2);
}
await signIn(base);
const data = await snap(base);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(data, null, 1));
let secs = 0, rows = 0;
for (const [name, p] of Object.entries(data.pages)) {
  secs += Object.keys(p.sections).length;
  const n = Object.values(p.pageRows).reduce((a, b) => a + b, 0);
  rows += n;
  console.log(`  ${name.padEnd(14)} ${String(n).padStart(4)} rows  ${Object.keys(p.sections).length} sections`);
}
console.log(`
${Object.keys(data.pages).length} pages, ${secs} sections, ${rows} rows -> ${dest}`);
