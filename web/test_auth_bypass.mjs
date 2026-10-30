/**
 * Fires known auth-bypass shapes at a running server. Every one must be refused.
 *
 *   JOBOPS_PASSWORD=... node test_auth_bypass.mjs http://localhost:3022
 *   JOBOPS_PASSWORD=... node test_auth_bypass.mjs https://jobops-xxxx.vercel.app
 *
 * WHY THIS EXISTS, and why it is not covered by "the login page works":
 *
 * Testing that auth WORKS is not testing that auth CANNOT BE BYPASSED. The
 * password gate was verified end to end — signed out redirects, wrong password
 * refused, right password admits — and it was still bypassable, because
 * Next.js 15.5.4 carried four separate middleware-bypass advisories:
 * segment-prefetch routes, dynamic route parameter injection, and two
 * incomplete-fix follow-ups. Every one of those is a request that never reaches
 * middleware.js at all, so no amount of testing middleware.js finds them.
 *
 * Vercel blocked that deploy over the Next.js CVE list, but the advisory it
 * named was not the one that mattered. The dangerous one was further down.
 *
 * RUN THIS AFTER ANY CHANGE TO middleware.js, TO THE ALLOW-LIST, OR TO NEXT.
 * A bypass is silent: the page renders, nothing errors, and the only way to
 * know is to have asked.
 *
 * Exit 0 = every attempt refused. Exit 1 = something got through.
 */

const base = (process.argv[2] || "").replace(/\/$/, "");
if (!base) {
  console.error("usage: node test_auth_bypass.mjs <base-url>");
  process.exit(2);
}

// A refusal is any of: redirect to /login, 401, 403, 404. Anything that returns
// real page content signed-out is a failure.
const REFUSED = new Set([301, 302, 303, 307, 308, 401, 403, 404]);

// Paths that are SUPPOSED to be open. If one of these starts refusing, the gate
// has locked the owner out of his own sign-in page, which is its own kind of broken.
const OPEN = [
  ["/login", "the sign-in page itself"],
  ["/api/login", "the sign-in endpoint"],
];

const ATTEMPTS = [
  // Plain, as a control: if this does not redirect, nothing below means anything.
  ["/", {}, "unauthenticated root"],
  ["/inbox", {}, "unauthenticated inbox"],
  ["/gate", {}, "unauthenticated gate"],
  ["/about", {}, "unauthenticated about"],
  ["/companies", {}, "unauthenticated companies"],
  ["/forecast", {}, "unauthenticated forecast"],

  // React Server Component payload routes. The segment-prefetch advisories:
  // a prefetch of a route segment could skip middleware entirely.
  ["/?_rsc=1", {}, "_rsc query on root"],
  ["/inbox?_rsc=abc", {}, "_rsc query on inbox"],
  ["/", { RSC: "1" }, "RSC header"],
  ["/inbox", { "Next-Router-Prefetch": "1" }, "Next-Router-Prefetch header"],
  ["/inbox", { RSC: "1", "Next-Router-Prefetch": "1" }, "RSC + prefetch"],
  ["/index.prefetch.rsc", {}, "prefetch.rsc path"],
  ["/inbox.rsc", {}, ".rsc suffix path"],

  // CVE-2025-29927: a forged internal header convinced Next the request had
  // already been through middleware, so it ran none.
  ["/", { "x-middleware-subrequest": "middleware" }, "x-middleware-subrequest spoof"],
  ["/", { "x-middleware-subrequest": "src/middleware" }, "subrequest spoof, src path"],
  ["/", { "x-middleware-subrequest": "middleware:middleware:middleware" },
    "subrequest spoof, repeated"],

  // Dynamic route parameter injection, and path shapes that normalise oddly.
  ["//", {}, "double slash"],
  ["/./", {}, "dot segment"],
  ["/%2e%2e/", {}, "encoded traversal"],
  ["/inbox/../", {}, "traversal to root"],
  ["/INBOX", {}, "case variation"],
  ["/inbox/", {}, "trailing slash"],
  ["/inbox%20", {}, "trailing encoded space"],

  // Internal and devtools endpoints that sometimes sit outside the matcher.
  ["/__nextjs_original-stack-frame", {}, "devtools stack frame"],
  ["/__nextjs_launch-editor", {}, "devtools launch editor"],
  ["/_next/static/../../app/page.js", {}, "static traversal"],

  // The API carries the same data the pages do. An open API is an open database.
  ["/api/items", {}, "items API"],
  ["/api/actions", {}, "actions API"],
  ["/api/items", { RSC: "1" }, "items API with RSC header"],
];

let failed = 0;
let passed = 0;

// Markers that appear ONLY on a signed-in page. Judging on these rather than on
// status codes is the point: the question is not "did it redirect" but "did app
// content come back without a session".
const APP_ONLY = ["cost-meter", "What the rules filtered out", ">Inbox<"];

async function probe(path, headers, label) {
  // FOLLOW the chain. Judging the first hop was wrong and produced two false
  // alarms: Next answers `//` and `/inbox/` with a 308 to the canonical path,
  // and the gate applies on the NEXT hop. Both end at /login. A normalisation
  // redirect is not a bypass, and a test that cries wolf gets ignored on the
  // day it is right.
  let res, body = "";
  try {
    res = await fetch(base + path, { headers, redirect: "follow" });
    body = await res.text();
  } catch (e) {
    console.log(`  FAIL ${label.padEnd(34)} request threw: ${e.message}`);
    failed++;
    return;
  }
  const url = res.url || "";
  const leaked = APP_ONLY.filter((m) => body.includes(m));
  const refused = REFUSED.has(res.status) || url.includes("/login");
  if (refused && !leaked.length) {
    passed++;
    console.log(`  ok   ${label.padEnd(34)} ${res.status} ${url.includes("/login") ? "-> login" : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${label.padEnd(34)} ${res.status} ${url}`
      + (leaked.length ? `   leaked: ${leaked.join(", ")}` : "")
      + "   <-- CONTENT SERVED WITHOUT A SESSION");
  }
}

// A Server Action reached without a session would be a write path with no gate.
async function probeServerAction() {
  const res = await fetch(base + "/", {
    method: "POST",
    headers: {
      "Next-Action": "606b4215bd900e1db34cd9ef3e9bf28639e2796066",
      "content-type": "application/json",
    },
    body: JSON.stringify(["fake:key", "applied"]),
    redirect: "manual",
  }).catch((e) => ({ status: 0, headers: new Headers(), err: e.message }));
  const ok = REFUSED.has(res.status);
  if (ok) {
    passed++;
    console.log(`  ok   ${"Server Action without session".padEnd(34)} ${res.status}`);
  } else {
    failed++;
    console.log(`  FAIL ${"Server Action without session".padEnd(34)} ${res.status}`
      + "   <-- WRITE PATH REACHABLE SIGNED OUT");
  }
}

console.log(`auth bypass probes against ${base}\n`);
for (const [p, h, label] of ATTEMPTS) await probe(p, h, label);
await probeServerAction();

console.log("\nand the paths that must STAY open:");
for (const [p, label] of OPEN) {
  const res = await fetch(base + p, {
    method: p === "/api/login" ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: p === "/api/login" ? JSON.stringify({ password: "" }) : undefined,
    redirect: "manual",
  }).catch(() => ({ status: 0 }));
  // /api/login with a wrong password answers 401; that is open-and-working.
  const reachable = res.status !== 0 && !(res.status >= 300 && res.status < 400);
  if (reachable) {
    passed++;
    console.log(`  ok   ${label.padEnd(34)} ${res.status}`);
  } else {
    failed++;
    console.log(`  FAIL ${label.padEnd(34)} ${res.status}   <-- LOCKED OUT`);
  }
}

console.log();
if (failed) {
  console.log(`${failed} probe(s) got through. The gate is NOT closed.`);
  process.exit(1);
}
console.log(`all ${passed} probes refused as expected`);
