/**
 * Apply flows that cannot be completed. Run: node test_blocked.mjs
 *
 * TWO HALVES, AND THE SECOND IS THE ONE THAT MATTERS.
 *
 * The first half tests lib/blocked.js in isolation: the fold, the wording, the
 * countdown. Easy, and it would go on passing forever with the predicate wired
 * into nothing at all.
 *
 * The second half drives visibleRoles() — the real one, out of lib/db.js — with
 * the flags and the blocked set INJECTED, so it runs with no database on a
 * machine where the table does not exist. That is deliberate: this project has
 * three checks that have never executed here because they need a database, and
 * a fourth would have meant the blocked exclusion shipped unproven. Deleting
 * `&& !isBlocked(r, b)` from db.js turns this file red.
 *
 * It reads no clock and opens no connection, so it belongs on the fast gate.
 */
import {
  REASONS, UNKNOWN_REASON_LABEL, reasonLabel, foldBlocked, isBlocked, blockFor,
  closesPhrase, blockedLine, orderBlocked, NO_BLOCKS,
} from "./lib/blocked.js";
import { visibleRoles, groupRoles, groupKeyOf } from "./lib/db.js";

let pass = 0;
const fails = [];
const is = (got, want, what) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? pass++
    : fails.push(`${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
const ok = (cond, what) => is(!!cond, true, what);

const row = (o) => ({
  id: "bk:1", scope: "role", key: "k", reason: null, note: null,
  label: null, url: null, on_: 1, at: "2026-09-11T00:00:00+00:00", ...o,
});

/* ------------------------------------------------------------------- fold */

{
  // LATEST WINS BY id, NOT BY `at`. Both rows carry the SAME timestamp, which
  // is the case that actually happens — two writes inside one second — and the
  // one that silently settles at random if the fold sorts on the clock. The
  // later id lifts the block, so a fold that read `at` would report this role
  // as still blocked roughly half the time.
  const at = "2026-09-11T09:00:27+00:00";
  const f = foldBlocked([
    row({ id: "bk:a", key: "j1", reason: "captcha", at }),
    row({ id: "bk:b", key: "j1", reason: "captcha", on_: 0, at }),
  ]);
  is(f.roles.size, 0, "the latest row by id wins, and a lift clears the block");

  const g = foldBlocked([
    row({ id: "bk:b", key: "j1", on_: 0, at }),
    row({ id: "bk:a", key: "j1", reason: "captcha", at }),
  ]);
  is(g.roles.size, 0, "…whatever order the rows arrive in");
}

{
  // And a re-block after a lift blocks again: the fold is a state machine over
  // the history, not a one-way door.
  const f = foldBlocked([
    row({ id: "bk:a", key: "j1", reason: "captcha" }),
    row({ id: "bk:b", key: "j1", on_: 0 }),
    row({ id: "bk:c", key: "j1", reason: "http_error" }),
  ]);
  is(f.roles.size, 1, "a re-block after a lift is blocked again");
  is(f.roles.get("j1").reason, "http_error", "and carries the newest reason");
}

{
  // Scope separates the namespaces. A window and a role could in principle
  // share a key string; folding them together would let one clear the other.
  const f = foldBlocked([
    row({ id: "bk:a", scope: "role", key: "x" }),
    row({ id: "bk:b", scope: "window", key: "x" }),
  ]);
  is([f.roles.size, f.windows.size], [1, 1], "roles and windows fold separately");
}

/* ----------------------------------------------------------- fail open */

{
  // AN UNRECOGNISED REASON IS KEPT. The row survives and renders as a plain
  // "Blocked". Dropping it would silently un-block an application that is
  // still broken, and send the owner back to the same form with nothing on screen
  // saying why his evening went.
  const f = foldBlocked([row({ key: "j1", reason: "some_future_reason" })]);
  is(f.roles.size, 1, "an unrecognised reason is KEPT, not dropped");
  is(reasonLabel("some_future_reason"), UNKNOWN_REASON_LABEL,
     "…and renders as a plain Blocked");
  is(reasonLabel(null), UNKNOWN_REASON_LABEL, "so does a missing reason");
  is(reasonLabel("captcha_hcaptcha"), REASONS.captcha_hcaptcha,
     "a known reason renders as its label");

  const f2 = foldBlocked([row({ key: "j1", reason: null })]);
  is(f2.roles.size, 1, "a NULL reason is kept too — nullable on purpose");
}

{
  // A CLOSED REQUISITION IS REPRESENTABLE. The Anduril row was left out of the
  // seed because a dead req in the digest is a line to read past every
  // morning; the TABLE still has to be able to hold one, because the apply bot
  // meets closed reqs on boards this tool does not track.
  ok(REASONS.closed, "`closed` is a reason the table can represent");
  const line = blockedLine(foldBlocked([
    row({ key: "j9", reason: "closed", label: "Anduril — X" })]).roles.get("j9"));
  ok(/posting closed/.test(line), "and it renders as a closed posting");
}

/* ------------------------------------------------- the row outlives the job */

{
  // LABEL AND URL COME OFF THE ROW, NEVER FROM A JOIN. Lever re-ids
  // requisitions constantly. A line that joined to `jobs` would VANISH the
  // moment the board re-posted the same job — which on screen reads as "it got
  // fixed" — so the snapshot has to render with no job row in sight, and this
  // test deliberately supplies none.
  const e = foldBlocked([row({
    key: "lever:palantir:gone-from-the-board",
    reason: "captcha_hcaptcha",
    note: "hCaptcha loops on Lever apply flow",
    label: "Palantir — Deployment Strategist (Chicago, IL)",
    url: "https://jobs.lever.co/palantir/gone",
  })]).roles.get("lever:palantir:gone-from-the-board");

  const line = blockedLine(e);
  ok(/Palantir — Deployment Strategist \(Chicago, IL\)/.test(line),
     "a vanished requisition still renders its snapshotted label");
  ok(/jobs\.lever\.co/.test(line), "…and its snapshotted url");
  ok(/hCaptcha loop/.test(line), "the line carries the reason");
  ok(/hCaptcha loops on Lever apply flow/.test(line), "and the note");
}

{
  // With nothing snapshotted at all, the key is the fallback. A line reading
  // "**undefined**" is how a section stops being read.
  const e = foldBlocked([row({ key: "some:key" })]).roles.get("some:key");
  ok(/some:key/.test(blockedLine(e)), "with no label, the key is the fallback");
  ok(!/undefined/.test(blockedLine(e)), "and nothing renders as undefined");
  is(blockedLine(null), null, "no entry is no line");
}

/* --------------------------------------------------------- the countdown */

{
  // THE WHOLE POINT OF A WINDOW ROW. Deloitte closes 2026-09-30 and the 406
  // had already eaten three days; without days-remaining on the line, a
  // blocked window can expire while parked in the section that exists to stop
  // exactly that.
  const e = foldBlocked([row({
    scope: "window",
    key: "window:Deloitte|Strategy & Operations / Consulting, undergraduate",
    reason: "http_error",
    note: "HTTP 406 since 2026-09-08",
    label: "Deloitte — Strategy & Operations / Consulting, undergraduate",
  })]).windows.get("window:Deloitte|Strategy & Operations / Consulting, undergraduate");

  const line = blockedLine(e, { closeIn: 19, closes: "2026-09-30" });
  ok(/closes in 19 days/.test(line), "a window line carries days-until-close");
  ok(/2026-09-30/.test(line), "…and the date itself, so the number is checkable");
  ok(/HTTP error/.test(line), "and still carries the reason");

  // A PAST DATE MUST NOT READ AS A FUTURE ONE. inDays() is right about the
  // arithmetic and wrong about the verb: "closes 3 days ago" is the sentence
  // that lets a missed window look like a live one.
  const past = blockedLine(e, { closeIn: -3, closes: "2026-09-30" });
  ok(/CLOSED 3 days ago/.test(past), "a window that has shut says CLOSED");
  ok(!/closes in/.test(past), "…and never 'closes in'");

  is(closesPhrase(1, "2026-09-12"), "closes tomorrow (2026-09-12)",
     "one day out reads as tomorrow");
  is(closesPhrase(0, "2026-09-11"), "closes today (2026-09-11)",
     "and the last day reads as today");

  // NO DATE IS ITS OWN STATE, said out loud. 16 of 25 tracked windows have no
  // close date, so a silent line here would be the common case looking exactly
  // like a countdown that failed to compute.
  const undated = blockedLine(e, { closeIn: null });
  ok(/no close date on file/.test(undated), "an undated window says so");
  is(closesPhrase(null), null, "and the phrase itself is null, not NaN");

  // A ROLE ROW GETS NO COUNTDOWN. There is no date to count, and inventing a
  // phrase for one would be a number that was invented.
  const r = foldBlocked([row({ key: "j1", reason: "captcha" })]).roles.get("j1");
  ok(!/close/.test(blockedLine(r, { closeIn: 19 })),
     "a role line carries no countdown even if one is passed");
}

/* ------------------------------------------------------------------ order */

{
  const blocked = foldBlocked([
    row({ id: "bk:1", key: "zz-role" }),
    row({ id: "bk:2", key: "aa-role" }),
    row({ id: "bk:3", scope: "window", key: "window:B|p" }),
    row({ id: "bk:4", scope: "window", key: "window:A|p" }),
    row({ id: "bk:5", scope: "window", key: "window:C|p" }),
  ]);
  const closeIn = { "window:A|p": 30, "window:B|p": 5, "window:C|p": null };
  const keys = orderBlocked(blocked, (k) => closeIn[k]).map((e) => e.key);
  is(keys, ["window:B|p", "window:A|p", "window:C|p", "aa-role", "zz-role"],
     "windows first, soonest first, undated last, then roles by key");
}

{
  // EVERY SORT ENDS IN SOMETHING UNIQUE. Third occurrence of this bug in the
  // project, so it is checked rather than assumed: two windows closing on the
  // same day must not swap places between runs.
  const blocked = foldBlocked([
    row({ id: "bk:1", scope: "window", key: "window:Zeta|p" }),
    row({ id: "bk:2", scope: "window", key: "window:Alpha|p" }),
  ]);
  const once = orderBlocked(blocked, () => 7).map((e) => e.key);
  const twice = orderBlocked(blocked, () => 7).map((e) => e.key);
  is(once, ["window:Alpha|p", "window:Zeta|p"], "a tie breaks on the key");
  is(once, twice, "and the order is stable across calls");
}

/* ============ THE PREDICATE, WIRED INTO THE LIST EVERY PAGE USES ==========
 *
 * visibleRoles() is the real function from lib/db.js. Both of its lookups are
 * injected, so nothing here connects to anything — which is the only reason
 * this can sit on the fast gate and therefore the only reason it will ever run.
 */

const NO_FLAGS = { roles: new Map(), companies: new Map() };
const posting = (key, title, location) => ({
  key, company: "palantir", display_name: "Palantir", title, location,
  groupKey: groupKeyOf({ company: "palantir", title, location }),
});

{
  // ONE REQUISITION OUT OF TWELVE. This is the case the whole design exists
  // for: Palantir lists Deployment Strategist in a dozen cities, they share
  // one group key, and the hCaptcha loops on Chicago alone.
  const chicago = posting("lever:palantir:chi", "Deployment Strategist", "Chicago, IL");
  const nyc = posting("lever:palantir:nyc", "Deployment Strategist", "New York, NY");
  is(chicago.groupKey, nyc.groupKey, "the two postings share one group key");

  const blocked = foldBlocked([row({ key: "lever:palantir:chi", reason: "captcha_hcaptcha" })]);
  const out = await visibleRoles([chicago, nyc], NO_FLAGS, blocked);
  is(out.map((r) => r.key), ["lever:palantir:nyc"],
     "the blocked requisition is removed and its sibling is NOT");

  // AND THE GROUP SURVIVES. groupRoles() runs downstream of the filter, so the
  // row the owner sees is still there — on the eleven cities that work.
  is(groupRoles(out).length, 1, "the role still renders as one row");
  is(groupRoles(out)[0].locations, ["New York, NY"],
     "…listing only the cities that can actually be applied to");
}

{
  // A GROUP DISAPPEARS ONLY WHEN EVERY POSTING UNDER IT IS BLOCKED. Nothing
  // counts anything to achieve this; it falls out of filtering per posting
  // before the grouping runs.
  const a = posting("lever:palantir:chi", "Deployment Strategist", "Chicago, IL");
  const b = posting("lever:palantir:nyc", "Deployment Strategist", "New York, NY");
  const blocked = foldBlocked([
    row({ id: "bk:1", key: "lever:palantir:chi" }),
    row({ id: "bk:2", key: "lever:palantir:nyc" }),
  ]);
  const out = await visibleRoles([a, b], NO_FLAGS, blocked);
  is(out.length, 0, "every posting blocked removes them all");
  is(groupRoles(out).length, 0, "…so the group vanishes");
}

{
  // THE NEGATIVE HALF. Without it, "the blocked one is gone" is satisfied by a
  // filter that drops everything, and this file would pass against a
  // visibleRoles that returned [] forever.
  const a = posting("lever:palantir:chi", "Deployment Strategist", "Chicago, IL");
  const b = posting("lever:palantir:nyc", "Deployment Strategist", "New York, NY");
  const out = await visibleRoles([a, b], NO_FLAGS, NO_BLOCKS);
  is(out.length, 2, "nothing blocked hides nothing");

  // A LIFTED BLOCK STOPS HIDING IT. The row is still in the table; the fold is
  // what decides, and this is the assertion that would fail if `unblock` wrote
  // a row the filter kept reading as a block.
  const lifted = foldBlocked([
    row({ id: "bk:1", key: "lever:palantir:chi" }),
    row({ id: "bk:2", key: "lever:palantir:chi", on_: 0 }),
  ]);
  is((await visibleRoles([a, b], NO_FLAGS, lifted)).length, 2,
     "a lifted block stops hiding the posting");
}

{
  // THE TWO EXCLUSIONS ARE INDEPENDENT and read different keys — one the group,
  // one the requisition. A wrong-cycle flag on the group must still hide every
  // city, which is the behaviour that existed before this change and the one
  // most likely to be broken by it.
  const a = posting("lever:palantir:chi", "Deployment Strategist", "Chicago, IL");
  const b = posting("lever:palantir:nyc", "Deployment Strategist", "New York, NY");
  const flags = { roles: new Map([[a.groupKey, "wrong year"]]), companies: new Map() };
  is((await visibleRoles([a, b], flags, NO_BLOCKS)).length, 0,
     "a group-level hide still hides every city");
}

{
  // isBlocked / blockFor on their own, including the shapes that arrive from a
  // failed read or a half-built row.
  const blocked = foldBlocked([row({ key: "j1", reason: "captcha", label: "L" })]);
  ok(isBlocked({ key: "j1" }, blocked), "isBlocked reads the requisition key");
  ok(!isBlocked({ key: "j2" }, blocked), "and only that one");
  ok(!isBlocked({ groupKey: "palantir|x" }, blocked),
     "a row with no key is never blocked — it is not keyed on the group");
  ok(!isBlocked(null, blocked), "a missing role is not blocked");
  ok(!isBlocked({ key: "j1" }), "and with no blocked set, nothing is");
  is(blockFor({ key: "j1" }, blocked).label, "L", "blockFor returns the entry");
  is(blockFor({ key: "j2" }, blocked), null, "…and null when there is none");
}

// ----------------------------------------------------------------------------
if (fails.length) {
  console.log(`\n${fails.length} FAILED of ${pass + fails.length}\n`);
  for (const f of fails) console.log(`  ${f}\n`);
  process.exit(1);
}
console.log(`${pass}/${pass} passed`);
