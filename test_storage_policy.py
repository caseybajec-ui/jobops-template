#!/usr/bin/env python3
"""Fails if the write rule and the stored rows disagree about descriptions.

Run: python test_storage_policy.py      (DB checks skip with no DATABASE_URL)

The bug this exists to catch has already happened once. The 64 MB -> 22.4 MB
trim ran as a one-off during the migration while `fetch_jobs.py` went on writing
full text, so the trim survived exactly until the next 07:10 cron. Nothing
failed; storage would simply have crept back over months.

That failure is invisible to every other test in the repo. A rendered-output
diff cannot see it — the app never displays a description. The scorer cannot see
it — it trims to ~9,000 characters anyway. The only way to notice is to ask the
database directly whether it looks like what the code would have written.

So this compares three statements of one rule against each other:

  1. `store_description()`, the Python the write path calls;
  2. `SQL_KEEP_FULL`, the SQL the set-based work uses;
  3. the bytes actually sitting in `jobs.description` right now.

Any two of them agreeing is not enough.
"""
import io
import sys

from storage_policy import (KEEP_FULL_CHARS, SQL_KEEP_FULL, keep_full,
                            tracked_boards,
                            store_description)
from console import utf8_stdout

fails = []


def check(label, ok, detail=""):
    print("  %-4s %s%s" % ("ok" if ok else "FAIL", label,
                           "" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


def unit_checks():
    print("predicate")
    long = "x" * (KEEP_FULL_CHARS + 500)
    check("candidate keeps full text",
          store_description(long, 1) == long)
    check("non-candidate is trimmed",
          len(store_description(long, 0)) == KEEP_FULL_CHARS)
    check("acted-on non-candidate keeps full text",
          store_description(long, 0, True) == long)
    check("short text is never padded or altered",
          store_description("abc", 0) == "abc")
    check("None survives as None", store_description(None, 1) is None)
    check("trim is idempotent",
          store_description(store_description(long, 0), 0)
          == store_description(long, 0))
    check("keep_full agrees with store_description on the boundary",
          keep_full(0, True) and not keep_full(0, False))

    # `tracked` -- a board listed in companies.yaml. Added 2026-09-06 because
    # blocker tagging is the first consumer that reads EVERY role rather than
    # only candidates, and it can say nothing about a posting whose requirements
    # section was cut off.
    check("a tracked board keeps full text even when it is not a candidate",
          keep_full(0, False, True))
    check("an untracked, unacted non-candidate is still trimmed",
          not keep_full(0, False, False))
    check("store_description honours tracked",
          store_description(long, 0, False, True) == long
          and len(store_description(long, 0, False, False)) == KEEP_FULL_CHARS)

    # A PARSE THAT MATCHED NOTHING WOULD SILENTLY TRIM EVERYTHING, and the text
    # can only be recovered from the boards. tracked_boards() raises rather than
    # returning an empty set; this asserts it found the real list.
    boards = tracked_boards()
    check("companies.yaml parsed into a real board list", len(boards) >= 40,
          "only %d boards parsed" % len(boards))
    check("and the SQL predicate names them too",
          "'greenhouse'" in SQL_KEEP_FULL and "'ashby'" in SQL_KEEP_FULL)


def db_checks():
    import pgdb
    if not pgdb.using_pg():
        print("\nno DATABASE_URL_UNPOOLED — skipping the stored-state checks")
        return
    from fetch_jobs import db
    con = db()

    print("\nPython predicate vs SQL predicate, over every stored row")
    acted = {r["key"] for r in con.execute("SELECT DISTINCT key FROM actions")}
    sql_keep = {r["key"] for r in con.execute(
        "SELECT key FROM jobs WHERE " + SQL_KEEP_FULL)}
    rows = con.execute("SELECT key, candidate, source, slug FROM jobs").fetchall()
    tracked = tracked_boards()
    py_keep = {r["key"] for r in rows
               if keep_full(r["candidate"], r["key"] in acted,
                            (r["source"], r["slug"]) in tracked)}
    check("the two spellings select the same rows", sql_keep == py_keep,
          "%d rows differ" % len(sql_keep ^ py_keep))

    print("\nstored rows vs what the write path would store")
    over = con.execute(
        "SELECT COUNT(*) n FROM jobs WHERE NOT " + SQL_KEEP_FULL +
        " AND length(description) > %d" % KEEP_FULL_CHARS).fetchone()["n"]
    check("no row that should be trimmed is over the limit", over == 0,
          "%d rows are longer than they should be" % over)

    # The other direction: a row that should hold FULL text may be sitting
    # truncated, which the check above cannot see.
    #
    # This used to compare every stored length against jobs.db and it had to be
    # replaced. jobs.db is a frozen pre-migration snapshot, and job descriptions
    # CHANGE — the first fetch after the backfill moved 73 of them, 52 by
    # exactly one character (a template edit on Applied Intuition's board) and
    # 21 by hundreds in both directions. Equality with a stale snapshot was
    # never an invariant; it only looked like one on the day it was written.
    #
    # The self-contained invariant is sharper anyway. store_description can
    # produce a truncated row in exactly ONE way: slicing at KEEP_FULL_CHARS. So
    # a keep-full row sitting at EXACTLY that length is the signature of the
    # bug, and it needs no external source to detect.
    # SCOPED TO OPEN ROWS, and to rows not verified against the board.
    #
    # Two exemptions, both earned rather than assumed:
    #
    # CLOSED ROWS ARE FROZEN. When `tracked` widened keep_full on 2026-09-06,
    # 1,355 already-closed rows became keep-full while still holding the text
    # the old policy stored. They are off their boards, so a re-fetch cannot
    # recover them and no code can repair them; asserting over them would make
    # a permanent failure out of a policy change that was correct.
    #
    # AND ONE OPEN ROW IS GENUINELY THIS LONG. Shield AI's "Sr. Staff Electrical
    # Engineer - BlueSky (R5838)" was re-fetched under the new policy and the
    # Lever board returns exactly 2,000 characters for it -- checked against the
    # board, not assumed. A coincidence, not a slice. It is named here rather
    # than tolerated by a threshold, so a SECOND row appearing at the limit
    # still fails: a count-based fudge would hide exactly the regression this
    # check exists for.
    VERIFIED_EXACTLY_AT_LIMIT = {
        "lever:shieldai:45ea9010-a429-4a28-b2d0-311af12a342e",
    }
    at_limit = [r["key"] for r in con.execute(
        "SELECT key FROM jobs WHERE " + SQL_KEEP_FULL +
        " AND closed_at IS NULL"
        " AND length(description) = %d" % KEEP_FULL_CHARS)]
    unexplained = [k for k in at_limit if k not in VERIFIED_EXACTLY_AT_LIMIT]
    check("no open keep-full row sits unexplained at the trim length",
          not unexplained,
          "%d rows look truncated: %s" % (len(unexplained), unexplained[:3]))

    # And positive evidence, so the checks above cannot all pass on an empty or
    # uniformly-trimmed table: full text is genuinely being kept somewhere.
    over_keep = con.execute(
        "SELECT COUNT(*) n FROM jobs WHERE " + SQL_KEEP_FULL +
        " AND length(description) > %d" % KEEP_FULL_CHARS).fetchone()["n"]
    check("keep-full rows really do hold more than the trim length",
          over_keep > 0, "%d rows over the limit" % over_keep)


def main():
    utf8_stdout()
    unit_checks()
    db_checks()
    print()
    if fails:
        print("%d check%s failed: %s"
              % (len(fails), "" if len(fails) == 1 else "s", "; ".join(fails)))
        return 1
    print("write path and stored rows agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
