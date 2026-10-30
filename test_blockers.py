"""blockers.py, against the real lines that motivated every pattern.

The fixtures are VERBATIM from postings in the corpus, not invented. An invented
fixture tests the regex against the sentence the regex was written for, which is
circular; these are the sentences that broke it.

Run: python test_blockers.py
"""
import sys

from console import utf8_stdout
from blockers import (ALL_TAGS, HARD, SOFT, classify, hard_tags, is_clear,
                      units, years_in, YEARS_BLOCK_AT)

utf8_stdout()

FAILS = []
PASSED = 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


def tags(title, desc, complete=True):
    return classify(title, desc, complete)["tags"]


# ===================== THE TWO ROLES THE SPEC NAMES ========================

# VERBATIM from mistral.ai / AI Deployment Strategist - USA, the role that
# caused this feature: the owner got attached to the title before the 28/skip
# score told them about these two lines.
MISTRAL_DS = """As an AI Deployment Strategist, you will drive the adoption and
deployment of Mistral's AI solutions, working closely with customers from
strategic vision to production implementation.

About you

• 4+ years in a client-facing strategic and technical role (e.g., data science
consulting, value engineering, or technical sales).
• You hold a degree in a relevant scientific field (e.g., Computer Science,
Data Science, Engineering, etc.)
• Foundational knowledge of AI/ML/Data Science, with the credibility to advise
both technical and non-technical audiences.
"""

t = tags("AI Deployment Strategist - USA", MISTRAL_DS)
ok("cs_degree" in t, "Mistral DS: cs_degree fires on 'degree in a relevant scientific field'")
ok("years_4plus" in t, "Mistral DS: years_4plus fires on '4+ years'")
ok("clearance" not in t, "Mistral DS: no clearance claimed")
ok(not is_clear(classify("AI Deployment Strategist - USA", MISTRAL_DS)),
   "Mistral DS does not read as clear")

# VERBATIM from palantir / Forward Deployed Software Engineer - US Government.
# THE ROLE DOCUMENT-LEVEL REGEX GETS WRONG. Read as a document, "Active ...
# clearance" matches and the highest-fit role in the corpus goes red.
PALANTIR_FDSE = """Active U.S. security clearance at the Top Secret level, or
willingness to obtain or upgrade to a Top Secret clearance
"""

t = tags("Forward Deployed Software Engineer - US Government - Federal", PALANTIR_FDSE)
ok("clearance_obtainable" in t,
   "Palantir FDSE: the clearance is OBTAINABLE, which is not a blocker")
ok("clearance" not in t,
   "Palantir FDSE: NOT tagged as clearance-blocked — this is the whole point")
ok("clearance_obtainable" in SOFT, "and clearance_obtainable is a soft tag, rendered green")

# ============ THE UNIT IS A BULLET — measured, not asserted ================

# Document-level regex would see "Active" and "clearance" in the same posting.
# They are in DIFFERENT bullets and mean different things.
TWO_BULLETS = """- Experience with distributed systems
- Ability to obtain a U.S. Secret security clearance
- Active participation in code review is expected
"""
t = tags("Software Engineer", TWO_BULLETS)
ok("clearance" not in t,
   "'Active' in an unrelated bullet does not make a clearance hard")
ok("clearance_obtainable" in t, "and the obtainable bullet is read correctly")

# CLAUDE.md's exact case: Applied Intuition, entry level, one commit from being
# deleted because `eligibilit[a-z]*` does not match "eligible for".
ok("clearance" not in tags(
    "Software Engineer - Defense Physical AI",
    "Must hold or be eligible for a U.S. Secret security clearance"),
   "'or be eligible for' is obtainable — the stem that nearly deleted Applied Intuition")
ok("clearance_obtainable" in tags(
    "Software Engineer - Defense Physical AI",
    "Must hold or be eligible for a U.S. Secret security clearance"),
   "and it is tagged obtainable rather than dropped silently")

# "U.S." CONTAINS PERIODS. A sentence bound that breaks on any period splits
# this into fragments carrying neither the subject nor the verb.
HARD_SENTENCE = "Candidates must hold an active U.S. government security clearance. Apply today."
ok("clearance" in tags("Analyst", HARD_SENTENCE),
   "a hard clearance survives the abbreviation in 'U.S.'")
ok(any("clearance" in u and "must hold" in u.lower() for u in units(HARD_SENTENCE)),
   "and the sentence stayed in one piece through the splitter")

# ========================= PREFERRED IS NOT REQUIRED =======================

ok("cs_degree" not in tags(
    "Explosive Operations Engineer",
    "Bachelor's degree in engineering or a related technical discipline is preferred"),
   "a degree line marked 'preferred' is not a screen")
ok("years_4plus" not in tags(
    "Product Manager", "PREFERRED QUALIFICATIONS\n8+ years of experience"),
   "years stated in a preferred bullet are not the bar")
ok("clearance" not in tags(
    "Reliability Analyst",
    "Active Secret or Top Secret clearance preferred, or ability to obtain one"),
   "a preferred clearance is not a blocker")

# ======================== 'OR EQUIVALENT' IS AN ESCAPE ======================

# From stripe / Software Engineer, New Grad, with the posting's year made the
# owner's class year so the fixture reads as a role for their class.
from classify import GRAD_YEAR
STRIPE = ("A Bachelor's or Master's degree in computer science or a directly "
          f"related field, obtained by summer {GRAD_YEAR}, or equivalent work experience")
ok("cs_degree" not in tags("Software Engineer, New Grad", STRIPE),
   "Stripe New Grad: 'or equivalent work experience' is not a screen")

ok("cs_degree" in tags(
    "Mission Systems Software Engineer",
    "Required qualifications: Bachelor's degree in Computer Science, Software Engineering"),
   "but a required CS degree with no escape hatch IS a screen")

# A plain bachelor's degree is not a screen — the owner has one.
ok("cs_degree" not in tags("Analyst", "Bachelor's degree required"),
   "a plain bachelor's degree is not a blocker; the owner has one")

# ============================ YEARS, IN CODE ===============================

ok(years_in("4+ years of experience") == [4], "4+ years extracts 4")
ok(years_in("minimum of 6 years") == [6], "'minimum of 6 years' extracts 6")
ok(years_in("3-5 years") == [3], "a range extracts its LOW end, which is the bar")
ok(years_in("8 or more years") == [8], "'8 or more years' extracts 8")
ok(years_in("no numbers here") == [], "and nothing is invented")

ok("years_4plus" not in tags("Engineer", "3+ years of experience"),
   "3+ years is not tagged — plenty of those take a strong new grad")
ok("years_4plus" in tags("Engineer", "4+ years of experience"),
   f"{YEARS_BLOCK_AT}+ years is the threshold and it is the constant")

# THE LOWEST FIGURE IS THE BAR. Taking the max would call this an 8-year role.
ok("years_4plus" not in tags("Engineer", "3+ years required\n8+ years for senior"),
   "a posting stating 3 and 8 is asking for 3")

# Years in the TITLE. One real role does this.
ok("years_4plus" in tags("Product Designer (8+ YOE)", "We are hiring a designer."),
   "a years requirement stated only in the title is read")

# ======================= TITLES CARRY CLEARANCE ============================

# Fifteen candidate roles state it ONLY here. Defense boards do this on purpose.
ok("clearance" in tags("Forward Deployed Engineer - Oahu (TS/SCI Clearance Required)", "Build things."),
   "TS/SCI in the title, written as a tag rather than a sentence")
ok("clearance" in tags("Program Manager, Connected Warfare (Active Clearance)", "Manage programs."),
   "'(Active Clearance)' in the title is read")

# ==================== HARD OUTRANKS OBTAINABLE ACROSS UNITS ================

BOTH = """- Must hold an active TS/SCI clearance
- Ability to obtain a Secret clearance for occasional site visits
"""
ok("clearance" in tags("Engineer", BOTH),
   "one hard bullet is not cancelled by another offering a different clearance")
ok("clearance_obtainable" not in tags("Engineer", BOTH),
   "and the row does not claim both at once")

# ========================= CITIZENSHIP IS NOT A BLOCKER ====================

t = tags("Engineer", "Must be a U.S. citizen to comply with export control.")
ok("citizenship_only" in t, "US citizenship is tagged")
ok("citizenship_only" in SOFT, "as a SOFT tag — the owner is a citizen, it is not a blocker")
ok(hard_tags(t) == [], "and it contributes nothing to the hard list")
ok(is_clear(classify("Engineer", "Must be a U.S. citizen.")),
   "a citizenship-only role still reads as clear")

# ================ TRUNCATION: ABSENCE IS NOT EVIDENCE ======================

full = classify("Engineer", "Nothing disqualifying here.", complete=True)
cut = classify("Engineer", "Nothing disqualifying here.", complete=False)
ok(full["tags"] == cut["tags"], "the same text yields the same tags either way")
ok(is_clear(full), "a COMPLETE posting with no blocker reads as clear")
ok(not is_clear(cut),
   "a TRUNCATED posting with no blocker does NOT read as clear — it is unknown")

# A hit inside the truncated part is still a real hit, so the patterns run
# anyway rather than being skipped.
ok("years_4plus" in classify("Engineer", "5+ years required", complete=False)["tags"],
   "a blocker found inside truncated text is still reported")

# ============================ SHAPE GUARANTEES =============================

r = classify("Engineer", "5+ years and a degree in computer science required")
ok(r["tags"] == sorted(r["tags"]), "tags come back sorted, so a row cannot reshuffle")
ok(all(t in ALL_TAGS for t in r["tags"]), "and every tag is from the closed set")
ok(classify(None, None)["tags"] == [], "None input is empty, not a crash")
ok(classify("", "")["complete"] is True, "and complete defaults to True")
ok(set(HARD).isdisjoint(SOFT), "hard and soft tags do not overlap")

# A POSITIVE ASSERTION, so a suite that matched nothing cannot pass green.
ok(PASSED > 30, f"the suite actually exercised the classifier ({PASSED} checks)")

print(f"test_blockers: {PASSED} passed" if not FAILS
      else f"test_blockers: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
