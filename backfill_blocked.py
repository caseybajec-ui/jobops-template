#!/usr/bin/env python3
"""Seed the apply flows already known to be broken. No model, no network, no cost.

  python backfill_blocked.py --dry-run    # print what it would write
  python backfill_blocked.py              # write it

IDEMPOTENT. A key that is already blocked is SKIPPED rather than re-inserted:
the table is insert-only and folded latest-by-id, so a second run would pile up
rows that all say the same thing and push the original write's timestamp out of
reach. "Blocked since" is the number that matters on a window counting down.

EVERY ROW HERE WAS OBSERVED, NOT INFERRED. Two of them, and the third is
absent on purpose -- see below.
"""
import argparse
import sys

import apply_blocks as B
import fetch_jobs
from console import utf8_stdout

# (key, reason, note)
#
# The label and url are NOT written here for a role: they are read from the job
# row at write time by apply_blocks.role_snapshot(), so the row freezes what the
# board actually said rather than what this file guessed.
SEED = [
    # ONE REQUISITION, NOT THE ROLE GROUP, and this is the row that proves why
    # the table is keyed on jobs.key. Palantir has 36 open Deployment
    # Strategist postings and a dozen of them -- Chicago, New York, London,
    # Amsterdam, Oslo, Sydney and the rest -- share the single group key
    # `palantir|deployment strategist`. The hCaptcha loops on the Chicago
    # requisition's Lever page. Blocking the group would have deleted eleven
    # good postings, New York included, to record one broken form.
    ("lever:palantir:bc087dba-1e41-49e0-83bd-36832122363d",
     "captcha_hcaptcha",
     "hCaptcha loops on Lever apply flow"),

    # THE WINDOW, and the reason days-until-close is on the digest line.
    # Deloitte closes 2026-09-30. The 406 started on the 8th and had eaten
    # three days before anything in this system could say so; a blocked window
    # with no countdown can sit in the digest until the date passes, which is
    # the failure the section exists to prevent.
    #
    # NO URL ON THIS ROW, deliberately. companies.yaml's `source` for Deloitte
    # is a third-party tracker (extern.com), which is where the DATE comes from
    # and emphatically not where you apply; Deloitte's own application URL is
    # not recorded anywhere in this repo. A guessed link is the failure mode
    # this project has hit twice -- a page that loads is not a page that worked
    # -- so the line renders without one rather than with a plausible wrong one.
    ("window:Deloitte|Strategy & Operations / Consulting, undergraduate",
     "http_error",
     "HTTP 406 since 2026-09-08",
     "Deloitte — Strategy & Operations / Consulting, undergraduate"),
]

# ANDURIL IS DELIBERATELY NOT SEEDED.
#
# The posting closed on 2026-09-11T17:43:46Z, hours before this was written.
# Recording it would put "go apply by hand" in the digest against a dead
# requisition, and a `(closed)` tag on a line the owner has to read past every
# morning is worse than the line not existing -- the section's whole value is
# that everything in it is actionable.
#
# The TABLE can represent it: `closed` is a reason in apply_blocks.REASONS and
# in web/lib/blocked.js, because the apply bot meets closed reqs on boards this
# tool does not track, and "I went to apply and it was gone" is worth recording
# when nothing else can see it. The seed just does not write one.


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be written and write nothing")
    a = ap.parse_args()

    con = fetch_jobs.db()
    try:
        existing = B.fold(B.read_all(con))
    except Exception as e:
        # A MISSING TABLE IS THE LIKELY CAUSE AND IT IS SAID PLAINLY. A stack
        # trace reading "relation blocked_applies does not exist" is a migration
        # that has not run, and guessing at it costs ten minutes.
        print("Could not read blocked_applies: %s" % e)
        print("If the table does not exist yet, apply migration 023 first:")
        print("  cd web; node lib/applymigration.mjs ../migrations/"
              "023_blocked_applies.sql")
        return 1

    wrote = skipped = 0
    for row in SEED:
        key, reason, note = row[0], row[1], row[2]
        label = row[3] if len(row) > 3 else None
        scope = B.scope_of(key)
        cur = existing.get((scope, key))
        if cur and int(cur["on_"] or 0):
            print("  skip   already blocked: %s" % (cur["label"] or key))
            skipped += 1
            continue

        url = None
        if scope == "role":
            found_label, url, found = B.role_snapshot(con, key)
            label = label or found_label
            if not found:
                print("  note   no job row for %s; writing with no label or url"
                      % key)

        print("  %s %s" % ("would " if a.dry_run else "write ", label or key))
        print("         %s: %s" % (B.REASONS.get(reason, reason), note))
        if url:
            print("         %s" % url)
        if not a.dry_run:
            B.write(con, key, reason=reason, note=note, label=label, url=url,
                    on=True)
        wrote += 1

    print()
    if a.dry_run:
        print("%d would be written, %d already blocked. Nothing was written."
              % (wrote, skipped))
        return 0

    # A SEED THAT SEEDED NOTHING IS REPORTED AS SUCH, never as a quiet success
    # -- the same rule seed_watched.py carries. Here "nothing" is legitimate on
    # a second run, so the two cases are named apart rather than collapsed.
    if wrote == 0 and skipped == 0:
        print("SEEDED NOTHING, and nothing was already there. That is not a "
              "clean run: SEED has %d entries." % len(SEED))
        return 1
    print("%d written, %d already blocked." % (wrote, skipped))
    print("Check it with: python apply_blocks.py list")
    return 0


if __name__ == "__main__":
    sys.exit(main())
