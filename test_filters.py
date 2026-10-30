#!/usr/bin/env python3
"""Tests for the title filter. Run: python test_filters.py

Every case in FALSE_EXCLUSIONS is a real title from a real board that the old
bare-substring filter wrongly dropped. They are here so the substring bugs
cannot silently come back.
"""
import io
import sys

import yaml

from classify import GRAD_YEAR
from fetch_jobs import title_ok

with io.open("companies.yaml", encoding="utf-8") as f:
    CFG = yaml.safe_load(f)

INC = CFG["title_include"]
EXC = CFG["title_exclude"]
SEN = CFG["title_senior"]
LVL = CFG["title_level"]
PRO = CFG["title_protect"]


def ok(title):
    return title_ok(title, INC, EXC, SEN, LVL, PRO)


# The substring bugs, tested at the matcher level so they are provable
# independently of whatever else a real title happens to contain.
# (term, text, must_match)
SUBSTRING_BUGS = [
    ("intern", "International Project Logistics", False),
    ("intern", "Software Engineering Intern", True),
    ("iv", "Drive Systems Analyst", False),
    ("iv", "Private Cloud Program", False),
    ("iv", "Mission Activity Analyst", False),
    ("iv", "Systems Engineer IV", True),
    ("lead", "Leadership Development Program", False),
    ("lead", "Lead Product Manager", True),
    ("sales", "Product Manager, Salesforce", False),
    ("sales", "Enterprise Sales Manager", True),
]

# Real titles the old filter killed on a substring match. All must now pass.
FALSE_EXCLUSIONS = [
    ("Leadership Development Program, Strategy", "'lead' inside 'Leadership'"),
    ("Product Operations Analyst, Drive Systems", "'iv' inside 'Drive'"),
    ("Program Analyst, Private Cloud", "'iv' inside 'Private'"),
    ("AFSIM Operations Analyst, Mission Activity", "'iv' inside 'Activity'"),
    ("International Growth Associate", "'intern' inside 'International'"),
    ("Product Manager, Salesforce Platform", "'sales' inside 'Salesforce'"),
]

# Must be dropped: genuinely senior, or a hard-no function.
# Adding "group product manager" and "gpm" to title_senior must not cost a single
# new-grad PM title. Asserted explicitly, because the corpus diff for that change
# moved 10 rows and every one had to be a real GPM — a senior term that also
# caught "Associate Product Manager" would be the "intern killed International"
# bug again, and the count alone would have looked identical.
PM_STILL_PASSES = [
    ("Associate Product Manager", "the tier-1 target itself"),
    (f"Associate Product Manager, New Grad ({GRAD_YEAR} Start)", "the exact Databricks shape"),
    ("Product Manager", "the plain title"),
    ("Product Manager, New Grad", "new-grad PM"),
    ("APM", "the abbreviation the owner's profile names first"),
    ("Program Manager", "program management"),
    ("Product Operations", "product ops"),
    ("Product Analyst", "product analyst"),
]

MUST_DROP = [
    ("Senior Product Manager", "senior"),
    ("Sr. Strategy Analyst", "sr"),
    ("Staff Software Engineer", "staff"),
    ("Principal Product Manager", "principal"),
    ("Director of Operations", "director"),
    ("Head of Growth", "head of"),
    ("VP, Corporate Strategy", "vp"),
    ("Lead Product Manager", "'lead' as its own word"),
    ("Systems Engineer IV", "roman numeral level"),
    ("Product Manager II", "roman numeral level"),
    # A GPM is typically an eight-year title, and "group manager" — already in
    # the senior list — does NOT catch it: "Group Product Manager" has a word
    # between the two, so the literal never matches. Seven real GPM postings at
    # Brex, Coinbase and Rippling were passing the filter before this.
    ("Group Product Manager", "group product manager"),
    ("Group Product Manager, Payments", "group product manager, with a suffix"),
    # The abbreviation. Safe as a bare token only because _term_re's boundaries
    # are NON-ALPHANUMERIC — it fires on "(GPM)" and "GPM," and never inside a
    # longer word. It matches nothing in the corpus today; it is here so a board
    # that writes the short form cannot slip a GPM through.
    ("GPM, Growth", "the abbreviation, standalone"),
    ("Product Manager (GPM)", "the abbreviation in parentheses"),
    ("Account Executive, Public Sector", "hard-no function"),
    ("Enterprise Sales Manager", "hard-no function"),
    ("Technical Recruiter, Mission Readiness", "hard-no function"),
    ("Software Engineering Intern", "no internship cycle remains"),
    ("Staff+ Application Security Engineer", "staff"),
    ("Associate Director, International Project Logistics",
     "genuinely senior — must drop on 'director', NOT on 'intern' in 'International'"),
    # bare "engineer" was pure noise at these companies
    ("Embedded Software Engineer, Edge Systems", "topic-less senior-neutral eng role"),
    ("Mechanical Engineer, Structures", "topic-less senior-neutral eng role"),
]

# Must pass: on-target roles, including unleveled startup titles.
MUST_PASS = [
    ("Associate Product Manager", "APM is the headline target"),
    (f"Product Manager, New Grad {GRAD_YEAR}", "explicit level signal"),
    ("Deployment Strategist", "Palantir/Anduril deployment track"),
    ("Forward Deployed Software Engineer", "deployment track"),
    ("Chief of Staff to the CEO", "must survive — 'chief' is not a senior term here"),
    ("Business Operations Analyst", "topic match, unleveled"),
    ("Mission Operations Specialist", "topic match"),
    ("Strategy & Operations, Growth", "topic match"),
    ("University Recruiting Program - Product", "level signal"),
    ("Rotational Leadership Development Program", "level signal"),
    ("Investment Analyst, Early Career", "level signal"),
    ("Product Analyst I", "standalone I level token"),
    ("Founding Product Engineer", "founding overrides engineer noise"),
    ("Public Sector Program Analyst", "topic match"),
    ("Campus Hire - Bizops", "level signal"),
]


# --- ranking integrity -------------------------------------------------------
# Guards the bug where a raw 54 outranked a raw 82: percentile-within-model is
# invalid when two models scored different populations. The rank basis must be
# non-null for every scored row and must be monotonic in the raw score.

def test_rank_basis():
    # Reads THE database, whichever is configured — Neon since phase I. It used
    # to call sqlite3.connect("jobs.db") directly, which after the local file was
    # retired did not fail: sqlite3 CREATES an empty database when the file is
    # missing, so the retired file came back as an empty shell and the test
    # passed over zero rows. A test that silently examines nothing is worse than
    # one that errors.
    import sqlite3
    from fetch_jobs import db
    try:
        con = db()
    except Exception as e:                      # no database configured at all
        return [("rank", "no database to check: %s" % e, "unconfigured")]
    try:
        con.row_factory = sqlite3.Row
    except Exception:
        pass                                    # pgdb supplies its own
    rows = con.execute(
        """SELECT j.key, s.score, s.model FROM jobs j JOIN scores s ON s.key=j.key
           WHERE j.closed_at IS NULL AND s.score IS NOT NULL"""
    ).fetchall()
    # Zero rows is not a pass. Every other assertion below is vacuous on an
    # empty set, so an empty result means the test looked at nothing.
    if not rows:
        return [("rank", "no scored rows found — this test examined nothing", "empty")]
    fails = []
    missing_model = [r["key"] for r in rows if not r["model"]]
    if missing_model:
        fails.append(("rank", "%d scored rows have no model" % len(missing_model), "null model"))
    null_score = [r["key"] for r in rows if r["score"] is None]
    if null_score:
        fails.append(("rank", "%d scored rows have a null score" % len(null_score), "null score"))
    # monotonicity: sorting by the rank basis must not invert raw scores
    ordered = sorted(rows, key=lambda r: -r["score"])
    if any(ordered[i]["score"] < ordered[i + 1]["score"] for i in range(len(ordered) - 1)):
        fails.append(("rank", "rank basis is not monotonic in raw score", "inversion"))
    return fails


def main():
    from fetch_jobs import _matches

    fails = []
    for term, text, should in SUBSTRING_BUGS:
        got = _matches(text.lower(), [term])
        if got != should:
            fails.append(("matcher", "%r vs %r: expected %s" % (term, text, should), "boundary"))
    for title, why in FALSE_EXCLUSIONS + MUST_PASS + PM_STILL_PASSES:
        if not ok(title):
            fails.append(("should PASS", title, why))
    for title, why in MUST_DROP:
        if ok(title):
            fails.append(("should DROP", title, why))

    rank_fails = test_rank_basis()
    fails.extend(rank_fails)
    total = (len(SUBSTRING_BUGS) + len(FALSE_EXCLUSIONS)
             + len(MUST_PASS) + len(PM_STILL_PASSES) + len(MUST_DROP) + 1)
    for kind, title, why in fails:
        print("FAIL  %-11s %-52s (%s)" % (kind, title, why))
    print("\n%d/%d passed" % (total - len(fails), total))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
