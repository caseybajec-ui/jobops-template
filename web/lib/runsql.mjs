/**
 * Run a .sql file against the DIRECT Neon connection.
 *
 *   node lib/runsql.mjs ../migrations/001_initial.sql
 *
 * Direct, not pooled: this does DDL, and PgBouncer in transaction mode does not
 * support it. assertEndpoint enforces that rather than letting it fail obscurely
 * halfway through a migration.
 */
import fs from "node:fs";
import pg from "pg";
import { readEnv, assertEndpoint } from "./pgcheck.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node lib/runsql.mjs <path-to.sql>");
  process.exit(2);
}

const env = { ...readEnv(), ...process.env };
try {
  assertEndpoint("DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED, "direct");
} catch (e) {
  console.error("\n" + e.message + "\n");
  process.exit(1);
}

const sql = fs.readFileSync(file, "utf8");
const client = new pg.Client({ connectionString: env.DATABASE_URL_UNPOOLED });

try {
  await client.connect();
  await client.query(sql);
  console.log(`applied ${file}`);

  const t = await client.query(
    `select table_name, (select count(*) from information_schema.columns c
                          where c.table_name = t.table_name
                            and c.table_schema = 'public') as cols
       from information_schema.tables t
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`
  );
  console.log(`\n${t.rowCount} tables:\n`);
  for (const r of t.rows) console.log(`  ${r.table_name.padEnd(18)} ${r.cols} columns`);
} catch (e) {
  console.error(`\nFAILED: ${e.message}\n`);
  process.exit(1);
} finally {
  await client.end();
}
