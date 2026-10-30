/**
 * Copy jobs.db into Neon Postgres, trimming descriptions on the way.
 *
 *   node lib/migrate.mjs            # do it
 *   node lib/migrate.mjs --dry-run  # report only, touch nothing
 *
 * jobs.db is READ ONLY here. It is opened read-only and never written, so it
 * remains the backup until phase G verifies the deployed site.
 *
 * WHY THERE IS NO IN-PLACE UPDATE. The brief asked for copy-verify-then-replace
 * rather than an in-place trim, and a SQLite-to-Postgres copy satisfies that by
 * construction: the full text stays in jobs.db, the trimmed text is written
 * somewhere else entirely, and nothing is overwritten. The whole Postgres side
 * runs in ONE transaction — TRUNCATE and INSERT together — so a failure halfway
 * leaves Postgres exactly as it was rather than half-populated.
 *
 * WHAT KEEPS ITS FULL DESCRIPTION
 *   - anything reachable: right level, right graduating class, no active
 *     clearance requirement — the same predicate the app filters on
 *   - anything ever saved, including roles later un-saved, because un-saving is
 *     not a decision to lose the text
 * Everything else keeps the first 2,000 characters. The scorer never sees more
 * than ~9,000 and only reads gated survivors; the app shows none of it.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import pg from "pg";
import { readEnv, assertEndpoint } from "./pgcheck.mjs";
import { groupKeyOf } from "./display.js";

const DRY = process.argv.includes("--dry-run");
const KEEP_CHARS = 2000;
const BATCH = 400;

const SQLITE = path.join(process.cwd(), "..", "jobs.db");
const sq = new DatabaseSync(SQLITE, { readOnly: true });
const rows = (s, p = []) => sq.prepare(s).all(...p).map((r) => ({ ...r }));
const count = (t) => sq.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

const TABLES = [
  "jobs", "scores", "score_runs", "applications",
  "batches", "triage_history", "actions", "visits", "items",
];

// ---------------------------------------------------------------- the trim
const keepFull = new Set();

for (const r of rows(`
  SELECT key FROM jobs
   WHERE entry_level IN ('program','entry')
     AND COALESCE(class_fit,'ok') <> 'wrong_year'
     AND COALESCE(clearance_status,'none_mentioned') <> 'required_active'`)) {
  keepFull.add(r.key);
}
const reachableCount = keepFull.size;

// Ever saved — any save row at all, undone or not.
const savedKeys = new Set(
  rows(`SELECT DISTINCT key FROM actions WHERE kind='save'`).map((r) => r.key)
);
let savedRows = 0;
if (savedKeys.size) {
  for (const j of rows(`SELECT key, company, title, location FROM jobs`)) {
    if (savedKeys.has(groupKeyOf(j)) && !keepFull.has(j.key)) {
      keepFull.add(j.key);
      savedRows++;
    }
  }
}

const allJobs = rows(`SELECT * FROM jobs`);
let bytesBefore = 0, bytesAfter = 0, trimmed = 0, preserved = 0;
for (const j of allJobs) {
  const d = j.description || "";
  bytesBefore += d.length;
  if (keepFull.has(j.key) || d.length <= KEEP_CHARS) {
    bytesAfter += d.length;
    preserved++;
  } else {
    j.description = d.slice(0, KEEP_CHARS);
    bytesAfter += KEEP_CHARS;
    trimmed++;
  }
}

const mb = (n) => (n / 1e6).toFixed(1) + " MB";
console.log("TRIM");
console.log(`  reachable rows keeping full text     ${reachableCount}`);
console.log(`  extra rows kept because ever saved   ${savedRows}`);
console.log(`  rows preserved in full               ${preserved}`);
console.log(`  rows truncated to ${KEEP_CHARS}              ${trimmed}`);
console.log(`  description bytes  ${mb(bytesBefore)}  ->  ${mb(bytesAfter)}`);

if (DRY) {
  console.log("\n--dry-run: nothing written");
  process.exit(0);
}

// ---------------------------------------------------------------- the copy
const env = { ...readEnv(), ...process.env };
assertEndpoint("DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED, "direct");
const client = new pg.Client({ connectionString: env.DATABASE_URL_UNPOOLED });
await client.connect();

const before = {};
for (const t of TABLES) before[t] = count(t);

try {
  await client.query("BEGIN");
  // One transaction: truncate and refill together, so a failure halfway leaves
  // Postgres as it was rather than half-populated.
  await client.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY`);

  for (const table of TABLES) {
    const data = table === "jobs" ? allJobs : rows(`SELECT * FROM ${table}`);
    if (!data.length) continue;
    // actions.id and visits.id are IDENTITY columns; let Postgres assign them,
    // but preserve ORDER, because actions.id is what makes "latest wins"
    // deterministic. Inserting in ascending source-id order preserves it.
    const cols = Object.keys(data[0]).filter(
      (c) => !((table === "actions" || table === "visits") && c === "id")
    );
    if (table === "actions" || table === "visits") data.sort((a, b) => a.id - b.id);

    for (let i = 0; i < data.length; i += BATCH) {
      const chunk = data.slice(i, i + BATCH);
      const params = [];
      const tuples = chunk.map((row) => {
        const ph = cols.map((c) => {
          params.push(row[c] === undefined ? null : row[c]);
          return `$${params.length}`;
        });
        return `(${ph.join(",")})`;
      });
      await client.query(
        `INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}`,
        params
      );
    }
    process.stdout.write(`  copied ${table.padEnd(16)} ${data.length}\n`);
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  console.error(`\nFAILED, rolled back — Postgres unchanged: ${e.message}\n`);
  await client.end();
  process.exit(1);
}

// ---------------------------------------------------------------- verify
console.log("\nROW COUNTS");
console.log(`  ${"table".padEnd(16)} ${"sqlite".padStart(8)} ${"postgres".padStart(9)}`);
let mismatch = 0;
for (const t of TABLES) {
  const after = (await client.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
  const ok = after === before[t];
  if (!ok) mismatch++;
  console.log(
    `  ${t.padEnd(16)} ${String(before[t]).padStart(8)} ${String(after).padStart(9)}` +
    (ok ? "" : "   MISMATCH")
  );
}

const size = (await client.query(
  `SELECT pg_size_pretty(pg_database_size(current_database())) s`
)).rows[0].s;
console.log(`\n  postgres database size: ${size}`);

// Every reachable and every ever-saved row must hold its full text.
const short = (await client.query(
  `SELECT COUNT(*)::int n FROM jobs
    WHERE entry_level IN ('program','entry')
      AND COALESCE(class_fit,'ok') <> 'wrong_year'
      AND COALESCE(clearance_status,'none_mentioned') <> 'required_active'
      AND length(description) = $1`, [KEEP_CHARS]
)).rows[0].n;
console.log(`  reachable rows sitting at exactly ${KEEP_CHARS} chars: ${short}` +
            (short ? "  <- check these are genuinely that long" : "  (none truncated)"));

// Spot check: three trimmed rows, first 200 characters as stored.
const spot = (await client.query(
  `SELECT company, title, length(description) len, left(description, 200) head
     FROM jobs WHERE length(description) = $1 ORDER BY key LIMIT 3`, [KEEP_CHARS]
)).rows;
console.log("\nSPOT CHECK — three trimmed rows, first 200 characters as stored\n");
for (const r of spot) {
  console.log(`  ${r.company} — ${r.title}  (${r.len} chars)`);
  console.log(`    ${r.head.replace(/\s+/g, " ").slice(0, 200)}\n`);
}

await client.end();
process.exit(mismatch ? 1 : 0);
