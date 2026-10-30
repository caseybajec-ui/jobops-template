#!/usr/bin/env python3
"""Stamp blockers on every open role. No model, no network, no cost.

  python backfill_blockers.py --dry-run     # counts per blocker per company
  python backfill_blockers.py               # write them

WHY IT PRINTS BEFORE IT WRITES. A classifier change in this project gets a
full-corpus diff read by hand before it is accepted -- a rate tells you how much
moved and never what. --dry-run is that, and the real run prints the same block
before touching a row, so the numbers on screen are always the ones from the code
that is about to act rather than a hand-written query describing what it does.

IT NEVER DELETES. Rows are updated in place with new values; nothing is cleared
first. "Never delete before the replacement is confirmed" -- 204 score rows were
once deleted to queue them for re-scoring and the batch then failed on an
out-of-credits error.
"""
import argparse
import collections
import json
import sys

import fetch_jobs
from blockers import ALL_TAGS, HARD, classify, hard_tags, is_clear
from console import utf8_stdout
from storage_policy import KEEP_FULL_CHARS, keep_full, tracked_boards

BATCH = 500


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="print the counts and write nothing")
    ap.add_argument("--all", action="store_true",
                    help="re-read every row, not just untagged ones "
                         "(use after changing a pattern in blockers.py)")
    ap.add_argument("--closed", action="store_true",
                    help="include roles already closed")
    a = ap.parse_args()

    con = fetch_jobs.db()

    # INCREMENTAL BY DEFAULT, and the description is the reason.
    #
    # Reading every open role's description is ~77 MB off Neon's monthly
    # transfer allowance -- and this script was run five times in one session,
    # which with the ad-hoc probes is what took the allowance to 100% and put
    # compute at risk of suspension.
    #
    # It is also unnecessary now. cmd_fetch stamps blockers on every row it
    # writes, and it writes exactly the rows whose content changed, so the only
    # rows that can be missing tags are ones written before the column existed.
    # `blockers IS NULL` is precisely that set, and it empties itself.
    #
    # --all re-reads everything, and is what to use after changing a pattern in
    # blockers.py -- a classifier change needs the whole corpus by definition.
    scope = ["closed_at IS NULL"] if not a.closed else []
    if not a.all:
        scope.append("blockers IS NULL")
    where = ("WHERE " + " AND ".join(scope)) if scope else ""
    rows = con.execute(
        f"SELECT key, company, display_name, title, description, candidate, "
        f"source, slug FROM jobs {where}").fetchall()
    tracked = tracked_boards()

    if not rows and not a.all:
        # NOT A FAILURE, and it must not read as one. Every row already carries
        # tags, which is the steady state once the fetch is doing the stamping.
        print("Nothing to do: every open role already carries blocker tags. "
              "Use --all to re-read the whole corpus after a pattern change.")
        return 0

    if not rows:
        # A --all RUN THAT TOUCHED NOTHING IS NOT A SUCCESSFUL BACKFILL. The
        # incremental case is handled above and is a legitimate no-op; this is
        # the one where the caller asked for everything and got nothing.
        print("REFUSING: --all matched no rows. Either the table is empty or "
              "the filter is wrong; neither is something to report as done.")
        return 1

    per = collections.defaultdict(collections.Counter)
    tot = collections.Counter()
    clear = unknown = truncated = 0
    updates = []

    for r in rows:
        desc = r["description"] or ""
        # COMPLETE COMES FROM keep_full(), NOT FROM A COPY OF ITS RULE.
        #
        # This was `candidate or len(desc) < KEEP_FULL_CHARS` -- the storage rule
        # written out a second time -- and the moment `tracked` was added to
        # keep_full it was wrong: 9,691 rows whose full text had just been
        # recovered were still reported as truncated, and 4,245 of them as
        # `unknown`, against text that was sitting right there. A second spelling
        # of one rule is how schema.sql drifted twenty columns.
        #
        # The length check stays as a belt-and-braces OR: a posting genuinely
        # shorter than the limit is complete whatever the policy says.
        complete = keep_full(r["candidate"], False,
                             (r["source"], r["slug"]) in tracked)             or len(desc) < KEEP_FULL_CHARS
        res = classify(r["title"], desc, complete)
        name = r["display_name"] or r["company"]

        per[name]["roles"] += 1
        for t in res["tags"]:
            per[name][t] += 1
            tot[t] += 1
        if not complete:
            truncated += 1
        if is_clear(res):
            clear += 1
        elif not res["complete"] and not hard_tags(res["tags"]):
            unknown += 1
        updates.append((json.dumps(res["tags"]), int(res["complete"]), r["key"]))

    print(f"{len(rows)} roles read"
          f"{'' if a.all else ' (open only)'}\n")
    print(f"  {'blocker':24s} {'roles':>7s}")
    for t in ALL_TAGS:
        mark = "  (blocker)" if t in HARD else "  (not a blocker — renders green)"
        print(f"  {t:24s} {tot.get(t, 0):7d}{mark}")

    print(f"\n  clear   — complete text, no hard blocker : {clear}")
    print(f"  UNKNOWN — text truncated, nothing found   : {unknown}")
    print(f"  truncated descriptions in total           : {truncated}"
          f"  ({100 * truncated // max(len(rows), 1)}%)")

    print(f"\n  {'company':24s} {'roles':>6s} {'cs':>4s} {'4+y':>4s} "
          f"{'clr':>4s} {'clr-ok':>7s} {'cit':>4s}")
    for co in sorted(per, key=lambda c: -per[c]["roles"])[:25]:
        p = per[co]
        if not (p["cs_degree"] or p["years_4plus"] or p["clearance"]
                or p["clearance_obtainable"] or p["citizenship_only"]):
            continue
        print(f"  {co[:23]:24s} {p['roles']:6d} {p['cs_degree']:4d} "
              f"{p['years_4plus']:4d} {p['clearance']:4d} "
              f"{p['clearance_obtainable']:7d} {p['citizenship_only']:4d}")

    if a.dry_run:
        print("\n--dry-run: nothing written.")
        return 0

    # ONE STATEMENT PER BATCH, not one per row.
    #
    # The first version issued 11,500 separate UPDATEs and managed 500 in several
    # minutes -- every one a round trip to Neon. The same shape cmd_fetch already
    # uses for its upsert: bind a batch of tuples into a single statement and
    # commit it. A killed run then leaves the batches it finished, rather than
    # nothing.
    #
    # `UPDATE ... FROM (VALUES ...)` is Postgres; SQLite gets the loop. This is
    # the one place the two backends genuinely differ, so it is written out
    # rather than papered over -- pg8000 runs both paths identically otherwise.
    import pgdb
    n = 0
    for i in range(0, len(updates), BATCH):
        chunk = updates[i:i + BATCH]
        if pgdb.using_pg():
            values = ",".join(["(?,?::int,?)"] * len(chunk))
            con.execute(
                # `full` is RESERVED in Postgres (FULL JOIN) and the alias
                # blew up with a bare syntax error pointing at character 11482
                # of the generated SQL, which is not a helpful place to start.
                f"UPDATE jobs SET blockers = v.tags, blockers_full_text = v.complete "
                f"FROM (VALUES {values}) AS v(tags, complete, key) "
                f"WHERE jobs.key = v.key",
                tuple(x for row in chunk for x in row))
        else:
            for tags, complete, key in chunk:
                con.execute(
                    "UPDATE jobs SET blockers = ?, blockers_full_text = ? "
                    "WHERE key = ?", (tags, complete, key))
        con.commit()
        n += len(chunk)
        print(f"  written {n}/{len(updates)}", end="\r")

    # POSITIVE ASSERTION. Read the rows back rather than trusting the UPDATE
    # count: a CLI that silently fails to write is worse than one that errors,
    # because cron will do it unattended every morning.
    check = con.execute(
        "SELECT COUNT(*) AS n FROM jobs WHERE blockers IS NOT NULL").fetchone()["n"]
    print(f"\n{n} rows written; {check} rows in the table now carry blockers.")
    if check < n:
        print("REFUSING TO REPORT SUCCESS: fewer rows carry blockers than were "
              "written. Something did not commit.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
