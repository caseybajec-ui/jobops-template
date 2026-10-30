/**
 * Apply a migration file to whichever database is behind driver.js.
 *
 *   node lib/applymigration.mjs ../migrations/002_people.sql
 *   node lib/applymigration.mjs ../migrations/002_people.sql --dry-run
 *
 * WHY NOT runsql.mjs. That one opens the DIRECT Neon connection itself and is
 * therefore Postgres-only, which was right for 001 — that migration is the
 * Postgres port of a schema Python already creates in SQLite. Everything from
 * 002 on is owned by the APP: no Python creates these tables, so they have to
 * exist in both backends, including the local SQLite file that JOBOPS_LOCAL_DB
 * selects. Going through driver.js means one file describes both.
 *
 * IDEMPOTENT, and it has to be, because it will be run again the next time a
 * database is reachable. `CREATE TABLE IF NOT EXISTS` covers most of it.
 *
 * ADDING A COLUMN is the one thing that is not portable: Postgres understands
 * `ADD COLUMN IF NOT EXISTS` and SQLite does not, and SQLite has no way to say
 * it at all. So an additive column is written as a directive:
 *
 *   -- +column contacts linkedin_url TEXT
 *
 * and the runner PROBES for it first, with `SELECT <col> FROM <table> LIMIT 1`.
 * That probe behaves identically on both backends and needs no catalog query,
 * no pragma, and no error-message matching — which would have meant parsing a
 * driver's prose to decide whether a failure was expected.
 *
 * Everything else fails loudly. A migration that swallows errors is a migration
 * that reports success on a database it did not change.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { DatabaseSync } from "node:sqlite";
import { readEnv, assertEndpoint } from "./pgcheck.mjs";

/**
 * THE DIRECT CONNECTION, not driver.js.
 *
 * This went through driver.js first, which was wrong in a way local testing
 * could never show: driver.js insists on the POOLED endpoint, and PgBouncer in
 * transaction mode cannot run DDL at all. Every run here passed against the
 * local SQLite file and the first one against Neon would have refused — either
 * at driver.js's own "that is the DIRECT string" guard, or at PgBouncer. Same
 * reason runsql.mjs opens its own connection: a migration is DDL, and DDL has
 * one endpoint.
 *
 * The SQLite half stays, because everything from 002 on is owned by the app and
 * has to exist in the local file too — fetch_jobs.py owns that schema and does
 * not know about any of these tables.
 */
const env = { ...readEnv(), ...process.env };

/**
 * SQLite is an EXPLICIT choice, never a fallback.
 *
 * This read `JOBOPS_LOCAL_DB === "1" || !DATABASE_URL_UNPOOLED`, so a missing
 * secret silently meant "migrate the local file instead" — and on a CI runner
 * that is a throwaway SQLite file created on the spot, migrated perfectly, and
 * thrown away with the container. A completely green migration step that
 * touched the real database not at all.
 *
 * driver.js already refuses rather than falling back, for exactly this reason,
 * and this diverged from it. The workflow's "Check the secrets arrived" step
 * would catch it first today, but that is a guard in the CALLER; CLAUDE.md is
 * explicit that the guard belongs in the code path that acts.
 */
const LOCAL = env.JOBOPS_LOCAL_DB === "1";
if (!LOCAL && !env.DATABASE_URL_UNPOOLED) {
  console.error(
    "\nDATABASE_URL_UNPOOLED is not set, and this refuses to guess.\n"
    + "  It holds the DIRECT Neon connection string — the one whose host does NOT\n"
    + "  contain \"-pooler\". Migrations are DDL and PgBouncer cannot run DDL.\n"
    + "  In GitHub Actions it comes from the repository secret of the same name.\n"
    + "  To migrate the local SQLite file on purpose, pass JOBOPS_LOCAL_DB=1.\n",
  );
  process.exit(1);
}

let sqlite = null;
let client = null;

async function connect() {
  if (LOCAL) {
    sqlite = new DatabaseSync(path.join(process.cwd(), "..", "jobs.db"));
    sqlite.exec("PRAGMA busy_timeout = 5000");
    return;
  }
  assertEndpoint("DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED, "direct");
  client = new pg.Client({ connectionString: env.DATABASE_URL_UNPOOLED });
  await client.connect();
}

async function run(sql) {
  if (LOCAL) return sqlite.exec(sql);
  return client.query(sql);
}

async function all(sql) {
  if (LOCAL) return sqlite.prepare(sql).all().map((r) => ({ ...r }));
  return (await client.query(sql)).rows;
}

const USING_PG = !LOCAL;

const file = process.argv[2];
const DRY = process.argv.includes("--dry-run");
if (!file) {
  console.error("usage: node lib/applymigration.mjs <path-to.sql> [--dry-run]");
  process.exit(2);
}

const raw = fs.readFileSync(file, "utf8");

/* ------------------------------------------------------------- directives */

// Read the +column directives BEFORE comments are stripped, since they live in
// one. `\r?\n` for the same reason every other parser in this repo does it: one
// editor saving a file with Windows line endings once made every regex in
// deadlines.js match nothing, silently.
const columns = [];
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^--\s*\+column\s+(\w+)\s+(\w+)\s+(.+?)\s*$/);
  if (m) columns.push({ table: m[1], column: m[2], type: m[3] });
}

// The identifiers are interpolated into SQL below, so they are checked here
// rather than trusted. They come from a file in this repo, not from a user, and
// that is exactly the kind of assumption worth not relying on.
for (const c of columns) {
  if (!/^[a-z_][a-z0-9_]*$/.test(c.table) || !/^[a-z_][a-z0-9_]*$/.test(c.column)) {
    throw new Error(`+column directive has an identifier that is not a plain name: ${JSON.stringify(c)}`);
  }
  if (!/^[A-Za-z ()0-9]+$/.test(c.type)) {
    throw new Error(`+column ${c.table}.${c.column} has an unexpected type: ${c.type}`);
  }
}

/* ------------------------------------------------------------- statements */

// Comments are stripped to end of line — TRAILING ones too, not just whole
// lines. The statements are split on ";", so a semicolon inside a trailing
// comment would cut a CREATE TABLE in half and the halves would each fail as
// their own statement. There are no string literals in this DDL, so there is
// nothing a bare "--" could be part of.
const statements = raw
  .split(/\r?\n/)
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

/* ------------------------------------------------------------------- apply */

/** Does this column exist? One probe, identical on SQLite and Postgres. */
async function hasColumn(table, column) {
  try {
    await all(`SELECT ${column} FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

await connect();

console.log(`${path.basename(file)} -> ${USING_PG ? "Neon Postgres (direct)" : "local SQLite"}`
  + `${DRY ? "  (DRY RUN, nothing is written)" : ""}`);

let ran = 0;
let skipped = 0;

/**
 * ORDER: create tables, then add columns, then everything else.
 *
 * It was statements-then-columns, and 006 broke on it immediately: that file
 * adds `parent_id` to `items` and then indexes it, so the CREATE INDEX ran
 * against a column that did not exist yet and the whole migration died halfway.
 *
 * All three groups are needed and none of the three orders is arbitrary — a
 * `+column` may target a table this file creates, and an index may reference a
 * column this file adds. Tables first, columns second, indexes last is the only
 * sequence that satisfies both.
 */
const creates = statements.filter((s) => /^CREATE\s+TABLE/i.test(s));
const rest = statements.filter((s) => !/^CREATE\s+TABLE/i.test(s));

for (const sql of creates) {
  const label = sql.replace(/\s+/g, " ").slice(0, 72);
  if (DRY) { console.log(`  would run  ${label}`); ran++; continue; }
  await run(sql);
  console.log(`  ran        ${label}`);
  ran++;
}

for (const c of columns) {
  if (await hasColumn(c.table, c.column)) {
    console.log(`  already    ${c.table}.${c.column}`);
    skipped++;
    continue;
  }
  const sql = `ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`;
  if (DRY) { console.log(`  would add  ${c.table}.${c.column} ${c.type}`); ran++; continue; }
  await run(sql);
  console.log(`  added      ${c.table}.${c.column} ${c.type}`);
  ran++;
}

// Indexes and anything else, now that every table and column they name exists.
for (const sql of rest) {
  const label = sql.replace(/\s+/g, " ").slice(0, 72);
  if (DRY) { console.log(`  would run  ${label}`); ran++; continue; }
  await run(sql);
  console.log(`  ran        ${label}`);
  ran++;
}

// Close before reporting. A pg client left open keeps the event loop alive and
// the process hangs after printing a perfectly successful summary — which in a
// CI step reads as a migration that never finished.
if (client) await client.end();
if (sqlite) sqlite.close();

// A positive assertion. A migration file that parsed to nothing would otherwise
// print a tidy summary and report success having touched no database at all —
// the same shape as the snapshot tool that captured seven copies of the login
// page and diffed them as identical.
if (ran + skipped === 0) {
  console.error(`\n${file} produced no statements and no columns. Nothing was applied.\n`);
  process.exit(1);
}

console.log(`${ran} applied, ${skipped} already present`);
process.exit(0);
