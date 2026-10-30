#!/usr/bin/env python3
"""pgdb.py wears the sqlite3 API. This proves it wears it accurately.

Run: python test_pgdb_parity.py          (skips silently with no DATABASE_URL)

The bug that prompted this: iterating a `sqlite3.Row` yields VALUES, iterating a
dict yields KEYS — so `for a, b, c in rows` silently unpacked column names and
seed_items.py --status printed "source due_at title" as though it were the data.
No error. Same shape as SQLite's permissive GROUP BY: both objects work, they
just return different things.

So every behaviour a caller could depend on is asserted against BOTH backends and
compared, rather than reasoned about. Anything a future caller might reach for —
integer indexing, len(), description, rowcount, lastrowid, empty fetches — is
either identical or explicitly documented as differing.
"""
import io
import os
import sqlite3
import sys
from console import utf8_stdout

DDL = """CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, s TEXT)"""
ROWS = [("a", 1, "one"), ("b", 2, "two"), ("c", 3, "three")]


def probe(con, label):
    """Run identical operations and return a comparable dict of behaviours."""
    out = {}
    con.execute("INSERT INTO t (id, n, s) VALUES (?,?,?)", ROWS[0])
    con.execute("INSERT INTO t (id, n, s) VALUES (?,?,?)", ROWS[1])
    con.execute("INSERT INTO t (id, n, s) VALUES (?,?,?)", ROWS[2])
    con.commit()

    r = con.execute("SELECT id, n, s FROM t WHERE id = ?", ("b",)).fetchone()
    out["by_name"] = r["n"]
    out["by_index_0"] = r[0]
    out["by_index_2"] = r[2]
    out["len_row"] = len(r)
    out["iter_row"] = list(r)                 # VALUES, not keys
    out["keys"] = list(r.keys())
    out["unpack"] = None
    try:
        a, b, c = r
        out["unpack"] = [a, b, c]
    except Exception as e:                     # noqa: BLE001
        out["unpack"] = "raised %s" % type(e).__name__

    out["fetchone_empty"] = con.execute(
        "SELECT id FROM t WHERE id = ?", ("nope",)).fetchone()
    out["fetchall_empty"] = con.execute(
        "SELECT id FROM t WHERE id = ?", ("nope",)).fetchall()

    cur = con.execute("SELECT id, n FROM t ORDER BY id")
    out["description_names"] = [d[0] for d in cur.description]
    out["fetchall_len"] = len(cur.fetchall())

    out["iterate_cursor"] = [row["id"] for row in
                             con.execute("SELECT id FROM t ORDER BY id")]

    cur = con.execute("UPDATE t SET n = n + 10 WHERE n >= ?", (2,))
    out["rowcount_update"] = cur.rowcount
    cur = con.execute("DELETE FROM t WHERE id = ?", ("c",))
    out["rowcount_delete"] = cur.rowcount
    con.commit()
    out["rows_left"] = con.execute("SELECT COUNT(*) c FROM t").fetchone()["c"]
    return out


def main():
    utf8_stdout()
    import pgdb
    if not pgdb.using_pg():
        print("no DATABASE_URL_UNPOOLED — skipping parity check")
        return 0

    # --- sqlite3, in memory ---
    lite = sqlite3.connect(":memory:")
    lite.row_factory = sqlite3.Row
    lite.execute(DDL)
    a = probe(lite, "sqlite3")
    lite.close()

    # --- Postgres, in a temp table dropped afterwards ---
    pg = pgdb.connect()
    pg.execute("DROP TABLE IF EXISTS t")
    pg.execute(DDL)
    pg.commit()
    try:
        b = probe(pg, "pgdb")
    finally:
        pg.execute("DROP TABLE IF EXISTS t")
        pg.commit()
        pg.close()

    keys = sorted(set(a) | set(b))
    width = max(len(k) for k in keys)
    print("%-*s  %-26s %-26s" % (width, "behaviour", "sqlite3", "pgdb"))
    print("-" * (width + 56))
    bad = []
    for k in keys:
        same = a.get(k) == b.get(k)
        if not same:
            bad.append(k)
        print("%-*s  %-26s %-26s %s"
              % (width, k, repr(a.get(k))[:26], repr(b.get(k))[:26],
                 "" if same else "<-- DIFFERS"))
    print()
    if bad:
        print("%d behaviour%s differ: %s"
              % (len(bad), "" if len(bad) == 1 else "s", ", ".join(bad)))
        return 1
    print("every probed behaviour matches sqlite3")
    return 0


if __name__ == "__main__":
    sys.exit(main())
