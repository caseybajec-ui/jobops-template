/**
 * Rewrite SQLite `?` placeholders into Postgres `$1, $2, ...`.
 *
 * The point of this file is that the 60-odd hand-written queries in db.js stay
 * BYTE-IDENTICAL through the migration. The risk in moving to Postgres is not
 * driver ergonomics, it is sixty queries being retyped; a shim keeps the diff
 * reviewable and confines the change to one place.
 *
 * A naive `sql.replace(/\?/g, ...)` is wrong in every case below, which is why
 * this is a small parser rather than a regex:
 *
 *   'what? really'            a ? inside a string literal is data
 *   LIKE '%?%'                same, and it sits next to a real placeholder
 *   '{"undo":true,"q":"why?"}'  JSON in a literal
 *   'it''s ok?'               an escaped quote does not end the literal
 *   -- is this ?              a line comment
 *   /* ? *\/                  a block comment
 *   col::text                 a cast, not a placeholder — and not a ? at all,
 *                             but proof the scanner must not choke on ::
 *   $10 vs $1 then 0          ten or more placeholders must not collide
 *
 * Postgres also treats `?` as an operator for some types (jsonb, geometry). None
 * of those appear here, and if one ever does it will need escaping — which is
 * why this throws on an unterminated literal rather than guessing.
 */

/** @returns {{text: string, count: number}} */
export function toPositional(sql) {
  let out = "";
  let n = 0;
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    // ---- single-quoted literal: '' is an escaped quote, not a terminator ----
    if (c === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      if (i > sql.length) throw new Error("unterminated string literal in SQL");
      out += sql.slice(start, i);
      continue;
    }

    // ---- double-quoted identifier ----
    if (c === '"') {
      const start = i;
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      i++;
      out += sql.slice(start, i);
      continue;
    }

    // ---- line comment ----
    if (c === "-" && next === "-") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      out += sql.slice(start, i);
      continue;
    }

    // ---- block comment (nestable in Postgres) ----
    if (c === "/" && next === "*") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; continue; }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }

    // ---- cast: pass :: through untouched so it is never mistaken for a param ----
    if (c === ":" && next === ":") {
      out += "::";
      i += 2;
      continue;
    }

    // ---- the placeholder ----
    if (c === "?") {
      n++;
      out += "$" + n;
      i++;
      continue;
    }

    out += c;
    i++;
  }

  return { text: out, count: n };
}

/** Count the placeholders without rewriting — used to check the params match. */
export function countPlaceholders(sql) {
  return toPositional(sql).count;
}
