#!/usr/bin/env python3
"""Fails when the SQLite schema and the Postgres migration have drifted apart.

Run: python test_schema_parity.py

`schema.sql` used to be a hand-maintained copy of the tables and it drifted TWENTY
COLUMNS behind reality. That is worse than having no file: it still looked
authoritative, and building the Postgres migration from it would have silently
dropped every one of those columns. It has been deleted.

`migrations/001_initial.sql` replaces it, generated from the live schema. This
test is what keeps it honest — add a column in `fetch_jobs.db()` and this fails
until the migration has it too, in the same commit rather than three weeks later
in the middle of a data copy.

Reads the migration as TEXT rather than connecting to Postgres, so it runs
offline, in CI, and without credentials.

Since phase I there is no persistent jobs.db to read either: Neon is the
database and the local file is retired. So the SQLite side is built FRESH in a
temporary file by calling fetch_jobs.db() itself. That is strictly better than
what it did before — it compares the migration against the DDL that actually
creates tables, rather than against whatever a long-lived local file had
accumulated, which could have drifted from the code in its own right.
"""
import glob
import io
import os
import re
import sqlite3
import sys
import tempfile
from console import utf8_stdout

# EVERY migration, not just the first one. 001 is the Postgres port of a schema
# fetch_jobs.py creates in SQLite, and it is what this test was written for.
# Everything from 002 on is owned by the APP — no Python creates any of it — and
# was invisible here until this glob, which meant a table could be added to a
# migration and never be checked against anything at all.
MIGRATIONS = sorted(glob.glob(os.path.join("migrations", "*.sql")))

# Tables that exist only in the migrations, never in fetch_jobs.db().
#
#   contacts / outreach   created by 001 for the hosted phase, back when
#                         contacts.csv and outreach/ were files on this machine.
#   interactions          002. What has actually happened with each person.
#   settings              002. Small editable text the app owns — the outreach
#                         templates.
#   role_events           003. What happened to an application after "applied".
#   sf86_entries          004. The SF-86 evidence pack. Holds OTHER PEOPLE'S
#                         details -- supervisors, foreign contacts -- which is
#                         precisely why it is a table and never a file.
#   manual_applications   005. Applications to windows the fetcher cannot see --
#   manual_application_   consulting, VC, big-tech APM. The events table is
#     events              column-for-column role_events, so days-in-stage is
#                         computed by the same function for both kinds.
#   profile               008. The twenty-odd fields every application form
#                         asks for -- legal name, address, phone, GPA. It is
#                         NOT profile.json: that file is who the owner IS and goes
#                         into the scorer's prompt, while this is contact detail
#                         they paste into forms and must be editable from the
#                         deployed app, which a file in the repo cannot be.
#                         Single row, keyed 'me'.
#   daily_availability    009. How many hours he has on a given day. The ladder
#                         knew what every task COSTS and never what he HAS, so
#                         it offered a three-hour composite on a forty-minute
#                         evening. One row per day; unanswered is a real state.
#   pipeline_status       009. What the last cron run did, written by the
#                         workflow itself. The freshness stamp reads the newest
#                         job row, which cannot tell a failed run apart from a
#                         run with nothing new to fetch.
#   pipeline_runs         021. EVERY run, append-only, keyed on the Actions
#                         run URL. pipeline_status above holds one row and is
#                         overwritten each morning, so it cannot answer the
#                         question the digest most needs: did the run happen
#                         at all. A run that dies before reporting leaves
#                         yesterday's success sitting there looking current.
#                         Written by the same node step, so it is app-owned
#                         for the same reason.
#   notifications         010. What has been emailed, so nothing is emailed
#                         twice. `fired` carries each trigger key WITH its
#                         threshold, which is what lets a closing window speak
#                         at 7 days, again at 3, again at 1, and stay quiet on
#                         the days between.
#   role_flags            007. A role or a company the owner has marked as the wrong
#                         graduating cycle. It could have been a column on
#                         `jobs`, and deliberately is not: `jobs` belongs to
#                         fetch_jobs.py, this test fails on any column a
#                         migration adds there that fetch_jobs.db() does not
#                         also create, and a column on `jobs` would therefore
#                         have broken the build on the very next commit. It is
#                         also his judgement rather than the board's, which is
#                         the same reason every other table here exists.
#
# fetch_jobs.py owns the SQLite schema and this pass may not touch it, so every
# migration from 002 on creates its tables on BOTH backends itself. That is why
# applymigration.mjs goes through its own connection instead of talking to Neon
# the way runsql.mjs does.
POSTGRES_ONLY = {"contacts", "outreach", "interactions", "settings",
                 "role_events", "sf86_entries",
                 "manual_applications", "manual_application_events",
                 "role_flags", "profile",
                 "daily_availability", "pipeline_status", "notifications",
                 "pipeline_runs",
                 # 022. What the owner actually APPLIED to, pasted in by hand
                 # from an external bot's log, plus a row per import attempt.
                 # Owned by the app like the rest of this list: no Python
                 # creates them, and fetch_jobs.py has no reason to -- the
                 # fetcher records what boards published, not what the owner
                 # submitted.
                 "applied_apps", "applied_imports",
                 # 023. An apply flow that cannot be completed -- an hCaptcha
                 # loop, a careers site answering 406 -- against one posting or
                 # one application window. The owner's observation about a form,
                 # not anything the board published, so fetch_jobs.py has no
                 # reason to create it. A column on `jobs` would have failed
                 # this very test on the next commit.
                 "blocked_applies",
                 # The Ask box's cost log. Owned by the app like the rest of
                 # this list: no Python creates it, and fetch_jobs.db() has no
                 # reason to — the CLI never asks a question.
                 "ask_queries"}


def sqlite_tables():
    """The schema fetch_jobs.db() creates, in a throwaway file.

    JOBOPS_LOCAL_DB=1 forces the SQLite path even though DATABASE_URL is set;
    fetch_jobs.DB names the file. Both are restored afterwards so importing this
    test cannot change how anything else in the process talks to the database.
    """
    import fetch_jobs
    tmp = os.path.join(tempfile.mkdtemp(prefix="jobops-parity-"), "schema.db")
    old_db, old_flag = fetch_jobs.DB, os.environ.get("JOBOPS_LOCAL_DB")
    fetch_jobs.DB = tmp
    os.environ["JOBOPS_LOCAL_DB"] = "1"
    try:
        fetch_jobs.db().close()
    finally:
        fetch_jobs.DB = old_db
        if old_flag is None:
            os.environ.pop("JOBOPS_LOCAL_DB", None)
        else:
            os.environ["JOBOPS_LOCAL_DB"] = old_flag

    con = sqlite3.connect(tmp)
    out = {}
    for (name,) in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ):
        out[name] = {r[1] for r in con.execute("PRAGMA table_info(%s)" % name)}
    return out


def migration_tables(paths=None):
    """Every table every migration creates.

    Concatenated in filename order, so a later migration's definition of a table
    wins: 002 re-declares `contacts` carrying the three columns it adds, and
    that combined view is what the database actually ends up holding.
    """
    sql = "\n".join(
        io.open(f, encoding="utf-8").read() for f in (paths or MIGRATIONS))
    # Strip comments so a column named inside one is never counted.
    sql = re.sub(r"--[^\n]*", "", sql)
    out = {}
    for m in re.finditer(
        r"CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.*?)\n\);", sql, re.S | re.I
    ):
        name, body = m.group(1), m.group(2)
        cols = set()
        depth = 0
        for line in body.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            # skip table-level constraints
            if re.match(r"(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b", stripped, re.I):
                continue
            cm = re.match(r"(\w+)\s+\S", stripped)
            if cm:
                cols.add(cm.group(1))
        out[name] = cols

    # COLUMNS ADDED BY ALTER, which this parser could not see at all.
    #
    # It read CREATE TABLE only, so a migration that grows an existing table --
    # the normal way to add a column once a table exists -- contributed nothing,
    # and the check reported the column as "in SQLite, missing from the
    # migration" however correct the migration was. 014 is the first to use
    # ALTER; every future one will too, and a parity check blind to half the
    # statements it is meant to read is worse than none, because it is trusted.
    for m in re.finditer(
        r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)",
        sql, re.I,
    ):
        table, col = m.group(1), m.group(2)
        # Only for a table some migration actually creates; an ALTER against an
        # unknown table is a migration bug and should not invent an entry here.
        if table in out:
            out[table].add(col)
    return out


def main():
    utf8_stdout()
    try:
        sq = sqlite_tables()
    except sqlite3.Error as e:
        print("cannot read %s (%s) — skipping" % (DB, e))
        return 0
    pg = migration_tables()

    fails = []
    checked = 0
    for name, cols in sorted(sq.items()):
        if name not in pg:
            fails.append("table %r is in SQLite but not in the migration" % name)
            continue
        checked += 1
        missing = cols - pg[name]
        extra = pg[name] - cols
        if missing:
            fails.append("%s: in SQLite, MISSING from the migration: %s"
                         % (name, ", ".join(sorted(missing))))
        if extra:
            fails.append("%s: in the migration, not in SQLite: %s"
                         % (name, ", ".join(sorted(extra))))

    for name in sorted(set(pg) - set(sq) - POSTGRES_ONLY):
        fails.append("table %r is in the migration but not in SQLite" % name)

    print("%d tables compared across %d migration file%s, %d app-only (%s)"
          % (checked, len(MIGRATIONS), "" if len(MIGRATIONS) == 1 else "s",
             len(POSTGRES_ONLY), ", ".join(sorted(POSTGRES_ONLY))))
    # A glob that matched nothing would compare an empty migration against the
    # live schema, and the only reason that fails loudly is that the SQLite side
    # is not empty. Assert the precondition rather than relying on that.
    if not MIGRATIONS:
        print("\n  NO MIGRATION FILES FOUND under migrations/. Nothing was compared.")
        return 1
    if fails:
        print("\nSCHEMA DRIFT:")
        for f in fails:
            print("  " + f)
        print("\n  Add the column to the right file under migrations/ and re-run.")
        print("  Read: %s" % ", ".join(MIGRATIONS))
        return 1
    print("SQLite and the migration agree on every table and column")
    return 0


if __name__ == "__main__":
    sys.exit(main())
