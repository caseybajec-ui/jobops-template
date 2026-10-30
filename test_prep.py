#!/usr/bin/env python3
"""The interview prep generator. Pure -- no network, no model.

Run: python test_prep.py

This one is BUILT AND NOT RUN. It costs nothing until a status reaches
interview, and the reason it still needs a test is that every guard on it fires
only in the moment it matters -- the first time the owner has an interview
booked and is reading the output an hour before.
"""
import json
import sys

import prep_pack as P
from console import utf8_stdout

utf8_stdout()
FAILS, PASSED = [], 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


GOOD = {
    "summary": "Sits with a customer and ships against their constraints.",
    "questions": ["Tell me about a system you shipped end to end."],
    "answers": ["Campus marketplace: sole engineer, 1,200 registered students."],
    "ask_them": ["How much of the week is with the customer?"],
    "position": ("US citizen, no sponsorship needed. I hold no current or prior "
                 "clearance, know of no disqualifying factors, and am willing "
                 "to undergo the process."),
}
ok(P.violations(GOOD) == [], f"a clean pack passes: {P.violations(GOOD)}")

# THE PERMITTED CLEARANCE SENTENCE MUST SURVIVE. A guard that refused this
# would refuse every correct pack forever -- which is exactly what the shipped
# forbiddenClaim did before it learned about negation.
ok(not any("position" in v for v in P.violations(GOOD)),
   "the permitted clearance paragraph is not flagged")

CLAIM = dict(GOOD, position="I am clearance-eligible for TS/SCI.")
ok(any("clearance-eligible" in v for v in P.violations(CLAIM)),
   f"an eligibility claim is refused: {P.violations(CLAIM)}")

CLEARED = dict(GOOD, summary="He is cleared for this work.")
ok(P.violations(CLEARED), "and so is a flat assertion")

BRACKET = dict(GOOD, answers=["Cut cost per brief by [X]%."])
v = P.violations(BRACKET)
ok(any("[X]" in x for x in v), f"a bracket inside a LIST is caught: {v}")

DASH = dict(GOOD, summary="Ships fast \u2014 and well.")
ok(any("dash" in x for x in P.violations(DASH)), "an em dash is caught")

# THE LIST FIELDS ARE SEARCHED, not just the strings. questions/answers/ask_them
# are JSON arrays, and a guard that only looked at str values would miss every
# claim in the part the owner actually reads out loud.
ok(any("questions" in x for x in P.violations(
    dict(GOOD, questions=["Are you cleared?", "He is cleared."]))),
   "claims inside the questions array are caught")

# ONE DEFINITION OF THE CLEARANCE RULE. It imports apply_packs.clearance_claim,
# which parses web/lib/clearance.js. A third spelling is how a rule rots.
import io
src = io.open("prep_pack.py", encoding="utf-8").read()
ok("from apply_packs import clearance_claim" in src,
   "the clearance rule is imported, not respelled")
ok("FORBIDDEN" not in src, "and no pattern list is copied into this file")

# COST. Synchronous, so no batch discount, and it says so.
ok(P.ABORT_OVER <= 0.25, f"the per-role abort is at most 25c (${P.ABORT_OVER})")
ok("no batch discount" in src.lower() or "NO batch discount" in src,
   "the estimate does not quietly halve for a discount it does not get")
ok("sonnet" in P.MODEL, f"prose for a human runs on Sonnet ({P.MODEL})")
ok(P.MODEL in P.PRICE, "and its price is known")

# ZERO INPUT REFUSES rather than inventing every answer.
import os
import tempfile
_real = P.repo
try:
    tiny = tempfile.mkdtemp()
    for n in ("profile.json", "projects.md", "resume_tech.md", "resume_finance.md"):
        io.open(os.path.join(tiny, n), "w", encoding="utf-8").write("x")
    P.repo = lambda n: os.path.join(tiny, n)
    try:
        P.sources()
        ok(False, "a too-small source refuses")
    except SystemExit as e:
        ok("Refusing" in str(e), f"a too-small source refuses: {str(e)[:50]}")
finally:
    P.repo = _real

ok(len(P.sources()) > 6000, "and the real material is big enough to work from")

# IT DOES NOT RESEARCH THE COMPANY. A model asked to recall facts about an
# employer produces confident wrong ones, and being wrong about the
# interviewer's own company is the worst place in this pipeline to be wrong.
ok("does not research the company" in src, "the prompt is limited to the material given")

print(f"test_prep: {PASSED} passed" if not FAILS
      else f"test_prep: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
