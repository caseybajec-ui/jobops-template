#!/usr/bin/env python3
"""The apply-pack critic. Pure -- no network, no database, no model.

Run: python test_critic.py

A pack is the only model-generated text in this tool that reaches an EMPLOYER,
and CLAUDE.md rule 4 says tailoring "does not create claims, numbers, or
skills". Nothing was checking. The failure this guards is silent by
construction: an invented number reads exactly like a real one.
"""
import io
import sys

import pack_critic as C
from console import utf8_stdout

utf8_stdout()
FAILS, PASSED = [], 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


# ============ THE VERDICT: THREE STATES, NOT TWO ==========================
#
# None and [] are DIFFERENT and everything downstream depends on it. [] means
# the critic read the pack and found nothing wrong. None means the verdict
# could not be read -- and a pack must NEVER be refused on a verdict nobody
# could parse, or an unparseable response deletes work that was never assessed.

CLEAN = {"claims": [
    {"text": "1,200 registered students", "supported": True,
     "source": "1,200 registered students, 3,400 listings"},
    {"text": "cut report prep to under an hour", "supported": True,
     "source": "cut report prep from 6 hours to 40 minutes"},
]}
ok(C.unsupported(CLEAN) == [], "a fully supported pack yields an empty list")

DIRTY = {"claims": [
    {"text": "1,200 registered students", "supported": True, "source": "1,200 registered"},
    # THE FABRICATED NUMBER. Plausible, specific, and nowhere in the source.
    {"text": "grew revenue 340% quarter over quarter", "supported": False,
     "source": None},
]}
bad = C.unsupported(DIRTY)
ok(bad is not None and len(bad) == 1, f"one fabricated claim is caught: {bad}")
ok(bad and "340%" in bad[0]["text"], "and the claim itself is reported")
ok(bad and bad[0]["source"] is None, "with no source, because there is none")

# UNREADABLE, in every shape a model actually produces.
ok(C.unsupported(None) is None, "an unparseable response is None, not clean")
ok(C.unsupported({}) is None, "and so is a JSON object with no claims key")
ok(C.unsupported({"claims": "nope"}) is None, "and a claims key of the wrong type")
ok(C.unsupported({"claims": []}) == [],
   "but an EMPTY claims list is a clean read, not an unreadable one")

# ============ THE PARSER ==================================================

ok(C._parse('{"claims": []}') == {"claims": []}, "plain JSON parses")
ok(C._parse('Here you go:\n{"claims": []}\nHope that helps') == {"claims": []},
   "and JSON wrapped in prose, which the model produces about half the time")
ok(C._parse("no json here") is None, "and prose with no object is None")
ok(C._parse("") is None, "and an empty response is None")

# ============ THE ZERO-INPUT GUARD =======================================
#
# An empty source is the ONE input that makes this tool destructive rather than
# merely useless: every claim reads as unsupported, every pack in the corpus is
# refused, and the whole thing is re-queued at full price.

src = io.open("pack_critic.py", encoding="utf-8").read()

# EXERCISED, NOT GREPPED. Checking that the string "Refusing to run" appears in
# the file passes whether or not the `if` around it still fires -- the mutation
# audit removed the guard outright and both source-text checks stayed green.
import os
import tempfile

_real_repo = C.repo
try:
    tiny = tempfile.mkdtemp()
    for name in ("profile.json", "projects.md", "resume_tech.md",
                 "resume_finance.md"):
        # profile.json must be VALID json or source_material refuses on that
        # instead of on the size, which is a different guard.
        io.open(os.path.join(tiny, name), "w", encoding="utf-8").write(
            '{"a": "short"}' if name.endswith(".json") else "short")
    C.repo = lambda n: os.path.join(tiny, n)
    try:
        C.source_material()
        ok(False, "a too-small source REFUSES rather than refusing every pack")
    except SystemExit as e:
        ok("Refusing to run" in str(e),
           f"a too-small source refuses to run: {str(e)[:60]}")

    empty = tempfile.mkdtemp()
    C.repo = lambda n: os.path.join(empty, n)
    try:
        C.source_material()
        ok(False, "a MISSING source file refuses too")
    except SystemExit as e:
        ok("is missing" in str(e), f"a missing source file refuses: {str(e)[:60]}")
finally:
    C.repo = _real_repo

# And the positive half: the REAL source material is big enough to work with,
# so the guard is not passing merely because everything refuses.
got = C.source_material()
ok(len(got) > 4000, f"the real source material is {len(got):,} characters")
# WHAT THE PACKS CLAIM comes from profile.json's evidence, whoever the owner
# is: the first evidence item's id and a word of its text must be in the blob.
import json as _json
_prof = _json.load(io.open("profile.json", encoding="utf-8"))
_ev0 = (_prof.get("evidence") or [{}])[0]
ok(_ev0.get("text", "")[:40] in got,
   "and contains what the packs actually claim (the first evidence item)")


# A MALFORMED profile.json REFUSES rather than falling back to raw text --
# which would reintroduce the quote bug silently, and cost another 20% of
# verdicts.
_r2 = C.repo
try:
    bad = tempfile.mkdtemp()
    for n in ("profile.json", "projects.md", "resume_tech.md", "resume_finance.md"):
        io.open(os.path.join(bad, n), "w", encoding="utf-8").write("not json {[")
    C.repo = lambda n: os.path.join(bad, n)
    try:
        C.source_material()
        ok(False, "a malformed profile.json refuses")
    except SystemExit as e:
        ok("not valid JSON" in str(e),
           f"a malformed profile.json refuses by name: {str(e)[:60]}")
finally:
    C.repo = _r2

# AND THE PROFILE IS FLATTENED, not passed raw. Raw JSON in the source is what
# made the model emit `"source": "graduation": "<month year>"` and break its own
# reply on 39 of 198 responses.
_prof = C.source_material()
_head = _prof[:_prof.index("===== projects.md")]
ok("{" not in _head, "the profile section carries no JSON braces")
ok('"' not in _head, "and no double quotes for the model to copy")
ok("No sponsorship required" in _head, "while keeping the citizenship line")

# THE COST GUARD, exercised. do_check must RETURN NON-ZERO and send nothing.
ok(C.ABORT_OVER <= 3.00, f"the per-run abort is at most $3 (${C.ABORT_OVER})")


class FakeCon:
    def __init__(self, n):
        self.rows = [{"key": f"k{i}", "title": "T", "company": "c",
                      "cover_note": "x" * 400, "why_company": "y" * 400,
                      "why_role": "z" * 400, "project_story": "p" * 400,
                      "biggest_challenge": "b" * 400} for i in range(n)]
        self.wrote = []

    def execute(self, sql, params=()):
        class R:
            def __init__(s, rows): s.rows = rows
            def fetchall(s): return s.rows
            # _has_collected_sample uses fetchone. A fake that answers only
            # fetchall makes the code under test crash on a shape the real
            # driver supports, which reads as a bug in the code rather than in
            # the fake.
            def fetchone(s): return s.rows[0] if s.rows else {"n": 0}
        # The batches count, for _has_collected_sample. `collected` says
        # whether a sample has been read; the default 0 is the state the gate
        # is supposed to refuse in.
        if "batches" in sql:
            return R([{"n": getattr(self, "collected", 0)}])
        if sql.strip().upper().startswith("SELECT"):
            return R(self.rows)
        self.wrote.append(sql)
        return R([])

    def commit(self):
        pass


# 4,000 packs is far over $3. Nothing may be sent, and it must exit non-zero.
big = FakeCon(4000)
rc = C.do_check(big, dry_run=False)
ok(rc != 0, f"an over-budget run exits non-zero (got {rc})")
ok(not big.wrote, "and writes no batch row, so nothing was submitted")

# A small run under the limit is NOT refused -- proving the guard discriminates
# rather than always refusing.
small = FakeCon(2)
rc2 = C.do_check(small, dry_run=True)
ok(rc2 == 0, "a small run passes the cost guard")

# HAIKU, per the model policy: classification, not prose for a human.
ok("haiku" in C.MODEL, f"the critic runs on Haiku ({C.MODEL})")
ok(C.MODEL in C.PRICE, "and its price is known, so the estimate is real")

# ============ WHAT A REFUSAL DOES ========================================
#
# Same treatment as a clearance claim or a bracket: raw kept, cover_note NULL
# so the role re-queues. NOT a rewrite -- the critic never edits text.
# IT FLAGS, IT DOES NOT DELETE. Two runs proved auto-refusal wrong: the first
# had the wrong source and destroyed 71 true packs, and the sample -- with the
# source fixed -- still refused 2 of 6 wrongly, on categories the prompt tells
# the model to ignore. A third wrong is fine for a flag and unacceptable for a
# delete.
ok("cover_note = NULL" not in src,
   "a flagged pack KEEPS its text; the critic never deletes")
ok("UNSUPPORTED (check these)" in src,
   "and the note says what to check rather than announcing a refusal")
ok("critic_at" in src and "critic_note" in src,
   "and records both that it was checked and why it failed")
ok("rewrite" not in src.lower().split("WHAT IT IS NOT")[-1][:400]
   or "does not rewrite" in src,
   "the critic does not rewrite anything")

# FAIL OPEN ON AN UNREADABLE VERDICT.
ok("pack left as it was" in src,
   "an unreadable verdict leaves the pack alone rather than refusing it")

# ============ THE INCIDENT THIS FILE NOW GUARDS ===========================
#
# The first real run refused 71 of 121 packs and NULLed their text. The critic
# was RIGHT and the input was WRONG: it was given projects.md and the two
# resumes but not profile.json, so "I am a US citizen", "hold no clearance" and
# "targeting a summer 2027 start" -- all true, all in profile.json -- came back
# with no supporting line, exactly as the prompt instructs.

got = C.source_material()
low = got.lower()

# THE FACTS THAT ONLY profile.json CARRIES. Asserting the FILENAME is in the
# blob is not enough -- and neither is "us citizen", which also appears in the
# packs' own vocabulary. These two canonical strings live in profile.json's
# `citizenship` and `clearance` fields and appear NOWHERE in projects.md or
# either resume, verified. They are exactly what the 71 refused packs claimed.
ok("no sponsorship required" in low,
   "the source states the citizenship line, which ONLY profile.json carries")
ok("no known disqualifying factors" in low,
   "and the clearance line, likewise -- these are what the 71 packs claimed")
ok("===== projects.md =====" in got and "===== resume_tech.md =====" in got,
   "and the project and resume material is there too")

# THE SAMPLE GATE. A refusal DELETES text, so a full run is not allowed until a
# sample has been collected and read. "Never delete before the replacement is
# confirmed" -- and a critic that has never been run is not confirmed.
ok(C.SAMPLE_MAX <= 20, f"a sample is at most 20 packs ({C.SAMPLE_MAX})")


class _Row:
    def __init__(self, v):
        self.v = v

    def fetchone(self):
        return {"n": self.v}

    def fetchall(self):
        return []


class GateCon(FakeCon):
    def __init__(self, n, collected):
        super().__init__(n)
        self.collected = collected


big_nosample = GateCon(60, 0)
ok(C.do_check(big_nosample, dry_run=True) != 0,
   "a full run with NO collected sample refuses")
ok(not big_nosample.wrote, "and submits nothing")

big_sampled = GateCon(60, 1)
ok(C.do_check(big_sampled, dry_run=True) == 0,
   "and is allowed once a sample has been collected")

# --sample is always allowed, or the gate would be unopenable.
ok(C.do_check(GateCon(60, 0), dry_run=True, sample=True) == 0,
   "--sample runs even with no prior sample, or the gate could never open")

# AN INVALIDATED BATCH IS NOT A SAMPLE, exercised rather than grepped. The bad
# first run is marked INVALIDATED precisely so nothing counts it as a human
# having read a refusal list -- and the first version of this gate DID count
# it, while a source-text check for the word stayed green.
#
# The fake answers 1 when the query FILTERS on INVALIDATED and 2 when it does
# not, so a gate that stops filtering sees a sample that is not there.
class InvalidatedCon(FakeCon):
    def __init__(self, n):
        super().__init__(n)

    def execute(self, sql, params=()):
        if "batches" in sql:
            filters = "INVALIDATED" in str(params)
            class R:
                def __init__(s, v): s.v = v
                def fetchone(s): return {"n": s.v}
                def fetchall(s): return []
            # 0 real samples once the invalidated one is excluded; 1 if not.
            return R(0 if filters else 1)
        return super().execute(sql, params)


ok(C.do_check(InvalidatedCon(60), dry_run=True) != 0,
   "a run whose ONLY prior batch is INVALIDATED still refuses")

print(f"test_critic: {PASSED} passed" if not FAILS
      else f"test_critic: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
