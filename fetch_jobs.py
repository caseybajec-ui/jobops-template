#!/usr/bin/env python3
"""
fetch_jobs.py — pull open roles from target companies' public ATS boards into a local DB.

Usage:
  python fetch_jobs.py fetch                 # poll every company in companies.yaml
  python fetch_jobs.py discover <name>       # find which ATS a company uses (tries all three)
  python fetch_jobs.py stats                 # what's in the DB

Supported ATSs (all have unauthenticated JSON endpoints):
  Greenhouse: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
  Lever:      https://api.lever.co/v0/postings/{slug}?mode=json
  Ashby:      https://api.ashbyhq.com/posting-api/job-board/{slug}
"""
import argparse
import datetime as dt
import hashlib
import html
import io
import itertools
import json
import os
import re
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import yaml

from storage_policy import KEEP_FULL_CHARS, store_description, tracked_boards
from blockers import classify as classify_blockers
from console import utf8_stdout
from paths import repo

# Load ANTHROPIC_API_KEY (and JOBOPS_MODEL, if set) from .env so the key is
# available every session without exporting it by hand. Never print the value.
try:
    from dotenv import load_dotenv
except ImportError:

    def load_dotenv(*_args, **_kwargs):
        print(
            "warning: python-dotenv not installed; "
            "run pip install -r requirements.txt",
            file=sys.stderr,
        )


load_dotenv()

# ANCHORED TO THIS FILE, not to the working directory.
#
# This was the bare string "jobs.db", which sqlite3.connect() resolves against
# whatever the cwd happens to be — and sqlite3 CREATES a file when it does not
# find one. So running anything that imports this module from a subdirectory
# silently made a second, empty database instead of opening the real one. It
# produced a stray three separate times in one session: twice at the repo root
# from web/, and once on the Desktop from the repo root via web/lib/driver.js's
# matching "../jobs.db".
#
# Every symptom was quiet. The stray is empty, so a read finds no rows rather
# than erroring — "no scored rows found" reads as a data problem — and the
# guard in test_nothing_private_staged.py then refuses the next commit with
# "more than one database in the tree", which is the first LOUD sign and comes
# a long way from the cause.
#
# fetch_jobs.py sits at the repo root, so its own directory is the anchor.
# test_schema_parity.py reassigns this to an absolute temp path and that still
# works: nothing re-anchors an override.
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs.db")
UA = {"User-Agent": "jobops/0.1 (personal job-search tool)"}
TIMEOUT = 20

# Modest concurrency — these are other people's job boards, not ours to hammer.
BOARD_WORKERS = 6      # companies polled in parallel
DETAIL_WORKERS = 4     # per-posting detail fetches within one board (Rippling)
MAX_RETRIES = 3
BACKOFF_BASE = 1.5     # seconds; doubles per attempt

# Postings written per INSERT, and per COMMIT. One round trip to Neon each,
# instead of one per posting.
#
# 250 x 17 columns = 4,250 bound parameters, comfortably inside both backends'
# limits (Postgres 65,535; SQLite 32,766 since 3.32, and 999 on builds old
# enough that a smaller batch would be the least of the problems).
#
# Sized so a killed run loses very little: a batch is one round trip, so the
# work at risk is a fraction of a second, not the whole fetch.
BATCH_ROWS = 250

# Keys per touch statement. A touch carries no description, so the payload is
# the key list itself — 11,494 keys at ~40 bytes would be 460 KB in a single
# statement and 11,494 bound parameters. 1,000 keeps each one small and well
# inside every parameter limit.
TOUCH_ROWS = 1000

_UPSERT_HEAD = """INSERT INTO jobs
     (key, source, slug, ext_id, company, title, location,
      url, description, posted_at, tier, candidate,
      first_seen, last_seen, closed_at, display_name, comp_raw,
      blockers, blockers_full_text, content_hash)
   VALUES """
_UPSERT_ROW = "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)"
# first_seen is NOT in the DO UPDATE list. It records when this tool first saw
# the posting and must survive every later fetch — it is the basis of "new since
# your last visit" and of the class-year posting forecast.
_UPSERT_TAIL = """
   ON CONFLICT (key) DO UPDATE SET
     last_seen=excluded.last_seen, closed_at=NULL,
     location=excluded.location, candidate=excluded.candidate,
     title=excluded.title, url=excluded.url,
     description=excluded.description,
     posted_at=excluded.posted_at,
     display_name=excluded.display_name,
     comp_raw=excluded.comp_raw,
     blockers=excluded.blockers,
     blockers_full_text=excluded.blockers_full_text,
     content_hash=excluded.content_hash"""


# FIELDS OF THE FETCHED POSTING THAT GO INTO THE HASH.
#
# A NAMED LIST rather than a tuple inline in the function, so a test can compare
# it against the columns _UPSERT_TAIL actually writes. That comparison is the
# whole safety of this optimisation: a column that the upsert can change but the
# hash does not cover would stop being written the moment its row's other fields
# settled -- silently, permanently, and with no symptom except stale data nobody
# thinks to distrust.
#
# `display_name`, `candidate` and the keep-full decision are hashed too but are
# not fields OF the posting, so they are appended separately below.
_HASHED_JOB_FIELDS = ("company", "title", "location", "url", "description",
                      "posted_at", "comp_raw")

# Columns in the DO UPDATE list that are deliberately NOT hashed, with the
# reason. Anything else appearing there must be in the hash or the test fails.
_UNHASHED_OK = {
    # Change every run by definition; hashing them would make every hash differ
    # and defeat the comparison. Moved by the cheap touch statement instead.
    "last_seen", "closed_at",
    # Derived from hashed inputs: blockers come from title + description + the
    # keep-full decision, and content_hash is the hash itself.
    "blockers", "blockers_full_text", "content_hash",
}


def _content_hash(j, cand, disp, full):
    """A fingerprint of everything the upsert would write for one posting.

    WHY THIS EXISTS. The nightly fetch wrote every open role every morning
    whether or not anything about it had changed -- 11,494 rows carrying a mean
    6,358-character description, about 77 MB of payload per run, roughly 2.3 GB
    a month before a single backfill. Neon's 5 GB monthly transfer allowance ran
    out and put compute at risk of suspension.

    Almost none of it changes. The first fetch after the description backfill
    moved 73 descriptions out of ~9,900 -- and 52 of those by exactly one
    character, a template edit on one board. Writing the other 99% again every
    night bought nothing.

    EVERY FIELD THE UPSERT TOUCHES IS IN HERE, and that is the whole
    correctness condition: a field that can be written but is not hashed would
    change in the source and never reach the database, silently, forever. The
    list is kept beside _UPSERT_TAIL for that reason, and test_fetch_hash.py
    fails if the two drift apart.

    `last_seen` and `closed_at` are deliberately NOT hashed. They change on
    every run by definition, so including them would make every hash differ and
    defeat the whole thing; they are updated separately by the cheap touch
    statement, which carries no description.

    `cand` and `full` are included because they decide what gets STORED rather
    than being stored themselves: a title-filter tune that flips `candidate`
    changes the description that would be written, and `full` decides whether
    it is whole or truncated. A blocker verdict computed from that text moves
    with them too.

    128 bits, not 64. A collision here is not a crash, it is a changed posting
    that never gets written -- a silent wrong answer of the kind this project
    keeps finding weeks later. The extra 16 bytes a row costs 180 KB across the
    whole table.
    """
    parts = [j.get(f) for f in _HASHED_JOB_FIELDS]
    parts += [disp, str(int(cand)), str(int(bool(full)))]
    h = hashlib.sha256()
    for part in parts:
        # NULL AND EMPTY STRING ARE DIFFERENT STATES and must hash differently.
        # Mapping None to "" made them identical, so a field being CLEARED to
        # NULL would leave the hash unchanged and the row would never be
        # rewritten -- the empty string would sit in the database forever. A
        # one-byte marker separates them.
        if part is None:
            h.update(b"N\x00")
            continue
        b = str(part).encode("utf-8")
        h.update(b"S")
        # A LENGTH PREFIX, so that ("ab", "c") and ("a", "bc") do not collide.
        h.update(str(len(b)).encode("ascii"))
        h.update(b"\x00")
        h.update(b)
    return h.hexdigest()[:32]


def _get(url, **kw):
    """GET with backoff on 429 and 5xx. Client errors raise immediately —
    retrying a 404 just wastes time and looks like abuse.
    """
    kw.setdefault("headers", UA)
    kw.setdefault("timeout", TIMEOUT)
    last = None
    for attempt in range(MAX_RETRIES):
        try:
            r = requests.get(url, **kw)
            if r.status_code == 429 or r.status_code >= 500:
                last = requests.HTTPError(f"HTTP {r.status_code}", response=r)
                retry_after = r.headers.get("retry-after")
                delay = (float(retry_after) if retry_after and retry_after.isdigit()
                         else BACKOFF_BASE * (2 ** attempt))
                if attempt < MAX_RETRIES - 1:
                    time.sleep(min(delay, 30))
                    continue
                r.raise_for_status()
            r.raise_for_status()
            return r
        except requests.HTTPError:
            raise
        except requests.RequestException as e:
            last = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(BACKOFF_BASE * (2 ** attempt))
                continue
            raise
    if last:
        raise last


# ---------- storage ----------

def db():
    """The database, whichever one is configured.

    Postgres when DATABASE_URL_UNPOOLED is set, otherwise the local jobs.db.
    JOBOPS_LOCAL_DB=1 forces SQLite even when the URL is present.

    ON POSTGRES THE SCHEMA IS NOT CREATED HERE. migrations/001_initial.sql owns
    it, and every statement below is SQLite-only anyway: AUTOINCREMENT is a
    syntax error, PRAGMA does not exist, and PRAGMA table_info is how the
    column-migration checks work. Two places defining one schema is how
    schema.sql drifted twenty columns behind reality; there is one now, and
    test_schema_parity.py fails when it and SQLite disagree.
    """
    import pgdb
    if pgdb.using_pg():
        return pgdb.connect()

    con = sqlite3.connect(DB)
    # Fail fast and loudly if another fetch/score process holds the write lock.
    # Two overlapping fetches silently crawl for hours instead of erroring —
    # a 2.5-minute run once took 110 minutes that way, and it looked like a
    # code regression rather than what it was.
    con.execute("PRAGMA busy_timeout = 5000")
    con.execute(
        """CREATE TABLE IF NOT EXISTS jobs (
            key         TEXT PRIMARY KEY,   -- source:slug:ext_id
            source      TEXT, slug TEXT, ext_id TEXT,
            company     TEXT, title TEXT, location TEXT, url TEXT,
            description TEXT, posted_at TEXT,
            tier        INTEGER,
            candidate   INTEGER,            -- passed title filter
            first_seen  TEXT, last_seen TEXT, closed_at TEXT
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS scores (
            key TEXT PRIMARY KEY, score INTEGER, tier TEXT, model TEXT,
            reasons TEXT, gaps TEXT, evidence_ids TEXT, angle TEXT,
            raw TEXT, scored_at TEXT
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS score_runs (
            key      TEXT,
            run_idx  INTEGER,
            score    INTEGER,
            tier     TEXT,
            reasons  TEXT, gaps TEXT, evidence_ids TEXT, angle TEXT,
            raw      TEXT,
            model    TEXT, effort TEXT, at TEXT,
            PRIMARY KEY (key, run_idx)
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS applications (
            key TEXT PRIMARY KEY, stage TEXT, notes TEXT,
            contact TEXT, applied_at TEXT, next_action TEXT, next_action_at TEXT,
            updated_at TEXT
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS batches (
            batch_id     TEXT PRIMARY KEY,
            stage        TEXT,      -- 'triage' | 'score'
            model        TEXT,
            n            INTEGER,
            submitted_at TEXT,
            collected_at TEXT,
            keymap       TEXT,      -- JSON {custom_id: job key}
            -- MEASURED usage, filled in at collect time from the API. Estimates
            -- from mean token shapes read 35% low because they priced no cache
            -- traffic at all; these are the real counts, so the cost meter can
            -- report measured spend for finished batches and estimate only for
            -- ones still in flight.
            in_tok       INTEGER,
            out_tok      INTEGER,
            cache_w_tok  INTEGER,
            cache_r_tok  INTEGER
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS triage_history (
            key            TEXT,
            prompt_version INTEGER,
            model          TEXT,
            verdict        INTEGER,
            reason         TEXT,
            at             TEXT
        )"""
    )
    # Stage-1 triage verdict, stored so nothing is ever re-triaged.
    # NULL = not yet triaged, 1 = plausible, 0 = not plausible.
    cols = {r[1] for r in con.execute("PRAGMA table_info(jobs)")}
    if "triage" not in cols:
        con.execute("ALTER TABLE jobs ADD COLUMN triage INTEGER")
        con.execute("ALTER TABLE jobs ADD COLUMN triage_reason TEXT")
        con.execute("ALTER TABLE jobs ADD COLUMN triaged_at TEXT")
        con.commit()
    bcols = {r[1] for r in con.execute("PRAGMA table_info(batches)")}
    if "in_tok" not in bcols:
        for c in ("in_tok INTEGER", "out_tok INTEGER",
                  "cache_w_tok INTEGER", "cache_r_tok INTEGER"):
            con.execute("ALTER TABLE batches ADD COLUMN %s" % c)
        con.commit()
    scols = {r[1] for r in con.execute("PRAGMA table_info(scores)")}
    if "score_spread" not in scols:
        # A single sample is noise at +/-10 run-to-run variance. scores.score is
        # the MEDIAN of n_samples runs; the spread is itself a signal, since a
        # wide one means the scorer is unsure and the reasons deserve reading.
        for c in ("score_lo INTEGER", "score_hi INTEGER",
                  "score_spread INTEGER", "n_samples INTEGER", "effort TEXT"):
            con.execute("ALTER TABLE scores ADD COLUMN %s" % c)
        con.commit()
    if "comp_min" not in cols:
        for c in ("comp_min INTEGER", "comp_max INTEGER",
                  "comp_currency TEXT", "comp_source TEXT",
                  "comp_raw TEXT", "entry_level TEXT"):
            con.execute("ALTER TABLE jobs ADD COLUMN %s" % c)
        con.commit()
    if "category" not in cols:
        # Persisted rather than derived in the UI, so the app never has to
        # reimplement classification logic that lives in the pipeline.
        con.execute("ALTER TABLE jobs ADD COLUMN category TEXT")
        con.execute("ALTER TABLE jobs ADD COLUMN start_window TEXT")
        con.commit()
    if "display_name" not in cols:
        con.execute("ALTER TABLE jobs ADD COLUMN display_name TEXT")
        con.commit()
    if "clearance_status" not in cols:
        con.execute("ALTER TABLE jobs ADD COLUMN clearance_status TEXT")
        con.commit()
    if "content_hash" not in cols:
        # The mirror of migrations/015_content_hash.sql. NULL means the row was
        # written before this column existed and must take the full write path;
        # see _content_hash() for why it is not backfilled server-side.
        con.execute("ALTER TABLE jobs ADD COLUMN content_hash TEXT")
        con.commit()
    if "blockers" not in cols:
        # The mirror of migrations/014_blockers.sql, which owns the Postgres
        # side. blockers is a JSON array; NULL means the classifier has not run
        # on this row, which is NOT the same as '[]' meaning it ran and found
        # nothing. blockers_full_text is 1 when the description was whole at the
        # time, 0 when storage_policy had already truncated it — without which a
        # tagless row cannot be told apart from an unread one.
        con.execute("ALTER TABLE jobs ADD COLUMN blockers TEXT")
        con.execute("ALTER TABLE jobs ADD COLUMN blockers_full_text INTEGER")
        con.commit()
    if "yoe" not in cols:
        # Stored, with the raw matched phrase, so a bad regex is visible in the
        # data rather than silently killing roles.
        con.execute("ALTER TABLE jobs ADD COLUMN yoe INTEGER")
        con.execute("ALTER TABLE jobs ADD COLUMN yoe_text TEXT")
        con.commit()
    if "gate_name" not in cols:
        # Same rule as yoe_text, generalised to EVERY gate. A gate that kills a
        # role must record the literal substring that decided it and which field
        # that substring came from, so a false positive is visible in the data
        # instead of being an invisible deletion.
        #
        #   gate_name   which gate fired ('location', 'contract', ...) or NULL
        #   gate_text   the exact matched phrase, verbatim from the source text
        #   gate_field  where it was matched ('location', 'title', 'description')
        for c in ("gate_name TEXT", "gate_text TEXT", "gate_field TEXT"):
            con.execute("ALTER TABLE jobs ADD COLUMN %s" % c)
        con.commit()
    # Things the owner does, as opposed to things the pipeline found.
    #
    # INSERT-ONLY. Nothing here is ever updated or deleted: the latest row for a
    # (key, kind) wins, and an 'undo' row reverses it. That gives history for
    # free and keeps the never-delete-before-verifying rule without effort.
    #
    # `id` is the ordering, NOT `at`. Two clicks inside the same second produce
    # identical ISO timestamps, and "latest" then depends on which row the
    # planner happens to return — a save/unsave pair would settle at random.
    con.execute(
        """CREATE TABLE IF NOT EXISTS actions (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            key  TEXT NOT NULL,   -- role GROUP key, company slug, or item id
            kind TEXT NOT NULL,   -- save | hide | applied | done | target
            at   TEXT NOT NULL,
            note TEXT,
            meta TEXT             -- JSON; {"undo": true} reverses the row above
        )"""
    )
    con.execute("CREATE INDEX IF NOT EXISTS actions_key ON actions(key, kind, id)")

    # One row per load of Daily. "New since your last visit" reads the previous
    # one, so the current load never marks its own roles as already seen.
    con.execute(
        """CREATE TABLE IF NOT EXISTS visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL
        )"""
    )

    # What each board actually returned, one row per board per run. The mirror
    # of migrations/013_board_fetches.sql, which owns the Postgres side.
    #
    # IT BELONGS HERE, not on the app-only list, because cmd_fetch WRITES it and
    # cmd_fetch runs against SQLite under JOBOPS_LOCAL_DB=1. The write sits in a
    # try/except that must never fail a fetch, so a missing table would not
    # error — it would just silently record nothing, and the anomaly flag would
    # read an empty history and report every board as fine. That is the exact
    # green-on-nothing this table exists to prevent, one layer down.
    #
    # n_roles is NULL on an error and 0 on a clean empty board. Those are
    # different observations and collapsing them loses the only signal that
    # distinguishes a broken slug from a small company.
    con.execute(
        """CREATE TABLE IF NOT EXISTS board_fetches (
            id           TEXT PRIMARY KEY,   -- <day>:<source>:<slug>
            day          TEXT NOT NULL,
            source       TEXT NOT NULL,
            slug         TEXT NOT NULL,
            display_name TEXT,
            n_roles      INTEGER,
            error        TEXT,
            fetched_at   TEXT NOT NULL
        )"""
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS board_fetches_board "
        "ON board_fetches (source, slug, day)"
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS board_fetches_day ON board_fetches (day)"
    )

    # Pages with no machine-readable board. Mirror of
    # migrations/017_watched_pages.sql.
    #
    # HERE RATHER THAN ON THE APP-ONLY LIST because watch_pages.py is a python
    # CLI and writes both of these, so the local SQLite path has to be able to
    # create them -- same reason apply_packs sits here.
    con.execute(
        """CREATE TABLE IF NOT EXISTS watched_pages (
            url             TEXT PRIMARY KEY,
            label           TEXT NOT NULL,
            company         TEXT,
            category        TEXT,
            last_hash       TEXT,
            last_changed_at TEXT,
            last_checked_at TEXT,
            status_regex    TEXT,
            last_status_hit INTEGER NOT NULL DEFAULT 0,
            last_error      TEXT,
            fail_streak     INTEGER NOT NULL DEFAULT 0,
            last_diff       TEXT,
            notes           TEXT,
            created_at      TEXT
        )"""
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS watched_pages_changed "
        "ON watched_pages (last_changed_at DESC)"
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS watched_snapshots (
            url        TEXT PRIMARY KEY,
            last_lines TEXT,
            saved_at   TEXT
        )"""
    )

    # The application pack for one role. Mirror of migrations/016_apply_packs.sql.
    #
    # HERE RATHER THAN ON THE APP-ONLY LIST because apply_packs.py writes it and
    # that CLI runs against SQLite under JOBOPS_LOCAL_DB=1. `variant` is NULL
    # when the company category has no rule, never guessed; `used_at` is NULL
    # until the owner copies a field, which is what separates a pack they worked
    # from one nobody opened.
    con.execute(
        """CREATE TABLE IF NOT EXISTS apply_packs (
            key               TEXT PRIMARY KEY,
            variant           TEXT,
            variant_reason    TEXT,
            cover_note        TEXT,
            why_company       TEXT,
            why_role          TEXT,
            project_story     TEXT,
            biggest_challenge TEXT,
            model             TEXT,
            batch_id          TEXT,
            created_at        TEXT NOT NULL,
            used_at           TEXT,
            raw               TEXT,
            -- The second-pass critic. critic_at records that a verdict was
            -- READ; critic_note what it said. Both set means refused, and the
            -- note names the claim so a refusal can be argued with.
            critic_at         TEXT,
            critic_note       TEXT
        )"""
    )
    # Names staged for the owner to promote. Mirror of
    # migrations/020_suggested_contacts.sql. NOTHING HERE IS A CONTACT.
    con.execute(
        """CREATE TABLE IF NOT EXISTS suggested_contacts (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            company      TEXT,
            company_slug TEXT,
            title        TEXT,
            headline     TEXT,
            location     TEXT,
            profile_url  TEXT,
            school       TEXT,
            source       TEXT NOT NULL,
            source_url   TEXT,
            rank         INTEGER,
            rank_reason  TEXT,
            raw          TEXT,
            promoted_at  TEXT,
            skipped_at   TEXT,
            created_at   TEXT NOT NULL
        )"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS reader_runs (
            id       TEXT PRIMARY KEY,
            ran_at   TEXT NOT NULL,
            searches INTEGER,
            found    INTEGER,
            skipped  TEXT,
            red      INTEGER NOT NULL DEFAULT 0
        )"""
    )
    # Interview prep, one row per role, written only when a status reaches
    # interview. Mirror of migrations/019_prep_packs.sql. Here rather than on
    # the app-only list because prep_pack.py is a python CLI that writes it.
    con.execute(
        """CREATE TABLE IF NOT EXISTS prep_packs (
            key        TEXT PRIMARY KEY,
            model      TEXT,
            created_at TEXT,
            summary    TEXT,
            questions  TEXT,
            answers    TEXT,
            ask_them   TEXT,
            position   TEXT,
            raw        TEXT,
            note       TEXT
        )"""
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS apply_packs_used ON apply_packs (used_at)"
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS apply_packs_batch ON apply_packs (batch_id)"
    )

    # On-you items. Seeded from daily.yaml once, then owned here — see
    # seed_items() for why the migration is safe to run repeatedly.
    con.execute(
        """CREATE TABLE IF NOT EXISTS items (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            note       TEXT,
            due_at     TEXT,
            created_at TEXT,
            source     TEXT,      -- 'seed' | 'user' | 'auto' | 'split'
            -- How long the thing actually takes. The Daily ladder will not put
            -- an item at the top that does not fit the time available, and a
            -- model must never guess this: it is a stated fact or it is absent.
            minutes    INTEGER,
            -- PRE-AUTHORED smaller steps, JSON: ["...", {"text": "...",
            -- "minutes": 15}]. "Stuck" splits an item into these. They are
            -- written by hand in daily.yaml precisely so nothing generates them:
            -- a model-invented breakdown of "assemble the SF-86 pack" would cost
            -- money to be wrong about something the owner signs under penalty.
            steps      TEXT
        )"""
    )
    item_cols = {r[1] for r in con.execute("PRAGMA table_info(items)")}
    for name, decl in (("minutes", "INTEGER"), ("steps", "TEXT")):
        if name not in item_cols:
            con.execute("ALTER TABLE items ADD COLUMN %s %s" % (name, decl))
    con.commit()
    if "class_fit" not in cols:
        # Which graduating class a posting is for. The owner graduates at the
        # date in profile.json, and a new-grad role for the class before reads
        # as a perfect match to every other rule in the pipeline — same phrase
        # in the title, same seniority, same pay band. class_text stores the
        # deciding phrase, same rule as gate_text.
        for c in ("class_fit TEXT", "class_reason TEXT", "class_text TEXT",
                  "start_year INTEGER", "start_month INTEGER", "class_year INTEGER"):
            con.execute("ALTER TABLE jobs ADD COLUMN %s" % c)
        con.commit()
    return con


def funnel(con):
    """Where roles are dying. Printed after fetch, triage, and score."""
    q = lambda s: con.execute(s).fetchone()[0]
    open_ = "closed_at IS NULL"
    rows = [
        ("total open", q(f"SELECT COUNT(*) FROM jobs WHERE {open_}")),
        ("passed title filter", q(f"SELECT COUNT(*) FROM jobs WHERE {open_} AND candidate=1")),
        ("triaged", q(f"SELECT COUNT(*) FROM jobs WHERE {open_} AND candidate=1 AND triage IS NOT NULL")),
        ("survived triage", q(f"SELECT COUNT(*) FROM jobs WHERE {open_} AND candidate=1 AND triage=1")),
        ("scored", q(f"SELECT COUNT(*) FROM scores s JOIN jobs j USING(key) WHERE j.closed_at IS NULL")),
        ("scored 60+", q(f"SELECT COUNT(*) FROM scores s JOIN jobs j USING(key) WHERE j.closed_at IS NULL AND s.score>=60")),
    ]
    width = max(len(n) for n, _ in rows)
    print("\nFunnel")
    prev = None
    for name, n in rows:
        drop = ""
        if prev is not None and prev > 0:
            drop = f"  ({n / prev * 100:.0f}% of previous)"
        print(f"  {name:<{width}}  {n:6d}{drop}")
        prev = n

    # ROLES IN FLIGHT ARE NOT UNSCORED, and the gap between "survived triage"
    # and "scored" now contains some of them.
    #
    # Scoring submits a batch and exits, so for up to 24 hours a role can be
    # paid for and have no score row. `scored` counts rows and therefore
    # undercounts by exactly that many — which reads as "these roles were
    # skipped" unless it is said out loud. It is a note rather than a funnel
    # row because it is not a stage: those roles are still inside `survived
    # triage`, and giving it a percentage-of-previous would be a third number
    # drawn from a different population.
    try:
        n_flight = con.execute(
            "SELECT COUNT(*) FROM batches WHERE stage='score' "
            "AND collected_at IS NULL").fetchone()[0]
        if n_flight:
            reqs = con.execute(
                "SELECT COALESCE(SUM(n), 0) FROM batches WHERE stage='score' "
                "AND collected_at IS NULL").fetchone()[0]
            print(f"\n  {n_flight} batch(es) submitted and not yet collected "
                  f"({reqs} request(s)). Those roles are paid for and have no "
                  f"score row yet, so they are NOT in 'scored' above.")
    except Exception as e:                       # pragma: no cover - diagnostic
        print(f"\n  (could not read in-flight batches: {e})")
    return con


# ---------- helpers ----------

def strip_html(s: str) -> str:
    """Strip markup to plain text.

    Unescape BEFORE stripping, and loop. Greenhouse returns HTML-escaped
    content (`&lt;h2&gt;`), so unescaping last — as this did originally — turned
    entities back into tags *after* the stripping pass had already run. Every
    Greenhouse description was landing in the DB about 17% raw markup, which
    wasted the triage window on `<h2><strong>` noise and broke text matching.
    """
    if not s:
        return ""
    for _ in range(3):  # entities can be double-escaped; converge, don't guess
        prev = s
        s = html.unescape(s)
        s = re.sub(r"<(br|/p|/li|/div|/h\d|/tr)[^>]*>", "\n", s, flags=re.I)
        s = re.sub(r"<[^>]+>", "", s)
        if s == prev:
            break
    s = re.sub(r"[ \t]+", " ", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _term_re(term: str):
    """Word-boundary matcher for a filter term.

    Bare substring matching silently over-excluded: "intern" killed every
    "International" role, "iv" killed "Activity" and "Drive", and "lead" killed
    "Leadership" — which defeated the "leadership development" include term
    entirely. Boundaries are non-alphanumeric so multi-word terms and level
    tokens like a standalone "I" or "2027" still work.
    """
    return re.compile(r"(?<![a-z0-9])" + re.escape(term.lower()) + r"(?![a-z0-9])")


_TERM_CACHE = {}


def _matches(text: str, terms) -> bool:
    for term in terms:
        t = term.lower()
        if t not in _TERM_CACHE:
            _TERM_CACHE[t] = _term_re(t)
        if _TERM_CACHE[t].search(text):
            return True
    return False


def title_ok(title: str, inc, exc, senior=None, level=None, protect=None) -> bool:
    """True if a title is worth spending a triage call on.

    A topic match alone is not fit: bare "engineer" matched ~700 staff-level
    hardware roles at Anduril. So a title must match a topic term AND not carry
    a senior signal. Titles with an explicit early-career level signal always
    pass; titles with no level signal either way still pass through to triage,
    because many startup roles are simply unleveled.

    `protect` exempts a title from the seniority check only. It exists because
    "Chief of Staff" — a tier-1 target — contains "staff", which is otherwise a
    reliable seniority signal ("Staff Engineer", "Staff+ Security Engineer").
    """
    t = title.lower()
    if _matches(t, exc):
        return False
    if senior and _matches(t, senior) and not (protect and _matches(t, protect)):
        return False
    if level and _matches(t, level):
        return True
    return _matches(t, inc)


# ---------- fetchers: each yields normalized dicts ----------

def fetch_greenhouse(slug):
    r = _get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
             params={"content": "true"})
    for j in r.json().get("jobs", []):
        yield {
            "source": "greenhouse", "slug": slug, "ext_id": str(j["id"]),
            "company": slug, "title": j.get("title", ""),
            "location": (j.get("location") or {}).get("name", ""),
            "url": j.get("absolute_url", ""),
            "description": strip_html(j.get("content", "")),
            "posted_at": j.get("updated_at") or j.get("first_published"),
        }


def fetch_lever(slug):
    r = _get(f"https://api.lever.co/v0/postings/{slug}", params={"mode": "json"})
    for j in r.json():
        cats = j.get("categories") or {}
        lists = "\n".join(
            f"{l.get('text','')}\n{strip_html(l.get('content',''))}" for l in j.get("lists", [])
        )
        created = j.get("createdAt")
        posted = (
            dt.datetime.fromtimestamp(created / 1000, dt.timezone.utc).isoformat(timespec="seconds")
            if created else None
        )
        yield {
            "source": "lever", "slug": slug, "ext_id": j["id"],
            "company": slug, "title": j.get("text", ""),
            "location": cats.get("location", ""),
            "url": j.get("hostedUrl", ""),
            "description": (j.get("descriptionPlain", "") + "\n" + lists).strip(),
            "posted_at": posted,
        }


def fetch_ashby(slug):
    r = _get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}",
             params={"includeCompensation": "true"})
    for j in r.json().get("jobs", []):
        if j.get("isListed") is False:
            continue
        # Ashby returns a structured compensation summary when asked for it, and
        # it was being thrown away. Ramp, OpenAI and Applied Intuition populate it
        # on most postings ("$211.4K - $290.6K"), which beats parsing prose.
        comp = (j.get("compensation") or {}).get("scrapeableCompensationSalarySummary")
        yield {
            "source": "ashby", "slug": slug, "ext_id": j["id"],
            "company": slug, "title": j.get("title", ""),
            "location": j.get("location", ""),
            "url": j.get("jobUrl", ""),
            "description": j.get("descriptionPlain") or strip_html(j.get("descriptionHtml", "")),
            "posted_at": j.get("publishedAt"),
            "comp_raw": comp,
        }


RIPPLING_API = "https://api.rippling.com/platform/api/ats/v1/board"


def _rippling_detail(slug, uid):
    try:
        d = _get(f"{RIPPLING_API}/{slug}/jobs/{uid}").json()
    except (requests.RequestException, ValueError):
        return "", None
    raw = d.get("description")
    if isinstance(raw, dict):
        # {"company": "...", "role": "..."} — role text is what matters
        raw = "\n\n".join(str(raw[k]) for k in ("role", "company") if raw.get(k))
    return strip_html(raw or ""), d.get("createdOn")


def fetch_rippling(slug, with_desc=True):
    """Rippling's own ATS — a real pattern across defense companies (Overland AI,
    Forterra). Two quirks:

    1. The board lists one entry per (job x location). One Rippling role appeared
       13 times for 13 remote states. Collapse by uuid and keep ALL locations, so
       a role open in 13 states isn't scored as though it were Idaho-only.
    2. The board endpoint carries no description, so the role text needs one extra
       GET per posting. Those run concurrently, capped by DETAIL_WORKERS.
    """
    board = _get(f"{RIPPLING_API}/{slug}/jobs").json()
    if not isinstance(board, list):
        raise ValueError("rippling board did not return a JSON array")

    merged = {}
    for j in board:
        uid = j.get("uuid")
        if not uid:
            continue
        loc = (j.get("workLocation") or {}).get("label", "")
        if uid in merged:
            if loc and loc not in merged[uid]["locations"]:
                merged[uid]["locations"].append(loc)
        else:
            merged[uid] = {"entry": j, "locations": [loc] if loc else []}

    details = {}
    if with_desc and merged:
        with ThreadPoolExecutor(max_workers=DETAIL_WORKERS) as ex:
            futs = {ex.submit(_rippling_detail, slug, uid): uid for uid in merged}
            for fut in as_completed(futs):
                details[futs[fut]] = fut.result()

    for uid, m in merged.items():
        j = m["entry"]
        desc, posted = details.get(uid, ("", None))
        yield {
            "source": "rippling", "slug": slug, "ext_id": uid,
            "company": slug, "title": j.get("name", ""),
            "location": "; ".join(m["locations"]),
            "url": j.get("url", ""),
            "description": desc,
            "posted_at": posted,
        }


FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
    "rippling": fetch_rippling,
}


# ---------- commands ----------

def filters(cfg):
    """Pull the five filter lists out of companies.yaml in title_ok() order."""
    return dict(
        inc=cfg.get("title_include", []),
        exc=cfg.get("title_exclude", []),
        senior=cfg.get("title_senior", []),
        level=cfg.get("title_level", []),
        protect=cfg.get("title_protect", []),
    )


def cmd_fetch(cfg):
    con = db()
    f = filters(cfg)
    ts = now()
    totals = {"seen": 0, "new": 0, "candidates": 0}
    seen_keys = set()
    written = 0
    touched = 0
    touch = []
    # Bytes of row payload this run actually sends, accumulated as rows
    # are built. Measured from the real rows rather than estimated after
    # the fact: an estimate that can disagree with the run is decoration.
    payload_bytes = 0
    # Every key already stored, fetched ONCE. This replaces a per-posting
    # SELECT — about 9,900 round trips on a full fetch — with a single query and
    # a set lookup. It is also what tells a genuinely new posting from a
    # refreshed one now that the write is a single upsert.
    #
    # THE HASH COMES BACK WITH THE KEY, and it is what stops this fetch writing
    # 11,494 full descriptions every morning. See _content_hash below.
    existing = {r[0]: r[1] for r in
                con.execute("SELECT key, content_hash FROM jobs")}
    existing_keys = set(existing)
    # Keys the owner has ever acted on. They keep full text even if a title-filter
    # tune has since made them non-candidates — see storage_policy. Loaded once
    # for the same reason existing_keys is, and it is a small table.
    acted_keys = {r[0] for r in con.execute("SELECT DISTINCT key FROM actions")}

    # Boards are polled concurrently (network-bound), then written serially.
    # sqlite connections are not shareable across threads, and interleaved
    # writes would be a needless source of lock contention.
    targets = []
    retired = []
    for source in FETCHERS:
        # accept both a bare `greenhouse:` section and grouped ones like `defense_greenhouse:`
        for k, v in cfg.items():
            if (k == source or k.endswith("_" + source)) and isinstance(v, list):
                for entry in v:
                    # A RETIRED BOARD IS SKIPPED, AND SAYS WHY.
                    #
                    # Deleting the row would be worse: the next person to look
                    # at the company sees no board, assumes nobody tried, and
                    # adds the same wrong slug back. The reason travels with
                    # the entry so the finding survives the fix.
                    #
                    # It is NOT counted in `targets`, so it cannot contribute
                    # a permanent zero to the board-anomaly detector -- which
                    # is the point: `ashby/mach` produced one anomaly line
                    # every single morning for a board that was never Mach's.
                    if entry.get("retired"):
                        retired.append((source, entry["slug"],
                                        str(entry["retired"])))
                        continue
                    targets.append((source, entry["slug"], entry.get("tier", 2),
                                    entry.get("display_name") or entry["slug"]))
    if retired:
        print(f"{len(retired)} board(s) retired and not polled:")
        for source, slug, why in sorted(retired):
            print(f"  {source}/{slug} — {why}")

    def poll(t):
        source, slug, tier, _disp = t
        try:
            return t, list(FETCHERS[source](slug)), None
        except requests.HTTPError as e:
            code = e.response.status_code if e.response is not None else "?"
            return t, [], f"HTTP {code} — check slug with `discover`"
        except requests.RequestException as e:
            return t, [], f"network error: {type(e).__name__}"
        except ValueError as e:
            return t, [], f"bad payload: {e}"

    print(f"Polling {len(targets)} boards ({BOARD_WORKERS} at a time)…")
    results = []
    with ThreadPoolExecutor(max_workers=BOARD_WORKERS) as ex:
        futs = [ex.submit(poll, t) for t in targets]
        # as_completed, not map: map returns nothing until every board is done,
        # which makes a 2-minute poll look like a hang.
        for i, fut in enumerate(as_completed(futs), 1):
            r = fut.result()
            results.append(r)
            (source, slug, _t, _d), jobs, err = r
            print(f"  [{i:2d}/{len(futs)}] {source}/{slug}: "
                  f"{err or f'{len(jobs)} roles'}", flush=True)

    print()
    # Boards that answered. Closed-detection is scoped to these and to nothing
    # else — see the comment above it.
    polled_boards = set()
    pending = []

    def flush_touch():
        """Mark unchanged rows as still open, carrying no payload.

        Two columns and a key list. This is what an ordinary morning writes for
        99% of the corpus, instead of a full row with a 6.4 KB description.

        A LIST OF KEYS IS STILL A PAYLOAD, so it is batched like everything
        else: 11,494 keys at ~40 bytes is 460 KB in one statement, which is both
        a large parameter list and a large packet. TOUCH_ROWS keeps each
        statement small enough to be unremarkable.
        """
        if not touch:
            return 0
        marks = ",".join(["?"] * len(touch))
        con.execute(
            "UPDATE jobs SET last_seen = ?, closed_at = NULL "
            "WHERE key IN (%s)" % marks, tuple([ts] + touch))
        con.commit()
        n = len(touch)
        del touch[:]
        return n

    def flush():
        """Write one batch and COMMIT it. Returns rows written."""
        if not pending:
            return 0
        # Dedupe inside the batch. Postgres refuses to let a single
        # INSERT .. ON CONFLICT touch the same row twice, and a paginated board
        # can hand back the same posting on two pages. Last occurrence wins.
        uniq = {}
        for k, params in pending:
            uniq[k] = params
        rows = list(uniq.values())
        sql = (_UPSERT_HEAD
               + ",".join([_UPSERT_ROW] * len(rows))
               + _UPSERT_TAIL)
        con.execute(sql, tuple(v for r in rows for v in r))
        con.commit()
        n = len(rows)
        del pending[:]
        return n

    TRACKED = tracked_boards()
    for (source, slug, tier, disp), jobs, err in results:
        if err:
            print(f"  [{source}/{slug}] {err}")
            continue
        polled_boards.add(f"{source}:{slug}")
        new_here = 0
        for j in jobs:
            key = f"{source}:{slug}:{j['ext_id']}"
            seen_keys.add(key)
            cand = int(title_ok(j["title"], **f))
            # ONE statement per BATCH, not per posting, and committed per batch.
            #
            # The original shape cost two round trips per posting (a SELECT then
            # an INSERT or an UPDATE). Collapsing it to a single upsert halved
            # that, and it still was not enough: ~9,900 sequential round trips
            # to Neon ran past sixteen minutes without committing, twice.
            #
            # The commit is the real point, not the speed. Everything used to
            # land in ONE transaction that committed at the very end, so a run
            # killed at minute nineteen of a twenty-minute cap wrote NOTHING —
            # not partial data, no error, just an empty morning, every morning.
            # A per-batch commit means a killed run leaves the boards it already
            # finished.
            #
            # Columns are named because the table gains them over time; a
            # positional INSERT breaks silently the moment one is added.
            #
            # first_seen is NOT in the DO UPDATE list. It records when this tool
            # first saw the posting and must survive every later fetch — it is
            # the basis of "new since your last visit" and of the class-year
            # posting forecast.
            # THE SCREEN-OUT TAGS, computed here from the text we are about
            # to store rather than from the text the board sent.
            #
            # That distinction is the whole correctness of the flag. A
            # non-candidate's description is truncated at KEEP_FULL_CHARS on the
            # way in, so classifying the ORIGINAL would record "no blockers"
            # against a row whose stored text can never support that claim, and
            # nothing afterwards could tell it apart from a genuinely clear one.
            # `full` says which, and lib/blockers.js refuses to render a clean
            # verdict without it.
            # `tracked` is True for every board in companies.yaml, which is
            # every board this loop polls -- so in practice the description is
            # kept whole. The flag is passed rather than hardcoded so that
            # dropping a company from companies.yaml actually changes what is
            # stored, instead of the rule being true by accident of the caller.
            desc = store_description(j["description"], cand, key in acted_keys,
                                     tracked=(source, slug) in TRACKED)
            full = desc is not None and (
                len(desc) < KEEP_FULL_CHARS
                or len(desc) == len(j["description"] or ""))
            # UNCHANGED ROWS ARE TOUCHED, NOT REWRITTEN.
            #
            # This is the whole fix for the transfer blowout. A row whose hash
            # matches what is already stored needs exactly two columns moved --
            # last_seen, so the freshness stamp is right, and closed_at=NULL, so
            # closed-detection does not bury a role that is still on its board.
            # Neither carries a description, so the touch is a few dozen bytes
            # against roughly 6.7 KB for the full upsert.
            #
            # A NULL stored hash means "written before this column existed" and
            # takes the full path. That costs one complete pass on the first run
            # after deploy and nothing afterwards.
            h = _content_hash(j, cand, disp, full)
            if existing.get(key) == h:
                touch.append(key)
                if len(touch) >= TOUCH_ROWS:
                    touched += flush_touch()
            else:
                # Blockers are derived from title + description + `full`, all of
                # which are in the hash -- so an unchanged row's tags are
                # unchanged too, and classifying it again would be work whose
                # result we already have.
                bl = classify_blockers(j["title"], desc, full)
                pending.append((key, (
                    key, source, slug, j["ext_id"], j["company"], j["title"],
                    j["location"],
                    j["url"], desc,
                    j["posted_at"], tier, cand, ts, ts, disp,
                    j.get("comp_raw"),
                    json.dumps(bl["tags"]), int(bl["complete"]), h)))
                payload_bytes += sum(
                    len(v.encode("utf-8")) if isinstance(v, str) else 8
                    for v in pending[-1][1])
                if len(pending) >= BATCH_ROWS:
                    written += flush()
            if key not in existing_keys:
                existing_keys.add(key)
                new_here += 1
                totals["candidates"] += cand
        totals["seen"] += len(jobs)
        totals["new"] += new_here
        print(f"  [{source}/{slug}] {len(jobs)} open, {new_here} new")
    written += flush()
    touched += flush_touch()

    # Mark jobs that vanished from their board as closed.
    #
    # SCOPED TO BOARDS THAT ACTUALLY ANSWERED. A board that errored contributes
    # nothing to seen_keys, so the old test — "the key's ATS is one we fetch" —
    # read every role on a failed board as gone and closed the lot. One
    # transient 500 from Anduril's board closed every Anduril role. It healed on
    # the next successful fetch, because the upsert sets closed_at=NULL, so it
    # was a day of silent wrongness rather than data loss; it was still the
    # wrong direction to fail in.
    #
    # Per board, not a global all-succeeded flag: one dead board should not
    # suppress closed-detection for the other forty, and no role should ever be
    # closed on evidence we do not have. If the run dies before this point,
    # nothing is closed at all — the safe direction.
    closed = 0
    for (key,) in con.execute(
            "SELECT key FROM jobs WHERE closed_at IS NULL").fetchall():
        board = ":".join(key.split(":")[:2])
        if key not in seen_keys and board in polled_boards:
            con.execute("UPDATE jobs SET closed_at=? WHERE key=?", (ts, key))
            closed += 1
    con.commit()
    # WHAT EACH BOARD RETURNED, written down instead of only printed.
    #
    # These counts were already computed and already printed, into an Actions
    # log nobody reads, and then discarded. That made a board whose slug went
    # stale indistinguishable from a company with no new roles: both are a green
    # run and a quiet morning. See migrations/013 and web/lib/boards.js — the
    # judgement about whether a zero is WRONG happens at read time, against this
    # board's own history. Here we only record what happened.
    #
    # Errors are stored as NULL n_roles + a message, never as 0. A board that
    # threw gave us no information; a board that answered with 0 gave us some.
    # Collapsing them would lose the distinction closed-detection depends on.
    #
    # THIS MUST NEVER FAIL THE FETCH. The rows the run just wrote are worth more
    # than the bookkeeping about them, and an older database without migration
    # 013 applied should still fetch normally.
    try:
        day = ts[:10]
        rows = []
        for (source, slug, _tier, disp), jobs, err in results:
            rows.append((f"{day}:{source}:{slug}", day, source, slug, disp,
                         None if err else len(jobs), err, ts))
        for r in rows:
            con.execute(
                "INSERT INTO board_fetches"
                " (id, day, source, slug, display_name, n_roles, error, fetched_at)"
                " VALUES (?,?,?,?,?,?,?,?)"
                " ON CONFLICT (id) DO UPDATE SET"
                "   n_roles=excluded.n_roles, error=excluded.error,"
                "   fetched_at=excluded.fetched_at", r)
        con.commit()
        print(f"  {len(rows)} board results recorded.")
    except Exception as e:  # noqa: BLE001
        print(f"  could not record board results ({type(e).__name__}: {e}). "
              f"The fetch itself is unaffected; run migration 013.")

    skipped = len(targets) - len(polled_boards)
    if skipped:
        print(f"\n{skipped} board(s) did not answer; their roles were left "
              f"open rather than assumed closed.")
    print(f"\nDone. {totals['seen']} open roles seen, {totals['new']} new, "
          f"{totals['candidates']} new candidates passing title filter.")
    print(f"  {written} rows written in batches of {BATCH_ROWS}; "
          f"{touched} unchanged (touched only); {closed} marked closed.")

    # WHAT THIS RUN COST, ON SCREEN, EVERY RUN.
    #
    # The transfer blowout was invisible until Neon said 100% of a 5 GB month at
    # 11:57 pm. Nothing in this tool had ever printed how much it moved, so the
    # only signal was the bill. An estimate that can disagree with the run is
    # decoration -- so this is measured from the rows this run actually built,
    # not from a query written by hand afterwards.
    #
    # It is a FLOOR, and says so: it counts the payload this script sends and
    # ignores protocol overhead, TLS, and whatever the server sends back.
    if written or touched:
        mb = (payload_bytes + touched * 40) / 1e6
        per_row = payload_bytes / written if written else 0
        # What the old unconditional-write behaviour would have cost, priced at
        # the same per-row size this run actually measured.
        was = ((written + touched) * per_row) / 1e6 if per_row else 0
        print(f"  ~{mb:.1f} MB of row payload sent"
              + (f" (rewriting every row would have been ~{was:.0f} MB)" if was else "")
              + "; a floor, protocol overhead not counted.")

    # A RUN THAT INGESTED NOTHING IS NOT A SUCCESSFUL RUN.
    #
    # Returning 0 here would let the workflow go green, the freshness stamp keep
    # saying the pipeline ran, and the digest report a calm morning — on a day
    # when every board failed. That is the exact green-on-nothing this project
    # keeps rediscovering, and the cheapest place to stop it is at the source.
    #
    # It is `seen`, not `new`: a day with no NEW roles is completely normal and
    # must stay green. Zero roles SEEN across every board is not.
    if not totals["seen"]:
        print("\nFETCH FAILED: not one role was seen across "
              f"{len(targets)} boards. Nothing was written and nothing was "
              "closed. Exiting non-zero so the run goes red rather than "
              "reporting a quiet morning.")
        return 1
    return 0
    funnel(con)


def probe_board(source, slug):
    """Probe one (ATS, slug) pair. Returns (n_roles, detail) or (None, reason).

    Validates response SHAPE, not the status code. Ashby answers HTTP 200 with a
    JS shell for any slug at all, so a 200 proves nothing — an earlier version of
    this function reported phantom boards for seven companies on that basis.
    Greenhouse slug "shield" is likewise a live demo board, not Shield AI, so a
    single unrelated posting is treated as suspect rather than a hit.
    """
    try:
        if source == "rippling":
            # skip the per-job description fetch while probing
            jobs = list(fetch_rippling(slug, with_desc=False))
        else:
            jobs = list(FETCHERS[source](slug))
    except requests.HTTPError as e:
        return None, f"HTTP {e.response.status_code}"
    except requests.RequestException as e:
        return None, f"network: {type(e).__name__}"
    except ValueError as e:
        return None, f"not valid JSON for this ATS ({e})"
    except Exception as e:  # noqa: BLE001
        return None, f"error: {type(e).__name__}"
    if not jobs:
        # parseable but empty — almost always a wrong slug, not an empty board
        return None, "responded but listed 0 roles (likely wrong slug)"
    return len(jobs), "ok"


# Where a company's careers page points. The link is the evidence; a slug that
# merely looks like the name is not.
#
# THIS IS WHAT SOLVED MISTRAL. Guessing gave `mistral`, `mistralai` and
# `mistral-ai`, all of which resolve to nothing; the careers page links to
# jobs.ashbyhq.com/mistral.ai, a slug with a dot in it that no variant generator
# would produce. It is also what would have prevented EON, where `ashby/eon`
# answers with seven roles belonging to an unrelated stealth space company, and
# Shield AI, where a public Greenhouse DEMO board on the slug `shield` hid the
# real Lever one.
_BOARD_LINK = re.compile(
    r"https?://(?:www\.)?("
    r"jobs\.ashbyhq\.com/([A-Za-z0-9._-]+)"
    r"|boards\.greenhouse\.io/([A-Za-z0-9._-]+)"
    r"|job-boards\.greenhouse\.io/([A-Za-z0-9._-]+)"
    r"|jobs\.lever\.co/([A-Za-z0-9._-]+)"
    r")", re.I)

_CAREERS_PATHS = ["/careers", "/careers/", "/jobs", "/company/careers",
                  "/about/careers", "/careers/open-roles", "/join-us"]


def careers_boards_rendered(domain):
    """careers_boards, but with JavaScript. Returns (found, tried).

    A plain GET cannot tell "no board" from "the board link does not exist
    until React runs", and six companies were recorded unresolved on exactly
    that ambiguity. This renders each careers path in a real browser and looks
    for the same ATS links in the resulting DOM.

    IT ABORTS IF CHROME IS MISSING rather than falling back, because a silent
    fallback would report every JavaScript page as having no board -- the wrong
    answer wearing the authority of a measurement.
    """
    import render
    urls = [f"https://{domain}{p}" for p in _CAREERS_PATHS]
    pages = render.render(urls)
    found, tried = [], []
    for url in urls:
        html = pages.get(url)
        if not html:
            tried.append((url, "did not render"))
            continue
        hits = []
        for m in _BOARD_LINK.finditer(html):
            whole = m.group(1)
            if "ashbyhq" in whole:
                src, slug = "ashby", m.group(2)
            elif "lever" in whole:
                src, slug = "lever", m.group(5)
            else:
                src, slug = "greenhouse", m.group(3) or m.group(4)
            if slug and slug.lower() not in ("embed", "js", "board"):
                hits.append((src, slug, url))
        if hits:
            found.extend(hits)
            break
        tried.append((url, f"rendered {len(html):,} chars, no ATS link"))
    return found, tried


def careers_boards(domain):
    """(source, slug, where) for every ATS link on the company's own site.

    Reads the careers page. Never guesses a slug -- the whole point is that the
    company said where its board is.
    """
    found, tried = [], []
    for path in _CAREERS_PATHS:
        url = f"https://{domain}{path}"
        try:
            r = requests.get(url, timeout=20, allow_redirects=True,
                             headers=UA)
        except requests.RequestException as e:
            tried.append((url, type(e).__name__))
            continue
        if r.status_code >= 400:
            tried.append((url, f"HTTP {r.status_code}"))
            continue
        for m in _BOARD_LINK.finditer(r.text or ""):
            whole = m.group(1)
            if "ashbyhq" in whole:
                src, slug = "ashby", m.group(2)
            elif "lever" in whole:
                src, slug = "lever", m.group(5)
            else:
                src, slug = "greenhouse", m.group(3) or m.group(4)
            if slug and slug.lower() not in ("embed", "js", "board"):
                found.append((src, slug, url))
        if found:
            break
        tried.append((url, "no ATS link in the page"))
    return found, tried


def board_identity(source, slug):
    """Text from a REAL posting on this board, for a human to read.

    A board answering is not the board being theirs. Ashby returns HTTP 200 for
    any slug; a Greenhouse demo board answered on `shield`; `ashby/eon` returns
    seven roles belonging to a different company entirely. The only thing that
    settles it is what a posting SAYS, so this prints titles, locations and the
    first of a description rather than deciding anything itself.
    """
    try:
        # The fetchers yield, so this materialises only what it needs. Three
        # postings is enough for a human to recognise a company or not.
        rows = list(itertools.islice(FETCHERS[source](slug), 3))
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"
    if not rows:
        return None, "the board answered with no roles"
    out = []
    for r in rows:
        desc = strip_html(r.get("description") or "")[:220].replace("\n", " ")
        out.append({
            "title": r.get("title") or "?",
            "location": r.get("location") or "?",
            "url": r.get("url") or "",
            "text": re.sub(r"\s+", " ", desc).strip(),
        })
    return out, None


def cmd_resolve(name, domain):
    """Read the careers page, find the board, then show a posting to verify.

    python fetch_jobs.py resolve "Arctic Wolf" arcticwolf.com
    """
    print(f"{name}  <-  https://{domain}")
    found, tried = careers_boards(domain)
    if not found:
        print("  NO ATS LINK on any careers path tried:")
        for url, why in tried:
            print(f"    {url:52s} {why}")
        print("  Custom or embedded ATS. Leave it unresolved -- a guessed slug "
              "fetches somebody else's roles under this company's name.")
        return 1

    seen = set()
    for src, slug, where in found:
        if (src, slug) in seen:
            continue
        seen.add((src, slug))
        print(f"  LINK  {src}/{slug}   (found on {where})")
        n, detail = probe_board(src, slug)
        if n is None:
            print(f"        board does not answer: {detail}")
            continue
        print(f"        {n} open roles"
              + ("   <-- only 1; a demo board looks exactly like this" if n == 1 else ""))
        rows, err = board_identity(src, slug)
        if err:
            print(f"        could not read a posting: {err}")
            continue
        print("        EVIDENCE -- read this and decide if it is really them:")
        for r in rows:
            print(f"          - {r['title'][:64]}  [{r['location'][:34]}]")
            if r["text"]:
                print(f"            {r['text'][:150]}")
    return 0


def cmd_discover(name):
    base = re.sub(r"[^a-z0-9]", "", name.lower())
    variants = list(dict.fromkeys([
        name.lower(), base,
        name.lower().replace(" ", "-"), name.lower().replace(" ", ""),
    ]))
    hits, misses = [], []
    # Try every ATS and every variant — never stop at the first hit. A false
    # positive on one ATS used to short-circuit the search, which is exactly how
    # Shield AI's real Lever board was missed.
    for source in FETCHERS:
        for v in variants:
            n, detail = probe_board(source, v)
            if n is not None:
                hits.append((source, v, n))
            else:
                misses.append((source, v, detail))

    for source, v, n in hits:
        flag = "  <-- only 1 role; verify this is really them" if n == 1 else ""
        print(f"  HIT  {source:11s} slug={v!r:24s} {n:5d} open roles{flag}")
    if not hits:
        print(f"  No public board found for {name!r} on "
              f"{'/'.join(FETCHERS)}. Probably a custom ATS — add it to `manual`.")
        for source, v, detail in misses:
            if not detail.startswith("HTTP 404"):
                print(f"       {source:11s} slug={v!r:24s} {detail}")
    elif len(hits) > 1:
        print("  NOTE: more than one board answered. Pick the one the company's own "
              "careers page links to; adding both double-counts every role.")


def cmd_stats():
    con = db()
    q = lambda s: con.execute(s).fetchone()[0]
    print(f"jobs total:      {q('SELECT COUNT(*) FROM jobs')}")
    print(f"open:            {q('SELECT COUNT(*) FROM jobs WHERE closed_at IS NULL')}")
    print(f"candidates open: {q('SELECT COUNT(*) FROM jobs WHERE closed_at IS NULL AND candidate=1')}")
    print(f"scored:          {q('SELECT COUNT(*) FROM scores')}")
    print(f"in pipeline:     {q('SELECT COUNT(*) FROM applications')}")
    funnel(con)


def cmd_manual(path=None):
    """Apply manual_jobs.yaml into the jobs table. Idempotent.

    THE ROWS ARE source='manual', which is load-bearing rather than cosmetic:
    gate_verdict() returns no verdict for them, so no deterministic gate can
    delete a role the owner typed in themselves. See test_manual_gate.py.

    `candidate=1` because the title filter is the same argument in miniature —
    it exists to thin ten thousand polled titles, and a hand-entered role has
    already been chosen. Leaving it 0 would hide the row from every list while
    the row itself looked fine in the table.
    """
    path = path or repo("manual_jobs.yaml")
    with io.open(path, encoding="utf-8") as f:
        spec = yaml.safe_load(f) or {}
    rows = spec.get("jobs") or []
    if not rows:
        # Loudly, not quietly: "applied 0 manual jobs" reads like success.
        print(f"manual: {path} lists no jobs. Nothing applied.")
        return 1

    con = db()
    now_ts = now()
    written = 0
    for j in rows:
        for required in ("key", "company", "title"):
            if not j.get(required):
                print(f"manual: an entry is missing {required!r}: {j!r}")
                return 1
        params = (
            j["key"], "manual", j["company"], j["key"].split(":")[-1],
            j["company"], j["title"], j.get("location") or "",
            j.get("url") or "", (j.get("note") or "").strip(),
            j.get("posted_at"), j.get("tier", 1), 1,
            now_ts, now_ts, j.get("display_name") or j["company"], None,
        )
        con.execute(_UPSERT_HEAD + _UPSERT_ROW + _UPSERT_TAIL, params)
        if j.get("category"):
            con.execute("UPDATE jobs SET category=? WHERE key=?",
                        (j["category"], j["key"]))
        written += 1
        print(f"  {j['key']}  {j.get('display_name') or j['company']} — {j['title']}")
    con.commit()
    con.close()
    print(f"manual: {written} entr{'y' if written == 1 else 'ies'} applied from {path}")
    return 0


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    d = sub.add_parser("discover"); d.add_argument("name")
    # RESOLVE reads the company's own careers page for an ATS link, then
    # shows a real posting so a human can confirm identity. discover
    # GUESSES slugs; this one asks the company where its board is.
    rs = sub.add_parser("resolve")
    rs.add_argument("name"); rs.add_argument("domain")
    sub.add_parser("stats")
    sub.add_parser("manual")
    a = ap.parse_args()

    if a.cmd == "fetch":
        with open(repo("companies.yaml"), encoding="utf-8") as f:
            # RETURNED, not discarded. cmd_fetch exits non-zero when not one
            # role was seen across every board; swallowing that here would put
            # the silent-success back after removing it one function away.
            return cmd_fetch(yaml.safe_load(f))
    elif a.cmd == "discover":
        cmd_discover(a.name)
    elif a.cmd == "resolve":
        cmd_resolve(a.name, a.domain)
    elif a.cmd == "stats":
        cmd_stats()
    elif a.cmd == "manual":
        return cmd_manual()


if __name__ == "__main__":
    sys.exit(main())
