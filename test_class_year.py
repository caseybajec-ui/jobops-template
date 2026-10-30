#!/usr/bin/env python3
"""Tests for the class-year rule. Run: python test_class_year.py

The owner graduates in classify.GRAD_MONTH of classify.GRAD_YEAR, read from
profile.json through owner.py. Every case here is a real title from a real
board, and each one is here because the rest of the pipeline cannot see the
problem: these roles are not senior, not foreign, not underpaid, and say "New
Grad" in the title.

THE YEARS ARE DERIVED, NOT TYPED. The titles were collected when the owner's
class was 2027; the cases substitute the year before, the owner's year and the
year after from classify.GRAD_YEAR, so the same test holds for whichever class
profile.json names. The months are asserted relative to GRAD_MONTH the same way.

The word-boundary cases are the ones that will break again if this is rewritten
carelessly. "International" must never match the internship pattern.
"""
import calendar
import io
import sys

from classify import class_fit, start_detail, GRAD_YEAR, GRAD_MONTH
from console import utf8_stdout

Y = GRAD_YEAR                 # the owner's class
Y0 = GRAD_YEAR - 1            # the class before
Y2 = GRAD_YEAR + 1            # the class after
# A month strictly before graduation and one strictly after, by name, so the
# "starts before graduation" branch is driven whatever month profile.json says.
# A January graduation has no earlier month; the before-case then uses the
# previous December, which the classifier reads as the year before.
_BEFORE = calendar.month_name[GRAD_MONTH - 1] if GRAD_MONTH > 1 else None
_AFTER = calendar.month_name[GRAD_MONTH + 1] if GRAD_MONTH < 12 else None
MONTH = calendar.month_name[GRAD_MONTH]

# (title, expected, why it is here)
CASES = [
    # --- should be excluded: the class before the owner's -----------------
    (f"Software Engineer, New Grad (Dec {Y0})", "wrong_year", "Notion, on screen as new-grad"),
    (f"Software Engineer - New Grad (December {Y0})", "wrong_year", "Applied Intuition"),
    (f"Hardware Integration Engineer - New Grad (December {Y0})", "wrong_year", "Applied Intuition"),
    (f"Technical Support Engineer - University Graduate {Y0}", "wrong_year", "Verkada"),
    (f"{Y0} Early Career Software Engineer", "wrong_year", "Anduril, year leads the title"),
    (f"{Y0} Early Career Mechanical Engineer", "wrong_year", "Anduril"),
    (f"Analyst, Class of {Y0}", "wrong_year", "explicit class"),
    (f"Associate — Fall {Y0} start", "wrong_year", "starts before the owner graduates"),
    (f"Software Engineer, Class of {Y2}", "wrong_year", "the class after the owner's"),

    # --- should be excluded: internship-shaped, any year -------------------
    (f"Summer Analyst {Y}", "wrong_year", "Bessemer, an internship"),
    ("Summer Associate, Investment Team", "wrong_year", "internship"),
    ("Software Engineering Intern", "wrong_year", "internship"),
    (f"Product Design Internship - Summer {Y}", "wrong_year", "internship"),
    (f"Electrical Engineering Spring Co-op (January {Y})", "wrong_year", "Shield AI, co-op"),

    # --- should pass: the owner's class -----------------------------------
    (f"[{Y}] Software Engineer, Early Career", "ok", "Roblox, acceptance case"),
    (f"Full Time Analyst {Y}", "ok", "Bessemer, acceptance case"),
    (f"APM, New Grad ({Y} Start)", "ok", "Databricks, acceptance case"),
    ("Software Engineer, New Grad", "ok", "no year stated — fail open"),
    ("Deployment Strategist", "ok", "no year stated at all"),
    ("Forward Deployed Software Engineer, New Grad - US Government", "ok", "Palantir, no year"),
    (f"Analyst, Class of {Y}", "ok", "the owner's class, explicit"),

    # --- bare year in the title, no month or grad word beside it ----------
    # These passed only because nothing matched, which meant the earlier-class
    # forms passed too. A year in a title this short is naming a class.
    (f"Full Time Analyst {Y0}", "wrong_year", "bare year, previous class"),
    (f"[{Y0}] Software Engineer, Early Career", "wrong_year", "bracketed previous class"),
    (f"[{Y}] Software Engineer, Early Career", "ok", "bracketed, the owner's class"),
    (f"Analyst Program {Y2}", "wrong_year", "bare year, later class"),

    # --- word boundaries: these must NOT read as internships --------------
    ("International Operations Associate", "ok", "'intern' is a substring of International"),
    ("Manager, International Growth", "ok", "International again"),
    ("Internal Product Engineer, Developer Products", "ok", "'Internal' is not 'Intern'"),
    ("Internal Audit Analyst", "ok", "Internal"),
    ("Cooperative Systems Engineer", "ok", "'Cooperative' is not 'Co-op'"),
    ("Coordinator, Campus Programs", "ok", "not an internship"),
]

# --- the month boundary, relative to GRAD_MONTH ---------------------------
# A start in the owner's year but before the graduation month is the wrong
# cycle; one after it is fine. With a May graduation these were "Spring 2027"
# (March, before May), "Summer 2027" (June, after) and "August 2027".
if _BEFORE:
    CASES.append((f"Product Manager, New Grad ({_BEFORE} {Y})", "wrong_year",
                  f"{_BEFORE} {Y}, before {MONTH}"))
if GRAD_MONTH > 3:
    CASES.append((f"Product Manager, New Grad (Spring {Y})", "wrong_year",
                  f"March {Y}, before {MONTH}"))
if GRAD_MONTH <= 6:
    CASES.append((f"Business Analyst — starting Summer {Y}", "ok",
                  f"June {Y}, not before {MONTH}"))
if _AFTER:
    CASES.append((f"New Grad Software Engineer ({_AFTER} {Y})", "ok", "after graduation"))

# The constants themselves: read from profile.json, and sane.
assert isinstance(GRAD_YEAR, int) and 2020 <= GRAD_YEAR <= 2035, GRAD_YEAR
assert 1 <= GRAD_MONTH <= 12, GRAD_MONTH


def main():
    utf8_stdout()
    bad = []
    for title, expected, why in CASES:
        got = class_fit(title)
        if got != expected:
            bad.append((title, expected, got, why))

    n = len(CASES)
    print("%d/%d passed" % (n - len(bad), n))
    if bad:
        print("\nFAILURES:")
        for title, expected, got, why in bad:
            sy, sm, cy, text = start_detail(title)
            print("  %-58s expected %-10s got %-10s  (%s)"
                  % (title[:58], expected, got, why))
            print("      start_year=%s start_month=%s class_year=%s matched=%r"
                  % (sy, sm, cy, text))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
