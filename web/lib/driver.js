/**
 * The one place that knows which database is behind db.js.
 *
 *   DATABASE_URL set    -> Neon Postgres, via `pg`
 *   DATABASE_URL absent -> the local jobs.db, via node:sqlite
 *
 * db.js above this knows neither. It writes SQLite-flavoured SQL with `?`
 * placeholders exactly as it always has, and the shim rewrites them for
 * Postgres — which is the whole point: sixty hand-written queries survive the
 * migration byte-identical, so the diff is reviewable.
 *
 * Everything here is async, because every Postgres client is. node:sqlite is
 * synchronous and gets wrapped, which costs nothing and means there is ONE
 * shape for callers rather than two.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DatabaseSync } from "node:sqlite";
import { toPositional } from "./sqlshim.js";
import { readEnv, isPooled } from "./pgcheck.mjs";

const env = { ...readEnv(), ...process.env };

// JOBOPS_LOCAL_DB=1 forces SQLite even when DATABASE_URL is set.
//
// Needed because readEnv() reads .env from DISK, so unsetting the variable in
// the shell does NOT switch backends — which cost a confusing ten minutes when
// a run believed to be SQLite was in fact hitting Postgres. It is also the flag
// phase I uses to let the local dev server run offline on purpose.
/**
 * JOBOPS_DIRECT=1 — for ONE-SHOT CLI SCRIPTS ONLY, never the app.
 *
 * The app must use the pooled endpoint: each serverless invocation opens its
 * own connection, and the direct endpoint starts refusing them under load. The
 * assertion below enforces that and stays enforced.
 *
 * A script run once a day from GitHub Actions is the opposite situation. It
 * opens one connection, does a few hundred inserts, and exits — and CI carries
 * only DATABASE_URL_UNPOOLED, because that is what the Python CLI has always
 * used (see pgdb.py, which reaches for the direct string for exactly this
 * reason). Without this flag, backfill_units.mjs could not reach Neon at all.
 *
 * It cannot be set by accident from the app: nothing in web/ sets it, Vercel
 * does not define it, and the one place it appears is a single workflow step.
 * If it were ever set in the app's environment, the pooled assertion is what
 * would stop being run — so this is the one line to look at if connections
 * start being refused under load.
 */
const DIRECT_CLI = env.JOBOPS_DIRECT === "1" && !!env.DATABASE_URL_UNPOOLED;
const PG_URL = DIRECT_CLI ? env.DATABASE_URL_UNPOOLED : env.DATABASE_URL;

export const USING_PG = !!PG_URL && env.JOBOPS_LOCAL_DB !== "1";

/**
 * A schema name, or a refusal.
 *
 * This value is interpolated into a connection option, so it is the one place
 * a string from the environment reaches something SQL-shaped. Nothing here is
 * escaped -- it is whitelisted instead, and an unacceptable name throws rather
 * than being sanitised into something that still runs.
 */
export function schemaName(s) {
  const name = String(s || "");
  if (!/^[a-z_][a-z0-9_]{0,48}$/.test(name)) {
    throw new Error(
      `JOBOPS_PG_SCHEMA must be a plain lower-case identifier, got ${JSON.stringify(s)}`);
  }
  if (name === "public") {
    throw new Error(
      "JOBOPS_PG_SCHEMA must not be 'public' — the point of it is to keep "
      + "tests that write off the production tables");
  }
  return name;
}

/** The scratch schema in force, or null for the normal (production) path. */
export const PG_SCHEMA = env.JOBOPS_PG_SCHEMA
  ? schemaName(env.JOBOPS_PG_SCHEMA)
  : null;

// Phase I: Neon is the database. See sqlite() for why the fallback refuses.

let _pool = null;
let _sqlite = null;

function pool() {
  if (!_pool) {
    // The assertion is SKIPPED only for a deliberate one-shot CLI run, which is
    // the one case where a direct connection is correct rather than a mistake.
    // See DIRECT_CLI above; the app can never take this branch.
    if (!DIRECT_CLI && !isPooled(env.DATABASE_URL)) {
      throw new Error(
        "DATABASE_URL holds the DIRECT Neon string, but the app must use the POOLED one.\n" +
        "  Its host is missing \"-pooler\". Every request opens its own connection, and\n" +
        "  the direct endpoint will start refusing them.\n" +
        "  Fix: Neon console -> Connect -> \"Connection pooling\" ON -> copy -> set DATABASE_URL.\n" +
        "  (A one-shot CLI script may pass JOBOPS_DIRECT=1 to use the direct string.)"
      );
    }
    // max: 1 — each serverless invocation is its own process, so a pool of one
    // per process is what the pooled endpoint expects.
    //
    // connectionTimeoutMillis: SCALE-TO-ZERO MEANS THE FIRST CONNECTION AFTER
    // IDLE IS A COLD START. Neon suspends compute when nothing has talked to
    // it — which is what keeps the free tier free and must stay on — and waking
    // it takes a few seconds. An explicit 30s is well past that and well short
    // of a request hanging; without one the behaviour depends on whatever the
    // platform's socket default happens to be, which differs between this
    // laptop and a Vercel lambda.
    //
    // The symptom this is for: two Neon-touching tests failed inside the
    // pre-commit hook and passed standalone seconds later, which is what a cold
    // start looks like from the outside — intermittent, unreproducible, and
    // easy to blame on the code that happened to run first.
    _pool = new pg.Pool({
      connectionString: PG_URL,
      max: 1,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // A SCRATCH SCHEMA FOR TESTS THAT WRITE.
      //
      // test_runhistory.mjs spawns the real recordrun against the real driver
      // -- that is the whole value of it, and a rendered-output diff could not
      // replace it. But it was doing that against PRODUCTION: it wrote real
      // rows into pipeline_runs and overwrote the single pipeline_status row,
      // and the first version failed to put that one back, so the digest
      // reported a fake run at example.invalid as the most recent.
      //
      // Restoring by hand made it safe and left it fragile: correctness
      // depended on the cleanup being exhaustive, and the next table anyone
      // adds to recordrun would silently not be in it.
      //
      // With JOBOPS_PG_SCHEMA set, every statement on this connection resolves
      // against that schema and NOTHING ELSE. No `, public` fallback: a table
      // the test forgot to create must ERROR rather than quietly resolve to the
      // production one, which is the exact failure being designed out.
      ...(env.JOBOPS_PG_SCHEMA
        ? { options: `-c search_path=${schemaName(env.JOBOPS_PG_SCHEMA)}` }
        : {}),
    });
  }
  return _pool;
}

/**
 * The local SQLite file. RETIRED, and reachable only on purpose.
 *
 * Neon is the database. jobs.db was the database for the first weeks and is now
 * a copy that stops moving the moment anyone forgets to look at it — which is
 * exactly how you end up reading stale data and not knowing, the same failure as
 * the stray empty web/jobs.db that sat in the tree for a day.
 *
 * So falling back to it is no longer something that can happen by accident. If
 * DATABASE_URL is missing this REFUSES rather than quietly serving a file: an
 * app that renders yesterday's roles without saying so is worse than one that
 * will not start. JOBOPS_LOCAL_DB=1 is the deliberate opt-in, for working
 * offline on a plane.
 */
/**
 * Where jobs.db is, resolved from THIS FILE rather than from the cwd.
 *
 * This was `path.join(process.cwd(), "..", "jobs.db")`, which is only correct
 * when the cwd happens to be `web/`. Running node from the repo root instead
 * pointed it one level too high — at the parent of the repo — and node:sqlite
 * CREATES a file it cannot find, so it made an empty database on the Desktop
 * and then read zero rows out of it. No error, no warning: an empty result set
 * reads as a quiet day.
 *
 * WHY IT IS CHECKED RATHER THAN TRUSTED. This module is bundled by webpack for
 * the Next server, and a bundler is free to rewrite import.meta.url to point at
 * the emitted chunk — which would put the anchor inside `.next/server/` and be
 * WORSE than the cwd version, because it would look deliberate.
 *
 * Checked on this build: webpack DOES rewrite it, and rewrites it to the real
 * source path (`file:///.../web/lib/driver.js`), so the file anchor holds in the
 * bundle too — verified by grepping the emitted chunk, not by assuming. The
 * marker check is what makes that safe to rely on: if a future bundler, or a
 * standalone output trace, resolves it somewhere without companies.yaml beside
 * it, the fallbacks take over instead of silently addressing a chunk directory.
 *
 * So the anchor is checked against a file only the real repo root has, and there
 * are two more ways to find it before giving up:
 *
 *   1. up two from this file            web/lib -> web -> repo root
 *   2. up one from the cwd              the `next dev` / `next start` case
 *   3. the cwd itself                   a script run from the repo root
 *
 * If none of them holds companies.yaml it THROWS, rather than handing a path to
 * node:sqlite and letting it create the fourth stray. A wrong path that fails
 * loudly costs a minute; one that silently creates an empty database has now
 * cost this project three.
 */
const REPO_MARKER = "companies.yaml";

function sqlitePath() {
  const candidates = [];
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  } catch {
    // import.meta.url is not a file: URL under some bundlers. Skip it.
  }
  candidates.push(path.resolve(process.cwd(), ".."));
  candidates.push(path.resolve(process.cwd()));

  for (const root of candidates) {
    if (fs.existsSync(path.join(root, REPO_MARKER))) {
      return path.join(root, "jobs.db");
    }
  }
  throw new Error(
    "Cannot find the repo root, so I will not guess where jobs.db lives.\n" +
    `  Looked for ${REPO_MARKER} in:\n` +
    candidates.map((c) => `    ${c}\n`).join("") +
    "  node:sqlite CREATES a database at whatever path it is handed, so guessing\n" +
    "  here produces an empty file and a page full of nothing. Run from the repo\n" +
    "  root or from web/."
  );
}

function sqlite() {
  if (env.JOBOPS_LOCAL_DB !== "1") {
    throw new Error(
      "No DATABASE_URL, and the local SQLite file is retired.\n" +
      "  Neon is the database (phase I). jobs.db is a copy that stops moving the\n" +
      "  moment nobody looks at it, so falling back to it silently would serve\n" +
      "  stale roles as though they were today's.\n" +
      "  Set DATABASE_URL, or pass JOBOPS_LOCAL_DB=1 to use the local file on purpose."
    );
  }
  if (!_sqlite) {
    _sqlite = new DatabaseSync(sqlitePath());
    // The CLI may be mid-write; wait rather than throw.
    _sqlite.exec("PRAGMA busy_timeout = 5000");
  }
  return _sqlite;
}

// node:sqlite returns rows with a NULL PROTOTYPE, which React Server Components
// refuse to serialize. Convert at this boundary so nothing downstream knows.
const plain = (r) => (r == null ? r : { ...r });

/**
 * Postgres lowercases unquoted identifiers, so `AS display_name` comes back as
 * display_name either way — no mapping needed. But COUNT(*) returns a BIGINT,
 * which `pg` hands back as a STRING to avoid precision loss, and every caller
 * here treats counts as numbers. Coerce the ones that are plainly numeric.
 */
function coerce(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" && /^-?\d+$/.test(v) && v.length < 16 && NUMERIC.has(k)
      ? Number(v)
      : v;
  }
  return out;
}

// Columns that are counts or integers and must arrive as numbers, because the
// UI does arithmetic and comparisons on them.
const NUMERIC = new Set([
  "n", "d", "cols", "roles", "at40", "at60", "best", "reachable40", "reachable",
  "n2027", "n2027All", "bestAny", "score", "score_lo", "score_hi", "score_spread", "n_samples",
  "comp_min", "comp_max", "yoe", "tier", "candidate", "triage", "under90",
  "known", "experienced", "program", "start_year", "start_month", "class_year",
  "id", "run_idx", "touch_count", "len", "open", "candidates", "gated",
  "scored", "over60", "total",
]);

/** How long to wait for a connection. See the note on the Pool above. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Waited before the single cold-start retry, so the compute has actually woken. */
const COLD_START_WAIT_MS = 3_000;

/**
 * Has this process talked to the database yet?
 *
 * The retry below is for the FIRST query only. A connection that dies mid-page
 * is a different problem with a different answer, and retrying every query
 * would turn one slow failure into three.
 */
let _warm = false;

/**
 * Is this the transport failing, rather than the query being wrong?
 *
 * A syntax error will not be right the second time, and retrying it turns a
 * clear message into a slow one. Same predicate as pgdb.is_connection_error on
 * the Python side.
 */
export function isColdStartError(e) {
  const m = `${e?.code || ""} ${e?.message || ""}`.toLowerCase();
  return /timeout|econnreset|econnrefused|enotfound|etimedout|socket|terminated|connection/
    .test(m);
}

/**
 * One query, with a single retry if this process's FIRST one hits a cold start.
 *
 * Neon scales compute to zero when idle -- which is what keeps the free tier
 * free and stays on -- so the first connection after a quiet spell waits for a
 * wake that takes a few seconds. Two Neon-touching tests failed inside the
 * pre-commit hook and passed standalone seconds later, which is precisely what
 * that looks like from the outside.
 */
export async function RETRY_ON_COLD_START(work) {
  try {
    const r = await work();
    _warm = true;
    return r;
  } catch (e) {
    // ONE retry, transport only, and only before this process has ever
    // succeeded. Unbounded retries against a database that is genuinely down
    // is a cron step that never returns.
    if (_warm || !isColdStartError(e)) throw e;
    await new Promise((r) => setTimeout(r, COLD_START_WAIT_MS));
    const r = await work();
    _warm = true;
    return r;
  }
}

/** Reset for tests: `_warm` is per-process and the retry only fires when cold. */
export function _resetWarm() { _warm = false; }

async function query(text, params) {
  return RETRY_ON_COLD_START(() => pool().query(text, params));
}

export async function all(sql, params = []) {
  if (!USING_PG) return sqlite().prepare(sql).all(...params).map(plain);
  const { text } = toPositional(sql);
  const r = await query(text, params);
  return r.rows.map(coerce);
}

export async function one(sql, params = []) {
  if (!USING_PG) return plain(sqlite().prepare(sql).get(...params));
  const { text } = toPositional(sql);
  const r = await query(text, params);
  return r.rows.length ? coerce(r.rows[0]) : undefined;
}

export async function run(sql, params = []) {
  if (!USING_PG) return sqlite().prepare(sql).run(...params);
  const { text } = toPositional(sql);
  return query(text, params);
}
