/**
 * Tests for the `?` -> `$n` shim. Run: node test_sqlshim.mjs
 *
 * Every case here is one a naive replace() gets wrong. The shim exists so that
 * sixty hand-written queries survive the Postgres migration byte-identical, so
 * a bug in it is a bug in all sixty at once — and it would show up as wrong
 * DATA rather than as an error.
 */
import { toPositional, countPlaceholders } from "./lib/sqlshim.js";

let pass = 0;
const fails = [];
function is(got, want, what) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${what}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
}
const t = (sql) => toPositional(sql).text;
const n = (sql) => toPositional(sql).count;

// ---------------------------------------------------------------- the basics
is(t("SELECT * FROM jobs WHERE key = ?"), "SELECT * FROM jobs WHERE key = $1", "one placeholder");
is(t("WHERE a = ? AND b = ? AND c = ?"), "WHERE a = $1 AND b = $2 AND c = $3", "three, numbered in order");
is(t("SELECT 1"), "SELECT 1", "none at all");
is(n("SELECT 1"), 0, "count with no placeholders");
is(n("WHERE a = ? AND b = ?"), 2, "count with two");

// ---- ten or more: $10 must not be read as $1 followed by a literal 0 --------
{
  const sql = "VALUES (" + Array(12).fill("?").join(",") + ")";
  const r = toPositional(sql);
  is(r.count, 12, "twelve placeholders counted");
  is(r.text.includes("$10,$11,$12)"), true, "double digits stay intact");
  is(r.text.startsWith("VALUES ($1,$2,"), true, "and single digits still start at $1");
}

// ---------------------------------------------------- ? inside a string literal
is(t("WHERE note = 'what? really'"), "WHERE note = 'what? really'",
   "a ? inside a literal is data, not a placeholder");
is(n("WHERE note = 'what? really'"), 0, "and is not counted");
is(t("WHERE note = 'what? really' AND key = ?"),
   "WHERE note = 'what? really' AND key = $1",
   "a literal ? next to a real one");
is(n("WHERE note = 'what? really' AND key = ?"), 1, "only the real one counts");

// ------------------------------------------------------------- LIKE patterns
is(t("WHERE title LIKE '%?%'"), "WHERE title LIKE '%?%'", "? inside a LIKE pattern");
is(t("WHERE title LIKE ? AND note LIKE '%?%'"),
   "WHERE title LIKE $1 AND note LIKE '%?%'",
   "a LIKE placeholder and a literal ? in one query");
is(n("WHERE title LIKE ? AND note LIKE '%?%'"), 1, "counted once");

// -------------------------------------------------------------------- JSON
is(t(`WHERE meta = '{"undo":true,"q":"why?"}'`),
   `WHERE meta = '{"undo":true,"q":"why?"}'`,
   "? inside JSON in a literal");
is(t(`WHERE meta = '{"q":"why?"}' AND key = ?`),
   `WHERE meta = '{"q":"why?"}' AND key = $1`,
   "JSON literal plus a real placeholder");

// -------------------------------------------------- escaped quote in a literal
is(t("WHERE note = 'it''s ok?' AND key = ?"),
   "WHERE note = 'it''s ok?' AND key = $1",
   "'' does not end the literal, so the ? inside stays data");
is(n("WHERE note = 'it''s ok?' AND key = ?"), 1, "and only the outside one counts");
is(t("WHERE a = 'don''t' AND b = ?"), "WHERE a = 'don''t' AND b = $1",
   "escaped quote with no ? at all");

// ------------------------------------------------------------------ comments
is(t("SELECT 1 -- is this ?\nWHERE k = ?"), "SELECT 1 -- is this ?\nWHERE k = $1",
   "? in a line comment is ignored");
is(t("SELECT 1 /* ? */ WHERE k = ?"), "SELECT 1 /* ? */ WHERE k = $1",
   "? in a block comment is ignored");
is(t("SELECT 1 /* a /* nested ? */ still */ WHERE k = ?"),
   "SELECT 1 /* a /* nested ? */ still */ WHERE k = $1",
   "Postgres block comments nest");
is(n("SELECT 1 -- ?\n-- ?\nWHERE k = ?"), 1, "several comment ?s, one real");

// --------------------------------------------------------------------- casts
is(t("SELECT COUNT(*)::int n FROM jobs WHERE k = ?"),
   "SELECT COUNT(*)::int n FROM jobs WHERE k = $1",
   ":: cast passes through and is not a placeholder");
is(n("SELECT a::text, b::int FROM t"), 0, "casts alone count zero placeholders");

// ------------------------------------------------- double-quoted identifiers
is(t(`SELECT "odd?name" FROM t WHERE k = ?`), `SELECT "odd?name" FROM t WHERE k = $1`,
   "? inside a quoted identifier is not a placeholder");

// ------------------------------------------------- a real query from this app
{
  const real = `SELECT * FROM (
       SELECT j.key ${""} FROM jobs j
       WHERE j.closed_at IS NULL AND s.score IS NOT NULL
     ) WHERE score >= ? AND category = ? AND (comp_min IS NULL OR comp_min >= ?)
     ORDER BY score DESC, key LIMIT ?`;
  const r = toPositional(real);
  is(r.count, 4, "a real listJobs-shaped query has four placeholders");
  is(r.text.includes("score >= $1"), true, "first is $1");
  is(r.text.endsWith("LIMIT $4"), true, "last is $4");
}

// ----------------------------------------------- the params must still line up
{
  const sql = "WHERE a = ? AND note = 'huh?' AND b = ? LIMIT ?";
  const params = ["x", "y", 10];
  is(countPlaceholders(sql), params.length,
     "placeholder count matches the params array — the check that catches a shim bug at runtime");
}

console.log(`${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.log("\nFAILURES:");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
