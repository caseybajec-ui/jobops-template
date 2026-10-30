#!/usr/bin/env python3
"""Tests for gate detection. Run: python test_gates.py

Every gate here DELETES a role, so a false positive is unrecoverable — the owner
never learns the posting existed. These cases are the ones that distinguish
"this posting states X about itself" from "this posting is about the subject X",
which is the distinction each of these patterns exists to make.
"""
import io
import sys

from score_jobs import kill_sentence, clearance_status, temp_detail, outside_us_detail, yoe_detail
from console import utf8_stdout

# --- clearance -------------------------------------------------------------
# The body patterns are sentence-shaped and want "active"/"current" beside
# "clearance". Titles write it as a tag, so a title-stating role read as
# none_mentioned and landed in the inbox. Vannevar Labs' Oahu role did exactly
# that.
CLEARANCE = [
    ("Forward Deployed Engineer - Oahu (TS/SCI Clearance Required)", "", "required_active"),
    ("Forward Deployed Engineer (TS/SCI Clearance Required)", "", "required_active"),
    ("Software Engineer, Active Clearance, Air Defense", "", "required_active"),
    ("Program Manager, Connected Warfare (Active Clearance)", "", "required_active"),
    ("Quality Specialist, Intelligence Systems (Secret Clearance)", "", "required_active"),
    ("Solutions Engineer (Clearance Required)", "", "required_active"),
    ("Senior Site Reliability Engineer, TS Clearance", "", "required_active"),
    # ...but a softened or eligibility-shaped title is NOT a requirement.
    ("Engineer, clearance preferred", "", "none_mentioned"),
    ("Engineer - Clearance Eligible", "", "none_mentioned"),
    ("Engineer (Clearance Sponsorship Available)", "we sponsor clearance", "sponsorable"),
    ("Mission Operations Specialist", "ability to obtain a security clearance", "eligibility_only"),
    # Anduril writes this; it must not read as a hard requirement.
    ("Mission Software Engineer",
     "an active security clearance is helpful but not required", "none_mentioned"),
    # Databricks, verbatim. A hard requirement, in a document that also says
    # "strongly encouraged to apply" further down — the softener must be judged
    # by proximity, not document-wide, or this reads as optional.
    ("Head of AI Forward Deployed Engineering (FDE), Public Sector",
     "PLEASE NOTE: Due to federal contract requirements and client site access "
     "obligations, an active U.S. government security clearance is required. The "
     "position is based in the Washington, D.C. area and includes periodic on-site "
     "work and client collaboration. Candidates with an active secret or higher "
     "clearance are strongly encouraged to apply.", "required_active"),
    # Same company, opposite meaning: ELIGIBILITY for a clearance is required,
    # which is not the same as holding one, and he can do it.
    ("Forward Deployed Engineer (FDE) - Public Sector",
     "Due to federal contract requirements, U.S. citizenship and eligibility for "
     "a U.S. government secret clearance are required to access classified "
     "information. Candidates with an active Secret or higher clearance are "
     "strongly encouraged to apply.", "eligibility_only"),
    # Applied Intuition, verbatim, on an entry-level Defense Physical AI role.
    # "hold OR BE ELIGIBLE FOR" is the door he can walk through, and reading it
    # as a hard requirement would delete a tier-1 target outright.
    ("Software Engineer - Defense Physical AI",
     "Must hold or be eligible for a U.S. Secret security clearance",
     "eligibility_only"),
    ("Defense Software Engineer",
     "Must hold or be eligible for a U.S. Secret security clearance",
     "eligibility_only"),
    # Anduril, verbatim: no alternative offered, so this one really is hard.
    ("Technical Program Manager - Advanced Effects",
     "Must possess and be able to maintain an active U.S. Top Secret security "
     "clearance", "required_active"),
    ("Deployment Strategist", "", "none_mentioned"),
]

# --- contract / temp -------------------------------------------------------
# Across 9,798 open postings, 112 titles mention contract/temp/seasonal/
# part-time. They split cleanly, and the split is the test.
CONTRACT_YES = [
    "Technical Recruiter (Contract)",
    "Technical Recruiter [6 Month Contract]",
    "Technical Recruiter (Temp to Hire)",
    "Recruiting Scheduler (Fixed Term Contract)",
    "Talent Sourcer (Contractor)",
    "University Recruiter, Contract",
    "Program Manager - Growth Operations, Contract",
    "Growth Recruiter, High Volume - Contract",
    "[Contract] Language Training Specialist - Japanese",
    "Workplace Technology Operation (Contractor), Dublin",
    "Developer Engagement Representative - LATAM (Part-Time Contract)",
    "Global Payroll Operations Specialist (Sweden) - Fixed Term Contract",
]
CONTRACT_NO = [
    # The word is the subject matter, not the employment type.
    "Contracts Manager",
    "Government Contracts Manager",
    "Senior Manager, Government Contracts",
    "Contract Administrator",
    "Commercial Contracts Specialist",
    "Contract Management Lead (Procurement)",
    "Contracting Operations Specialist",
    "Software Engineer - Smart Contract, Bridge",
    "Global Supply Manager - Contract Manufacturing",
    "Product Lead, Contractors",
    "Shipyard Contractor & Trade Partner Integration",
    "Contractor Special Security Officer",
    "Legal Counsel - US Government Contracts",
    "Supervisor, Sales and Contract Administration",
    "Legal Program Manager, Contracts and Governance",
    "Physical Security Design Lead and Contract Document Specialist",
    "Senior Contracts Manager – International",
    # An ordinary title with none of these words at all.
    "Deployment Strategist",
]

# --- location --------------------------------------------------------------
# The US hint is tested BEFORE the non-US hint, which is what protects every
# ambiguous US place name. These all have a foreign twin city.
LOCATION_US = ["Vancouver, WA", "Portsmouth, NH", "Portsmouth, VA", "London, KY",
               "Paris, TX", "Berlin, CT", "Moscow, ID", "Albuquerque, NM",
               "New Mexico", "Ontario, CA", "Manchester, NH", ""]
LOCATION_NOT_US = ["London, UK", "Mexico City", "Vancouver, British Columbia, Canada",
                   "Portsmouth, UK", "Tokyo, Japan", "Abu Dhabi, United Arab Emirates"]


# ------------------------------------------------------ the sentence, printed
#
# A PHRASE CANNOT TELL YOU WHICH FACT YOU HAVE. "This is not a contract
# position" and "this is a 6-month contract position" produce the identical row
# in the kill list, and until the sentence was printed beside each kill the only
# way to tell them apart was a database query per row. That cost is why a review
# of fourteen kills took a session instead of a glance.
#
# kill_sentence DECIDES NOTHING. These check that it SHOWS the right thing — and
# the part that actually breaks is the boundary rule: a naive split on ". " cuts
# "across the U.S., Europe" in three and reports a fragment that reads as a
# different fact from the sentence it came from. That is the same period-inside-
# an-abbreviation bug the clearance patterns already had once.
# "U.S. and Europe", not "U.S., Europe". The comma form does not discriminate:
# a naive split on ". " does not break "U.S.," either, because that period is
# followed by a comma rather than a space. The form that separates a correct
# boundary rule from a naive one is a period, a SPACE, then a lowercase word —
# which is exactly how the sentence that deleted two Kansas roles is written.
SENT_DESC = (
    "Shield AI is a defense company. With offices and facilities across the "
    "U.S. and Europe, our technology supports operations worldwide. "
    "Commitment: This is a fully remote, US-based part-time "
    "contract position staffed via HireArt. Apply today."
)

SENTENCE = [
    (SENT_DESC, "contract position",
     "Commitment: This is a fully remote, US-based part-time contract position "
     "staffed via HireArt.",
     "the whole sentence, not a fragment around the phrase"),
    (SENT_DESC, "Europe",
     "With offices and facilities across the U.S. and Europe, our technology "
     "supports operations worldwide.",
     "a period inside U.S. does not end a sentence"),
    # Case-insensitive: the stored phrase is whatever the regex captured, and
    # the description may differ from it in case.
    ("Our 2027 Co-Op program is good.", "co-op program",
     "Our 2027 Co-Op program is good.", "the phrase is found regardless of case"),
    # Nothing to show is shown as nothing, never as a wrong sentence.
    (SENT_DESC, "not in this text", "", "a phrase that is not there returns nothing"),
    ("", "contract position", "", "no description, no sentence"),
    (SENT_DESC, "", "", "no phrase, no sentence"),
]


def main():
    utf8_stdout()
    fails = []
    n = 0

    for title, desc, want in CLEARANCE:
        n += 1
        got = clearance_status(title, desc)
        if got != want:
            fails.append("clearance %-58s got %s, want %s" % (title[:58], got, want))

    for title in CONTRACT_YES:
        n += 1
        if not temp_detail(title, "")[0]:
            fails.append("contract %-58s should have matched" % title[:58])
    for title in CONTRACT_NO:
        n += 1
        hit, phrase, _f = temp_detail(title, "")
        if hit:
            fails.append("contract %-58s wrongly matched %r" % (title[:58], phrase))

    for loc in LOCATION_US:
        n += 1
        if outside_us_detail(loc)[0]:
            fails.append("location %-58s wrongly read as non-US" % loc[:58])
    for loc in LOCATION_NOT_US:
        n += 1
        if not outside_us_detail(loc)[0]:
            fails.append("location %-58s should have read as non-US" % loc[:58])

    for desc, phrase, want, why in SENTENCE:
        n += 1
        got = kill_sentence(desc, phrase)
        if got != want:
            fails.append("sentence %-46s got %r, want %r" % (why[:46], got[:70], want[:70]))

    # The U.S. that sits beside the matched place name is the entire reason to
    # print the sentence: the gate read "Europe" and deleted a Kansas role out
    # of a sentence that says "across the U.S., Europe".
    n += 1
    if "U.S. and Europe" not in kill_sentence(SENT_DESC, "Europe"):
        fails.append("sentence  the U.S. beside the matched place name was cut away")

    # A description with no sentence break must not print 4,000 characters.
    n += 1
    if len(kill_sentence("word " * 400 + "contract position here", "contract position")) > 151:
        fails.append("sentence  a runaway sentence is not being cut")

    # A years figure is only a requirement when a requirement marker precedes it.
    n += 1
    if yoe_detail("Minimum requirements: 5+ years of experience")[0] != 5:
        fails.append("yoe: a stated minimum should be read")
    n += 1
    if yoe_detail("Preferred qualifications: 8+ years of experience")[0] is not None:
        fails.append("yoe: a preferred qualification is not a requirement")

    print("%d/%d passed" % (n - len(fails), n))
    if fails:
        print("\nFAILURES:")
        for f in fails:
            print("  " + f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
