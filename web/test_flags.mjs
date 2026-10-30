/**
 * The wrong-cycle flag reaches EVERY list. Run: node test_flags.mjs
 *
 * test_actions.mjs proves the fold and the predicate in isolation, which is the
 * easy half. This proves the part that actually breaks: that the predicate is
 * wired into every surface a role can appear on. The brief's requirement was
 * "one helper, used everywhere; no per-view filtering", and the failure it
 * guards against is not a wrong answer — it is a right answer applied on three
 * pages out of four, so a role the owner hid is still sitting on the fourth. The
 * first time that happens he learns the button does not work, and after that he
 * stops pressing any of them.
 *
 * A NEW LIST IS A NEW HOLE. When a page starts showing roles, add it to
 * SURFACES below or this test will keep passing while the new page leaks.
 *
 * It asserts its own preconditions. The role has to be PRESENT before the flag
 * goes on, or "it is absent afterwards" measures nothing — the same self-check
 * every verification tool in this repo carries, for the same reason: a tool
 * pointed at nothing reports success.
 *
 * Local SQLite only unless told otherwise. It writes real rows and removes them
 * in a `finally`; a half-finished cleanup against Neon would leave a real
 * company hidden from the real tracker.
 */
import {
  listJobs, curatedJobs, listCompanies, forecast2027, strongOnBoth,
  hiddenRoles, setRoleFlag,
  groupKeyOf,
} from "./lib/db.js";
import { all, one, run, USING_PG } from "./lib/driver.js";

if (USING_PG && process.env.JOBOPS_FLAG_TEST_PROD !== "1") {
  console.error(`
test_flags: refusing to run against Postgres.

It hides a real company from every list and then un-hides it. If the cleanup
failed halfway, a company would sit invisible in the real tracker with nothing
on screen to say why.

  cd web && JOBOPS_LOCAL_DB=1 node test_flags.mjs      # what you want
  JOBOPS_FLAG_TEST_PROD=1                              # deliberate override
`);
  process.exit(1);
}

let pass = 0;
const fails = [];
const ok = (cond, what) => (cond ? (pass++, console.log(`  ok    ${what}`))
                                 : (fails.push(what), console.log(`  FAIL  ${what}`)));

/**
 * Every surface a role can reach, and how to ask it for company slugs.
 *
 * `wide` means the list is capped at a limit far below the corpus, so a role
 * vanishing from it proves nothing on its own — those are still listed, because
 * the company-scope half of the test does hold for them.
 */
const SURFACES = [
  ["Inbox", () => listJobs({ limit: 2000, cap: 0, minScore: 0 })],
  ["Daily (curated)", () => curatedJobs({ limit: 500, cap: 0, minScore: 0 })],
  ["Daily (strong on both)", () => strongOnBoth({ limit: 200, minScore: 0, minPay: 0 })],
];

/**
 * Every row this run writes, BY ID.
 *
 * Not by timestamp. The first version cleaned up with `at >= runStart`, and the
 * two formats do not sort against each other: stamp() writes
 * "2026-08-31T09:00:27+00:00" and toISOString() produces
 * "2026-08-31T09:00:27.000Z", and as strings "+" sorts BEFORE ".". So every row
 * written inside the run's first second survived — and the self-check used the
 * same comparison, so it agreed that nothing was left. A flag against a real
 * company sat in the real database under a green "cleaned up 6 flag row(s)".
 *
 * A check that shares the delete's mistake is not a check. An id has no format
 * to get wrong.
 */
const written = [];
const flag = async (...a) => {
  const r = await setRoleFlag(...a);
  written.push(r.id);
  return r;
};

try {
  // ---------------------------------------------------------------- pick a role
  //
  // A REAL one, from whatever is in the database, rather than a fixture: the
  // thing under test is the wiring between the flag table and five queries, and
  // a fixture would let all five agree while none of them ran.
  const candidates = await listJobs({ limit: 2000, cap: 0, minScore: 0 });
  if (candidates.length < 20) {
    console.error("test_flags: fewer than 20 scored roles in this database; "
                  + "nothing to measure. Fetch and score first.");
    process.exit(1);
  }
  // One that appears on the widest set of surfaces, so the test exercises the
  // most wiring. Ties broken on the group key so two runs pick the same role.
  const present = new Map();
  for (const [name, get] of SURFACES) {
    for (const r of await get()) {
      present.set(r.groupKey, (present.get(r.groupKey) || 0) + 1);
    }
  }
  const role = candidates
    .filter((r) => present.get(r.groupKey))
    .sort((a, b) => (present.get(b.groupKey) - present.get(a.groupKey))
                    || a.groupKey.localeCompare(b.groupKey))[0];
  ok(!!role, "found a real role that appears on at least one surface");
  if (!role) throw new Error("no usable role");
  console.log(`\n  using ${role.groupKey}  (on ${present.get(role.groupKey)} surface(s))\n`);

  const on = async (get) => (await get()).some((r) => r.groupKey === role.groupKey);
  const seenOn = [];
  for (const [name, get] of SURFACES) {
    if (await on(get)) { seenOn.push([name, get]); }
  }
  // THE PRECONDITION. Without it, "absent after the flag" is satisfied by a
  // query that returns nothing at all, which is exactly how a verification tool
  // ends up measuring nothing and printing green.
  ok(seenOn.length > 0, `it is VISIBLE on ${seenOn.length} surface(s) before the flag`);

  const before = (await listCompanies()).find((c) => c.name === role.company);
  ok(!!before, "and its company is on the Companies page before the flag");

  // ------------------------------------------------------------- role scope
  await flag("role", role.groupKey, true, "test_flags.mjs");

  for (const [name, get] of seenOn) {
    ok(!(await on(get)), `${name}: the flagged role is gone`);
  }

  const after = (await listCompanies()).find((c) => c.name === role.company);
  // The counts have to move WITH the row, or the company reads "1 role here fit
  // you" beside a list containing none — two numbers, two populations, which is
  // the defect this codebase has now found four times.
  //
  // NOT "by one". The flag is keyed by GROUP key, and Anduril posts "Product
  // Security Engineer, Programs" in four cities, so hiding the role hides four
  // rows out of a count of postings. Asserting one would have been asserting
  // that no role in the corpus is ever posted twice — which is false of the
  // very role this test picks, because picking the most-visible role picks a
  // multi-city one.
  const postings = (await all(
    `SELECT j.company, j.title, j.location
     FROM jobs j JOIN scores s ON s.key = j.key
     WHERE j.closed_at IS NULL AND s.score IS NOT NULL AND j.company = ?`,
    [role.company]
  )).filter((r) => groupKeyOf(r) === role.groupKey).length;
  ok(postings >= 1, `the group covers ${postings} posting(s)`);
  ok(after && after.roles === before.roles - postings,
     `Companies: the role count fell by exactly those ${postings}`
     + ` (${before.roles} to ${after?.roles})`);
  if (before.bestKey === role.key || before.bestTitle === role.title) {
    ok(after.bestTitle !== before.bestTitle,
       "Companies: the named best role moved off the flagged one");
    ok(after.best !== before.best || after.bestTitle === null,
       "Companies: and the band moved with the title rather than staying behind");
  }

  const hidden = await hiddenRoles();
  const mine = hidden.find((h) => h.key === role.groupKey);
  ok(!!mine, "it appears in the undo list at the foot of Inbox");
  ok(mine?.scope === "role", "labelled with the scope it was hidden at");
  ok(mine?.note === "test_flags.mjs", "carrying the reason that was typed");

  // ------------------------------------------------------------ un-hiding
  await flag("role", role.groupKey, false);
  for (const [name, get] of seenOn) {
    ok(await on(get), `${name}: un-hiding brings it back`);
  }
  ok(!(await hiddenRoles()).some((h) => h.key === role.groupKey),
     "and it leaves the undo list");

  // ---------------------------------------------------------- company scope
  await flag("company", role.company, true, "test_flags.mjs");

  for (const [name, get] of seenOn) {
    ok(!(await on(get)), `${name}: a company flag hides its roles too`);
  }
  ok(!(await listCompanies()).some((c) => c.name === role.company),
     "Companies: the company itself leaves the page");
  ok(!(await forecast2027()).some((f) => f.company === role.company),
     "Forecast: and leaves the class-year posting forecast");
  // ONE ROW PER FLAG, not one per role. A company flag on Anduril hides more
  // than a hundred postings; listing them all would bury the role-level
  // decisions and then get truncated by the cap, so the entry you actually
  // wanted to undo might not be in the list at all.
  {
    const h = await hiddenRoles();
    const row = h.find((x) => x.scope === "company" && x.key === role.company);
    ok(!!row, "the undo list carries ONE row for the company flag");
    ok(h.filter((x) => x.company === role.company).length === 1,
       `and only one (${h.filter((x) => x.company === role.company).length} found)`);
    ok(/\d+ roles?$/.test(row?.title || ""),
       `it says how many roles go with it, not a single title (${row?.title})`);
  }

  await flag("company", role.company, false);
  ok((await listCompanies()).some((c) => c.name === role.company),
     "and un-hiding the company brings it back");

  // ------------------------------------------------- prove it can go red
  //
  // A check that has only ever passed is indistinguishable from one that cannot
  // fail. Flag a role and assert it is STILL there: that must be false.
  await flag("role", role.groupKey, true, "test_flags.mjs");
  const stillThere = await on(seenOn[0][1]);
  ok(stillThere === false,
     "the negative control: a flagged role is genuinely absent, not merely unasserted");
  await flag("role", role.groupKey, false);
} catch (e) {
  fails.push(`threw: ${e.message}`);
  console.log(`\n  THREW  ${e.stack}`);
} finally {
  // Every row this run wrote, gone — including the un-hide rows, which are as
  // much test debris as the hides. The table is insert-only in the app; a test
  // is not the app.
  try {
    for (const id of written) await run("DELETE FROM role_flags WHERE id = ?", [id]);
    // Re-read each id individually. The old version asked the same broken
    // question twice and got the same wrong answer twice.
    const left = [];
    for (const id of written) {
      if (await one("SELECT id FROM role_flags WHERE id = ?", [id])) left.push(id);
    }
    if (left.length) {
      console.log(`\n  CLEANUP FAILED: ${left.length} flag row(s) still in the database.`);
      fails.push("cleanup left flag rows behind");
    } else {
      console.log(`\n  cleaned up ${written.length} flag row(s)`);
    }
  } catch (e) {
    console.log(`\n  CLEANUP FAILED: ${e.message}`);
    fails.push("cleanup threw");
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
