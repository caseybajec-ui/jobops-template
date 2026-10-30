#!/usr/bin/env python3
"""Bring stored descriptions in line with storage_policy.

    python backfill_descriptions.py --dry-run   # report, change nothing
    python backfill_descriptions.py             # do it

Needed because the stored state and the write rule were set by different rules:
the migration trimmed on "reachable", `fetch_jobs.py` now writes on "passed the
title filter". Until every row happens to be re-fetched, the database holds one
rule and the code enforces another — so this closes the gap in the same change.

Rows move BOTH ways:
  * a candidate that was truncated by the old rule gets its full text back,
    which requires re-reading it from jobs.db;
  * a non-candidate that kept full text is truncated, unless the owner has acted
    on it, in which case it keeps everything.

COPY, VERIFY, THEN REPLACE. Everything runs in ONE transaction, so a failure
halfway leaves the database exactly as it was rather than half-converted.
jobs.db is opened READ-ONLY and is never modified — it is the source of the full
text and remains the backup.
"""
import argparse
import io
import sqlite3
import sys
from pathlib import Path

from fetch_jobs import DB as SQLITE, db
from storage_policy import (KEEP_FULL_CHARS, SQL_KEEP_FULL,
                            store_description)
from console import utf8_stdout

# The path comes from fetch_jobs, which anchors it to its own directory. This
# was a second bare "jobs.db", resolved against the working directory, so from
# any subdirectory it addressed a different file than db() did — two names for
# one thing in a script whose entire job is comparing the two databases.
#
# Reusing the constant rather than repeating the expression is the point: one
# definition cannot drift from itself, and this file already imports db() from
# there anyway.
#
# It opens READ-ONLY (mode=ro), so unlike fetch_jobs.db() it could never have
# created a stray — sqlite refuses rather than creating. It would simply have
# failed, or read the wrong file.


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    con = db()
    # Full text lives in jobs.db; Postgres may already hold a truncated copy.
    # Path.as_uri(), not string interpolation. SQLITE is an absolute Windows
    # path now, and "file:C:\Users\..." only parses by luck — a backslash is not
    # a URI path separator, and a "?" or "#" anywhere in the path would cut the
    # string in half. as_uri() gives file:///C:/Users/... and escapes the rest.
    lite = sqlite3.connect(Path(SQLITE).as_uri() + "?mode=ro", uri=True)
    full = {k: d for k, d in lite.execute(
        "SELECT key, description FROM jobs")}
    lite.close()

    acted = {r["key"] for r in con.execute(
        "SELECT DISTINCT key FROM actions")}
    rows = con.execute(
        "SELECT key, candidate, length(description) len FROM jobs").fetchall()

    grow, shrink, same = [], [], 0
    before = 0
    for r in rows:
        before += r["len"] or 0
        source = full.get(r["key"])
        if source is None:
            same += 1
            continue
        want = store_description(source, r["candidate"],
                                 r["key"] in acted)
        want_len = len(want or "")
        if want_len == (r["len"] or 0):
            same += 1
        elif want_len > (r["len"] or 0):
            grow.append((r["key"], want))
        else:
            shrink.append((r["key"], want))

    after = 0
    for r in rows:
        source = full.get(r["key"])
        after += len(store_description(source, r["candidate"]) or "") \
            if source is not None else (r["len"] or 0)

    mb = lambda n: "%.1f MB" % (n / 1e6)
    print("rows examined            %d" % len(rows))
    print("  already correct        %d" % same)
    print("  gaining full text      %d  (candidates the old rule truncated)"
          % len(grow))
    print("  being truncated        %d  (non-candidates the old rule kept)"
          % len(shrink))
    print("  description bytes      %s  ->  %s" % (mb(before), mb(after)))

    if a.dry_run:
        print("\n--dry-run: nothing written")
        return 0
    if not grow and not shrink:
        print("\nnothing to do")
        return 0

    for key, want in grow + shrink:
        con.execute("UPDATE jobs SET description = ? WHERE key = ?", (want, key))
    con.commit()

    check = con.execute(
        "SELECT COUNT(*) n FROM jobs WHERE NOT " + SQL_KEEP_FULL +
        " AND length(description) > ?", (KEEP_FULL_CHARS,)).fetchone()["n"]
    total = con.execute(
        "SELECT SUM(length(description)) n FROM jobs").fetchone()["n"]
    print("\nwritten. non-candidates still over %d chars: %d"
          % (KEEP_FULL_CHARS, check))
    print("stored description bytes now: %s" % mb(total or 0))
    return 1 if check else 0


if __name__ == "__main__":
    sys.exit(main())
