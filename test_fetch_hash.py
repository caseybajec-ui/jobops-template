#!/usr/bin/env python3
"""The content hash that decides whether a row is rewritten. Pure, no database.

WHAT IS AT STAKE. The nightly fetch now SKIPS any row whose hash matches what is
stored. If the hash misses a field the upsert can write, that field stops
reaching the database the moment the rest of the row settles -- silently,
permanently, and looking exactly like data that simply has not changed. This
file is the reason that cannot happen quietly.

Run: python test_fetch_hash.py
"""
import re
import sys

import fetch_jobs
from console import utf8_stdout

utf8_stdout()

FAILS = []
PASSED = 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


H = fetch_jobs._content_hash


def job(**kw):
    base = {"company": "Anduril", "title": "Product Ops", "location": "Costa Mesa",
            "url": "https://x.test/1", "description": "Build things.",
            "posted_at": "2026-09-01", "comp_raw": "$100k"}
    base.update(kw)
    return base


BASE = H(job(), 1, "Anduril", True)

# ============ EVERY WRITTEN COLUMN IS COVERED. THE CORE INVARIANT. ==========

# Parse the columns the upsert actually updates, out of the SQL itself. Written
# this way rather than as a hand-kept list because a hand-kept list is the thing
# that drifts -- that is the entire failure being guarded against.
# `closed_at=NULL` is written as a literal, not from excluded, so both
# shapes are parsed. Missing it made the exemption list look stale.
written = set(re.findall(r"(\w+)=excluded\.", fetch_jobs._UPSERT_TAIL))
written |= set(re.findall(r"(\w+)=NULL", fetch_jobs._UPSERT_TAIL))
ok(len(written) >= 8, f"parsed the upsert's column list ({len(written)} columns)")

# `display_name` and `candidate` are hashed but are not fields OF the
# posting dict, so they are named here rather than in _HASHED_JOB_FIELDS.
covered = (set(fetch_jobs._HASHED_JOB_FIELDS) | fetch_jobs._UNHASHED_OK
           | {"display_name", "candidate"})
missing = written - covered
ok(not missing,
   f"every column the upsert writes is hashed or explicitly exempt; missing: {sorted(missing)}")

# And the exemption list is not a dumping ground: everything in it must really
# be written, or it is a stale name giving false comfort.
stale = fetch_jobs._UNHASHED_OK - written
ok(not stale, f"no stale names in the exemption list: {sorted(stale)}")

# ==================== EVERY HASHED FIELD ACTUALLY MOVES IT =================

# A field in the list that does not change the hash is worse than one that is
# absent: it looks covered. Proved one at a time.
for f in fetch_jobs._HASHED_JOB_FIELDS:
    ok(H(job(**{f: "CHANGED-VALUE-XYZ"}), 1, "Anduril", True) != BASE,
       f"changing `{f}` changes the hash")

ok(H(job(), 0, "Anduril", True) != BASE, "changing `candidate` changes the hash")
ok(H(job(), 1, "Anduril Industries", True) != BASE,
   "changing `display_name` changes the hash")
ok(H(job(), 1, "Anduril", False) != BASE,
   "changing the keep-full decision changes the hash")

# ========================= IT IS STABLE AND SHAPED ========================

ok(H(job(), 1, "Anduril", True) == BASE, "the same input gives the same hash")
ok(len(BASE) == 32, f"128 bits of hash, got {len(BASE)} hex chars")
ok(re.fullmatch(r"[0-9a-f]{32}", BASE) is not None, "and it is plain lowercase hex")

# A ONE-CHARACTER DESCRIPTION EDIT MUST MOVE IT. This is not hypothetical: the
# first fetch after the description backfill moved 52 descriptions by exactly
# one character, a template edit on one board.
ok(H(job(description="Build things."), 1, "Anduril", True)
   != H(job(description="Build things!"), 1, "Anduril", True),
   "a single changed character changes the hash")

# ==================== FIELD BOUNDARIES ARE NOT AMBIGUOUS ==================

# The classic bug: joining fields with a separator, which breaks the moment the
# separator appears inside a field. Job descriptions contain every character
# there is, so the fields are length-prefixed instead.
ok(H(job(title="ab", location="c"), 1, "A", True)
   != H(job(title="a", location="bc"), 1, "A", True),
   "moving a character across a field boundary changes the hash")
ok(H(job(title="a\x00b"), 1, "A", True) != H(job(title="ab"), 1, "A", True),
   "a NUL inside a field does not collide with the field separator")

# ============================ NONE IS NOT EMPTY ===========================

# NULL and "" are different states in the database and must hash differently,
# or a field being cleared would never be written.
ok(H(job(comp_raw=None), 1, "A", True) != H(job(comp_raw=""), 1, "A", True),
   "None and empty string hash differently")
ok(H(job(description=None), 1, "A", True) is not None,
   "a None description does not crash the hash")

# Missing key behaves as None rather than raising -- a board that omits a field
# must not kill the fetch.
partial = {"title": "X"}
ok(isinstance(H(partial, 1, "X", True), str), "a sparse posting dict still hashes")

# A POSITIVE ASSERTION, so a suite that matched nothing cannot pass green.
ok(PASSED > 20, f"the suite exercised the hash ({PASSED} checks)")

print(f"test_fetch_hash: {PASSED} passed" if not FAILS
      else f"test_fetch_hash: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
