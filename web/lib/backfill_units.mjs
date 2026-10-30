/**
 * Turn the two standing projects into parents with small children. Run once:
 *
 *   cd web && node lib/backfill_units.mjs            # do it
 *   cd web && node lib/backfill_units.mjs --dry-run  # say what it would do
 *
 * IDEMPOTENT, and it has to be: it runs against a live tracker, and the daily
 * workflow may well run it again. Every row it creates has a DERIVED id —
 * `unit:find_names:palantir` — so a second run finds them already there and
 * writes nothing. Nothing is deleted and no existing title is rewritten except
 * the two the brief names explicitly.
 *
 * WHY THIS IS A SCRIPT AND NOT SQL. It needs the Companies "Start here"
 * ranking and the live list of undated windows. Neither exists in the database
 * as such: the ranking is computed from scored roles and contact counts, and
 * the windows come out of companies.yaml. A migration cannot see either.
 *
 * The two conversions:
 *
 *   "Pull 15 alumni names from the directory" becomes a parent with one child
 *   per company for the top 8 in the ranking — 16 names against a target of
 *   15, and one company is a twenty-minute job where fifteen names is an
 *   afternoon nobody ever starts.
 *
 *   Every tracked window with no date becomes one child under a "Confirm the
 *   N dates nobody is watching" parent, ten minutes each. A task naming three
 *   firms when one is actionable is a task you re-read every morning to work
 *   out what is left of it, so the unit is one firm.
 *
 * NOTHING HERE NAMES A FIRM OR A PERSON. The original seeded two rows by hand
 * — a firm-specific date task and a wrong-cycle flag for one analyst
 * programme — and both were facts about one owner's search that a copy would
 * have carried into someone else's tracker. Firm-specific decisions are made
 * from the UI and stored, not seeded from code.
 */
import { all, one, run, USING_PG } from "./driver.js";
import { listCompanies } from "./db.js";
import { getDeadlines, applyChecks, undatedWindows } from "./deadlines.js";
import { windowChecks } from "./db.js";
import { contactsByCompany } from "./contacts.js";
import { NAMES_PER_COMPANY } from "./people.js";
import { USER_TZ } from "./constants.js";

const DRY = process.argv.includes("--dry-run");
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "+00:00");

/** How many companies get a child. 8 x 2 names = 16, against a target of 15. */
const COMPANIES_TO_SPLIT = 8;

const say = (s) => console.log(s);

/** Today, in the user's timezone — not the runner's, which is UTC. */
const todayLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: USER_TZ });

/**
 * A due date this script writes may not be in the past.
 *
 * Nothing here can know that the owner missed a deadline they were never shown. A
 * backfill inheriting an old due date produced "1D OVERDUE" in red on a task
 * created that morning — and an urgency scale that cries wolf once is one you
 * read past afterwards.
 */
function pastDue(due) {
  const today = todayLocal();
  if (!due) return null;
  return String(due) < today ? today : due;
}

/** "BCG" -> "BCG's", "ZS Associates" -> "ZS Associates'". */
const possessive = (name) =>
  /s$/i.test(name) ? `${name}'` : `${name}'s`;
let created = 0;
let updated = 0;
let already = 0;

async function upsertChild({ id, title, note, parent, kind, company, minutes, due }) {
  const existing = await one("SELECT id FROM items WHERE id = ?", [id]);
  if (existing) { already++; return false; }
  if (DRY) { say(`  would add   ${id}  ${title}`); created++; return true; }
  await run(
    `INSERT INTO items
       (id, title, note, due_at, created_at, source, minutes, steps,
        parent_id, unit_company, unit_kind, deadline_kind)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (id) DO NOTHING`,
    [id, title, note, due || null, stamp(), "unit", minutes, null,
     parent, company || null, kind, "self"]);
  say(`  added       ${id}  ${title}`);
  created++;
  return true;
}

/**
 * Set only what actually differs.
 *
 * It wrote unconditionally, so a second run reported "2 updated" for two
 * UPDATEs that changed nothing — the alumni parent's note and the confirm-dates
 * title, rewritten to the values they already held. Harmless in effect and
 * wrong in report: a re-run that claims to have changed something is a re-run
 * you cannot use to check whether anything changed. This one is a true no-op.
 *
 * Reads the row first, compares, and writes only the differing columns.
 */
async function setFields(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;

  const current = await one(
    `SELECT ${cols.join(", ")} FROM items WHERE id = ?`, [id]);
  const changed = {};
  for (const c of cols) {
    const now = current ? current[c] : undefined;
    const next = fields[c];
    // Loose on null vs undefined vs "", strict on everything else: the columns
    // are nullable text and the drivers disagree about which empty they return.
    const same = (now ?? null) === (next ?? null);
    if (!same) changed[c] = next;
  }
  if (!Object.keys(changed).length) { already++; return; }

  const keys = Object.keys(changed);
  if (DRY) { say(`  would set   ${id}  ${JSON.stringify(changed)}`); updated++; return; }
  await run(
    `UPDATE items SET ${keys.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
    [...keys.map((c) => changed[c]), id]);
  updated++;
}

say(`backfill_units -> ${USING_PG ? "Neon Postgres" : "local SQLite"}`
  + `${DRY ? "  (DRY RUN)" : ""}`);

const items = await all(
  `SELECT id, title, note, due_at, parent_id, unit_kind, unit_company,
          deadline_kind
   FROM items`);

/**
 * Windows already covered by a task, tracked IN MEMORY rather than re-queried.
 *
 * Seeded from the database and then added to as this run goes. Re-querying at
 * the point of use was wrong in exactly one case, and it was the case that
 * mattered: a dry run has not written the BCG rewrite yet, so the query could
 * not see it and reported that it would create a duplicate BCG child. A dry run
 * whose output differs from the real run is worse than no dry run at all.
 */
const covered = new Set(
  (await all("SELECT unit_company FROM items WHERE unit_kind = 'confirm_date'"))
    .map((r) => r.unit_company).filter(Boolean));

/* ------------------------------------------- 1. deadline provenance, first */
//
// Everything the tool created from a window is EXTERNAL; everything else is a
// date the owner set. The distinction is the whole point of the chip, and
// getting it backwards would make a self-imposed date look unmissable.
//
// Matched on source and on the title naming a tracked firm, not on a guess:
// a followup: item is auto-created from an application, and the composite
// apply task names the firms whose window it came from.
const windows = applyChecks(getDeadlines(), await windowChecks());
const openFirms = windows.filter((w) => w.status === "open").map((w) => w.firm);

for (const it of items) {
  if (it.deadline_kind) continue;                 // already classified
  const external = String(it.id).startsWith("followup:")
    || openFirms.some((f) => String(it.title || "").toLowerCase().includes(f.toLowerCase()));
  await setFields(it.id, { deadline_kind: external ? "external" : "self" });
}
say(`  classified  ${items.filter((i) => !i.deadline_kind).length} existing tasks as external/self`);

/* ------------------------------------------------ 2. the alumni-names parent */

const alumni = items.find((i) => /pull \d+ alumni names/i.test(i.title || ""));
if (!alumni) {
  say("  skipped     no alumni-names task found — nothing to split");
} else {
  const companies = await listCompanies({});
  const contacts = await contactsByCompany();
  // The Start here ranking: reachable roles weighted by class-year depth,
  // restricted to companies still under the target. Same expression
  // Companies.js uses — it is the ranking, and a second one here would drift
  // from what the owner sees.
  const ranked = companies
    .filter((c) => (c.reachable40 || 0) > 0
                && ((contacts.get(c.name)?.n) || 0) < NAMES_PER_COMPANY)
    .sort((a, b) => (b.reachable40 * (1 + (b.n2027 || 0))) - (a.reachable40 * (1 + (a.n2027 || 0)))
                 || String(a.name).localeCompare(String(b.name)))
    .slice(0, COMPANIES_TO_SPLIT);

  await setFields(alumni.id, {
    // Derived from the two constants that decide it, so the title cannot
    // disagree with the children again. It read "Pull 15 alumni names" above a
    // counter saying 0 OF 8: fifteen was the original target, eight is the
    // number of companies, and 8 x 2 is sixteen. Three numbers, no relationship
    // stated between any of them.
    title: `Pull ${ranked.length * NAMES_PER_COMPANY} alumni names `
         + `— ${NAMES_PER_COMPANY} at each of ${ranked.length} companies`,
    note: "Split into one company per day below. Two names each; one company is "
        + "about twenty minutes.",
    unit_kind: null,
  });

  for (const c of ranked) {
    await upsertChild({
      id: `unit:find_names:${c.name}`,
      title: `Find ${NAMES_PER_COMPANY} names at ${c.display_name}`,
      note: "Open the alumni search, add two people on the People page.",
      parent: alumni.id,
      kind: "find_names",
      company: c.name,
      minutes: 20,
      due: null,
    });
  }
  say(`  parent      "${alumni.title}" now has ${ranked.length} children`);
}

/* --------------------------------- 3. one child per window nobody is watching */

const undated = undatedWindows(windows);
if (undated.length) {
  const parentId = "unit:parent:confirm_dates";
  const existingParent = await one("SELECT id FROM items WHERE id = ?", [parentId]);
  // The COUNT is computed, never hard-coded: it was sixteen the day this was
  // written and every confirmed date makes it smaller.
  const title = `Confirm the ${undated.length} dates nobody is watching`;
  if (!existingParent) {
    if (!DRY) {
      await run(
        `INSERT INTO items (id, title, note, due_at, created_at, source, minutes,
                            steps, parent_id, unit_company, unit_kind, deadline_kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`,
        [parentId, title,
         "A missed window costs a cycle. One a day, ten minutes each.",
         null, stamp(), "unit", null, null, null, null, null, "self"]);
    }
    say(`  ${DRY ? "would add  " : "added      "} ${parentId}  ${title}`);
    created++;
  } else {
    await setFields(parentId, { title });
    already++;
  }

  for (const w of undated) {
    // The firm, slugged, so the id is stable across runs and readable in a row.
    const slug = String(w.firm).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    // ADOPTED, not skipped.
    //
    // A window the owner already had a task for used to be dropped from the
    // parent entirely, so the parent read "Confirm the 16 dates nobody is
    // watching" above a counter saying 0 OF 15 — the title counting WINDOWS
    // and the counter counting CHILDREN, off by exactly the one window that had
    // its own task. A hand-written note on that task is better than anything
    // generated here, so the answer is not to overwrite it or to duplicate it
    // — it is to make the existing task a child. Same job, one row, and the
    // two numbers now come from one list.
    if (covered.has(slug)) {
      const existing = items.find(
        (i) => i.unit_kind === "confirm_date" && i.unit_company === slug);
      if (existing && existing.parent_id !== parentId) {
        await setFields(existing.id, { parent_id: parentId });
        say(`  adopted     ${slug} — existing task is now a child of the parent`);
      } else {
        already++;
      }
      continue;
    }
    await upsertChild({
      id: `unit:confirm_date:${slug}`,
      title: `Confirm ${possessive(w.firm)} deadline`,
      note: `${w.program}. Open their careers page; a date read there is the only `
          + "way a window in this tool becomes verified.",
      parent: parentId,
      kind: "confirm_date",
      company: slug,
      minutes: Number(w.minutes) || 10,
      due: null,
    });
  }
  say(`  parent      "${title}" now has ${undated.length} children`);
}

say(`\n${created} created, ${updated} updated, ${already} already present`);
process.exit(0);
