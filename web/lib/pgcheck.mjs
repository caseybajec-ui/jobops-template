/**
 * Connection check for both Neon strings. Prints facts, never values.
 *
 *   node lib/pgcheck.mjs
 *
 * Neon gives two endpoints and they are not interchangeable:
 *
 *   DATABASE_URL           pooled  (-pooler in the host)  PgBouncer, transaction mode
 *   DATABASE_URL_UNPOOLED  direct                          full session
 *
 * Using the wrong one fails in a way that is not obvious. The app on a direct
 * connection works fine until enough serverless invocations pile up and then
 * starts refusing connections. The CLI on the pooled endpoint works until the
 * moment it runs DDL or anything session-level, because PgBouncer in
 * transaction mode does not support SET/RESET, LISTEN/NOTIFY, SQL-level
 * PREPARE, temp tables or session advisory locks.
 *
 * So the shape is checked, not just the connection — and the message names the
 * variable and says what it should contain, because "connection failed" sends
 * you looking at the network.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ENV = path.join(process.cwd(), "..", ".env");

/** Minimal .env reader. Never logs a value. */
export function readEnv() {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(ENV, "utf8"); } catch { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export const isPooled = (url) => /-pooler\./.test(url || "");

/**
 * Throws with an actionable message if the URL is the wrong kind.
 * `want` is "pooled" or "direct".
 */
export function assertEndpoint(name, url, want) {
  if (!url) {
    throw new Error(
      `${name} is not set.\n` +
      `  It should hold the Neon ${want} connection string.\n` +
      `  Neon console -> your project -> Connect -> ` +
      (want === "pooled"
        ? `turn "Connection pooling" ON, copy the string (its host contains "-pooler").`
        : `turn "Connection pooling" OFF, copy the string (its host has NO "-pooler").`)
    );
  }
  const pooled = isPooled(url);
  if (want === "pooled" && !pooled) {
    throw new Error(
      `${name} holds the DIRECT string, but it must be the POOLED one.\n` +
      `  Its host is missing "-pooler". Serverless opens a connection per request,\n` +
      `  and the direct endpoint will start refusing them under load.\n` +
      `  Fix: Neon console -> Connect -> "Connection pooling" ON -> copy -> set ${name}.`
    );
  }
  if (want === "direct" && pooled) {
    throw new Error(
      `${name} holds the POOLED string, but it must be the DIRECT one.\n` +
      `  Its host contains "-pooler", which is PgBouncer in transaction mode: no DDL,\n` +
      `  no SET/RESET, no temp tables. The Python CLI runs CREATE TABLE on startup and\n` +
      `  will fail on it.\n` +
      `  Fix: Neon console -> Connect -> "Connection pooling" OFF -> copy -> set ${name}.`
    );
  }
}

async function probe(name, url, want) {
  process.stdout.write(`${name.padEnd(24)}`);
  try {
    assertEndpoint(name, url, want);
  } catch (e) {
    console.log("FAILED");
    console.log("\n" + e.message + "\n");
    return false;
  }
  // No ssl override. Neon presents a valid certificate and the connection string
  // carries sslmode; passing rejectUnauthorized:false here would quietly downgrade
  // TLS verification on every connection, which is not a thing to ship for the
  // convenience of a check script.
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const v = await client.query("select version() v, current_database() d, now() n");
    const { v: ver, d: db } = v.rows[0];
    console.log(
      `ok   ${want.padEnd(7)} ${ver.split(" ").slice(0, 2).join(" ")}  db=${db}`
    );
    return true;
  } catch (e) {
    console.log("FAILED");
    console.log(`\n  connected as ${want}, but the server rejected it:\n  ${e.message}\n`);
    return false;
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
}

// Only run the probes when this file is invoked directly. Without the guard,
// importing assertEndpoint in order to TEST it runs the whole check as a side
// effect — which is how the first attempt to prove the swap detection instead
// printed a successful connection check.
const invokedDirectly = (process.argv[1] || "").replace(/\\/g, "/").endsWith("pgcheck.mjs");

if (invokedDirectly) {
  const env = { ...readEnv(), ...process.env };
  console.log("Neon connection check — values are never printed\n");
  const a = await probe("DATABASE_URL", env.DATABASE_URL, "pooled");
  const b = await probe("DATABASE_URL_UNPOOLED", env.DATABASE_URL_UNPOOLED, "direct");
  console.log();
  if (a && b) {
    console.log("both endpoints reachable and the right way round");
    process.exit(0);
  }
  process.exit(1);
}
