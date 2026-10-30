#!/usr/bin/env python3
"""Contact sourcing: attribution and ranking. Pure -- no network, no model.

Run: python test_sourcing.py
"""
import sys

import source_contacts as S
from console import utf8_stdout

utf8_stdout()
FAILS, PASSED = [], 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


# ============ THE CROSS-COMPANY ATTRIBUTION CHECK =========================
#
# Brex's own about page lists Alexandr Wang, who runs Scale AI -- presumably as
# an investor or board member. Assigning him to Brex produces a cold note that
# opens by getting the reader's employer wrong, which is the single most
# obvious way to be ignored.
#
# THE REAL RUN DROPPED NOTHING, because contacts held no Alexandr Wang to match
# against. A guard that has never fired is not a guard, so the case is here.

KNOWN = {S.norm_name("Alexandr Wang"): "scaleai",
         S.norm_name("Christina Cacioppo"): "vanta"}

ok(KNOWN.get(S.norm_name("Alexandr Wang")) == "scaleai",
   "the corpus knows Alexandr Wang is at Scale AI")

# THE REAL FUNCTION main() CALLS, not a copy of the idea. The first version of
# this test did the dict lookup itself and stayed green while the shipped check
# was deleted outright.
ok(S.belongs_elsewhere("Alexandr Wang", "brex", KNOWN) == "scaleai",
   "Alexandr Wang on Brex's page is dropped, and it names Scale AI")
ok(S.belongs_elsewhere("alexandr  wang", "brex", KNOWN) == "scaleai",
   "and the match survives the spelling a website actually uses")

# Found on their OWN company's page -> kept.
ok(S.belongs_elsewhere("Christina Cacioppo", "vanta", KNOWN) is None,
   "Christina Cacioppo on vanta's page is NOT dropped -- the check must not "
   "reject everyone it recognises")
ok(S.belongs_elsewhere("Someone New", "brex", KNOWN) is None,
   "and an unknown name is kept, or nothing would ever be sourced")

# Normalisation survives punctuation and case, or the check misses the very
# spellings a website uses.
for a, b in [("Alexandr Wang", "alexandr wang"), ("O'Brien", "OBrien"),
             ("Jean-Luc Picard", "JeanLuc Picard")]:
    ok(S.norm_name(a) == S.norm_name(b), f"{a!r} and {b!r} normalise alike")

ok(S.norm_name("Alexandr Wang") != S.norm_name("Alex Wang"),
   "but two different people do not collide")

# ============ THE RANKING IS USEFULNESS, NOT SENIORITY ====================
#
# The CEO of a 40-person startup answers his own email. The CEO of Samsara does
# not. A 56-name Samsara page must surface ops and product people; a 4-name
# Chaos Industries page must surface the founder.

r_small, why_small = S.rank_of("Co-Founder & CEO", 40)
r_big, why_big = S.rank_of("Co-Founder & CEO", 256)
ok(r_small < r_big,
   f"a founder at a 40-role company outranks one at a 256-role company "
   f"({r_small} vs {r_big})")
ok("small" in why_small and "large" in why_big, "and the reason says which")

r_role, _ = S.rank_of("Deployment Strategist", 256)
r_ceo, _ = S.rank_of("Chief Executive Officer", 40)
ok(r_role < r_ceo,
   f"someone doing the job outranks a founder anywhere ({r_role} vs {r_ceo})")

r_hire, _ = S.rank_of("University Recruiter", 256)
ok(r_role < r_hire < r_ceo,
   f"and hiring for it sits between them ({r_role} < {r_hire} < {r_ceo})")

# THE SAMSARA CASE, stated: its CEO must NOT outrank an ops person there.
r_ops, _ = S.rank_of("Business Operations Manager", 256)
r_sam_ceo, _ = S.rank_of("Chief Executive Officer", 256)
ok(r_ops < r_sam_ceo,
   f"at Samsara's size, ops outranks the CEO ({r_ops} vs {r_sam_ceo})")

# An alum of the owner's own school beats everything, which is the one rule
# that predates this. The school comes from profile.json through owner.py --
# the test asserts the SHAPE (first search term is rank 0, the wider
# institution is rank 1, labelled "<term> alum") and never names a school,
# because the template ships with a fictional one and the real owner's is
# whatever profile.json says.
TERMS = S.OWNER["school_search_terms"]
ok(len(TERMS) >= 2, f"profile.json names a school unit and a university ({TERMS})")
unit, uni = TERMS[0], TERMS[1]
r_m, why_m = S.rank_of("Anything At All", 256, school_unit=True)
ok(r_m == 0 and why_m == f"{unit} alum",
   f"an alum of the owner's school unit ranks first, labelled from the term ({why_m!r})")
r_u, why_u = S.rank_of("Anything At All", 256, university=True)
ok(r_m < r_u < r_role,
   "the wider university sits between the school unit and the role match")
ok(why_u == f"{uni} alum", f"and is labelled from the second term ({why_u!r})")

# The same two ranks by NAME, matched case-insensitively, so a caller can pass
# whatever spelling the directory used.
ok(S.rank_of("Anything", 256, alum_of=unit.upper()) == (0, f"{unit} alum"),
   "alum_of= the school unit gives rank 0")
ok(S.rank_of("Anything", 256, alum_of=uni.lower()) == (1, f"{uni} alum"),
   "alum_of= the university gives rank 1")
ok(S.rank_of("Deployment Strategist", 256, alum_of="Some Other College")[0] == r_role,
   "and an unrelated school is not an alum rank at all; the title decides")

# NO SCHOOL IS NAMED IN THE SOURCE. The ranks are built from profile.json, and
# a literal here would survive a copy of the repo and rank strangers first.
import io
_src = io.open("source_contacts.py", encoding="utf-8").read()
ok(" alum\"" not in _src.replace("{t} alum\"", ""),
   "source_contacts.py carries no literal '<school> alum' label")

# ============ IT WRITES NOTHING ===========================================

import io
src = io.open("source_contacts.py", encoding="utf-8").read()
ok("INSERT INTO contacts" not in src, "sourcing never inserts a contact")
ok("NOTHING WAS WRITTEN" in src, "and says so when it finishes")
ok("linkedin.com" not in src.lower() or "never fetches" in src,
   "and never fetches linkedin.com")

print(f"test_sourcing: {PASSED} passed" if not FAILS
      else f"test_sourcing: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
