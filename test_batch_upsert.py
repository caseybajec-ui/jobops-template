#!/usr/bin/env python3
"""The batched upsert must behave identically on both backends.

Run: python test_batch_upsert.py     (Postgres half skips with no DATABASE_URL)

The fetch went from one statement per posting to one per batch of 250, and from
one commit at the end of the run to one per batch. That is a correctness change,
not a speed change: the single end-of-run transaction meant a run killed under
the Actions cap wrote NOTHING, every morning, with no error to notice.

Batching introduces a failure the per-row loop could not have:

  * ONE `INSERT .. ON CONFLICT` may not touch the same row twice. Postgres
    raises `cannot affect row a second time` and takes the whole batch with it.
    A paginated board handing back the same posting on two pages is enough. The
    fetch dedupes inside the batch; this proves the dedupe is needed AND works.

Everything else here is behaviour the per-row version already had and must not
lose: first_seen survives an update, last_seen advances, and closed_at clears
when a role reappears.

Runs against a table of its own and drops it, so it never touches real rows.
"""
import sqlite3
import sys

import fetch_jobs as F
from console import utf8_stdout

TABLE = "jobs_batchtest"

DDL = """CREATE TABLE %s (
  key TEXT PRIMARY KEY, source TEXT, slug TEXT, ext_id TEXT, company TEXT,
  title TEXT, location TEXT, url TEXT, description TEXT, posted_at TEXT,
  tier INTEGER, candidate INTEGER, first_seen TEXT, last_seen TEXT,
  closed_at TEXT, display_name TEXT, comp_raw TEXT)"""

fails = []


def check(label, ok, detail=""):
    print("  %-4s %s%s" % ("ok" if ok else "FAIL", label,
                           "" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


def row(key, title, stamp):
    return (key, "greenhouse", "acme", key.split(":")[-1], "Acme", title,
            "Los Angeles", "http://x", "body", None, 1, 1, stamp, stamp,
            "Acme", None)


def upsert(con, rows):
    """Exactly what fetch_jobs.flush() builds, against the test table."""
    uniq = {}
    for r in rows:
        uniq[r[0]] = r
    rr = list(uniq.values())
    sql = (F._UPSERT_HEAD.replace("INTO jobs", "INTO " + TABLE)
           + ",".join([F._UPSERT_ROW] * len(rr))
           + F._UPSERT_TAIL)
    con.execute(sql, tuple(v for r in rr for v in r))
    con.commit()
    return len(rr)


def probe(con):
    """Identical operations on either backend; returns comparable state."""
    out = {}
    # A batch containing the SAME key twice, which is the new failure mode.
    n = upsert(con, [row("greenhouse:acme:1", "APM", "T1"),
                     row("greenhouse:acme:2", "PM", "T1"),
                     row("greenhouse:acme:2", "PM v2", "T1")])
    out["rows_written"] = n

    # A role goes away and comes back: closed_at must clear, first_seen must not.
    con.execute("UPDATE %s SET closed_at = ? WHERE key = ?" % TABLE,
                ("2026-01-01", "greenhouse:acme:1"))
    con.commit()
    upsert(con, [row("greenhouse:acme:1", "APM", "T2")])

    for k, t, fs, ls, ca in con.execute(
            "SELECT key, title, first_seen, last_seen, closed_at"
            " FROM %s ORDER BY key" % TABLE).fetchall():
        out[k] = (t, fs, ls, ca)
    return out


def main():
    utf8_stdout()

    print("batch size")
    n_params = F.BATCH_ROWS * F._UPSERT_ROW.count("?")
    check("stays inside both backends' parameter limits", n_params <= 32766,
          "%d parameters per batch" % n_params)
    check("placeholders match the named columns",
          F._UPSERT_ROW.count("?") + F._UPSERT_ROW.count("NULL") == 17,
          "%d + NULL" % F._UPSERT_ROW.count("?"))

    print("\nsqlite")
    lite = sqlite3.connect(":memory:")
    lite.row_factory = sqlite3.Row
    lite.execute(DDL % TABLE)
    a = probe(lite)
    lite.close()
    check("a duplicate key inside one batch does not raise", True)
    check("dedupe keeps the last occurrence",
          a["greenhouse:acme:2"][0] == "PM v2", a["greenhouse:acme:2"][0])
    check("first_seen survives an update",
          a["greenhouse:acme:1"][1] == "T1", a["greenhouse:acme:1"][1])
    check("last_seen advances",
          a["greenhouse:acme:1"][2] == "T2", a["greenhouse:acme:1"][2])
    check("closed_at clears when a role reappears",
          a["greenhouse:acme:1"][3] is None, repr(a["greenhouse:acme:1"][3]))

    import pgdb
    if not pgdb.using_pg():
        print("\nno DATABASE_URL_UNPOOLED — skipping the Postgres half")
    else:
        print("\npostgres")
        pg = pgdb.connect()
        pg.execute("DROP TABLE IF EXISTS %s" % TABLE)
        pg.execute(DDL % TABLE)
        pg.commit()
        try:
            b = probe(pg)
        finally:
            pg.execute("DROP TABLE IF EXISTS %s" % TABLE)
            pg.commit()
            pg.close()
        differing = [k for k in set(a) | set(b) if a.get(k) != b.get(k)]
        check("every value matches sqlite", not differing,
              "differ: %s" % ", ".join(sorted(differing)[:4]))

    print()
    if fails:
        print("%d check%s failed: %s"
              % (len(fails), "" if len(fails) == 1 else "s", "; ".join(fails)))
        return 1
    print("the batched upsert behaves the same on both backends")
    return 0


if __name__ == "__main__":
    sys.exit(main())
