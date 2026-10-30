#!/usr/bin/env python3
"""The markdown resumes still say what the PDFs say. Run: python test_resume_parity.py

WHY THIS IS NOT OPTIONAL. resume_tech.md and resume_finance.md are what the tool
reasons from; the PDFs in web/public/resume/ are what the owner actually sends. If
those two drift, every talking point the tool produces cites a bullet the
interviewer cannot see on the page in front of them — the same failure CLAUDE.md
guards with `not_on_resume`, arriving by a different route.

THE ASSERTION IS REGENERATION, not resemblance. Each .md must equal exactly what
resume_from_pdf.py produces from its PDF today. That catches the two ways they
drift: someone hand-edits the markdown (it is generated; edits are meant to be
lost), or someone drops in a new PDF and forgets to re-run the converter.

It also checks the facts a resume is actually wrong about — GPA, graduation,
every employer — so a converter that broke and produced matching garbage on both
sides cannot pass. "What would this print if it were pointed at nothing?"
"""
import io
import os
import sys

from console import utf8_stdout
from resume_from_pdf import convert, extract

PAIRS = [
    ("web/public/resume/resume-tech.pdf", "resume_tech.md"),
    ("web/public/resume/resume-finance.pdf", "resume_finance.md"),
]

# Facts that must survive any extraction. Not a style check — these are the
# things a resume is materially wrong about if they are missing. Read from
# profile.json, because the original listed one person's employers here and
# a template cannot: the owner's name and graduation are the two facts every
# resume carries, and the only two this file can know.
from owner import OWNER

MUST_APPEAR = [
    OWNER["name"],
    OWNER["graduation"],
]

PASS = []
FAIL = []


def ok(cond, what):
    (PASS if cond else FAIL).append(what)


def main():
    utf8_stdout()

    checked = 0
    for pdf, md in PAIRS:
        if not os.path.exists(pdf):
            FAIL.append("%s is missing — the served PDF is the source of truth" % pdf)
            continue
        if not os.path.exists(md):
            FAIL.append("%s is missing — run resume_from_pdf.py" % md)
            continue

        on_disk = io.open(md, encoding="utf-8").read()
        regenerated = convert(extract(pdf))

        ok(on_disk == regenerated,
           "%s is exactly what %s produces today\n"
           "         (%d chars on disk, %d regenerated — re-run "
           "`python resume_from_pdf.py %s %s`)"
           % (md, os.path.basename(pdf), len(on_disk), len(regenerated), pdf, md))

        for fact in MUST_APPEAR:
            ok(fact.lower() in on_disk.lower(), "%s still says %r" % (md, fact))

        # Positive assertions, so an empty or collapsed file cannot pass the
        # equality check above by matching an equally empty regeneration.
        bullets = on_disk.count("\n- ")
        ok(bullets >= 6, "%s kept %d bullets" % (md, bullets))
        ok(on_disk.count("\n**") >= 4,
           "%s kept its entry headings (%d)" % (md, on_disk.count("\n**")))
        ok("\r" not in on_disk, "%s has no CRLF" % md)
        checked += 1

    # ------------------------------------------------------------------
    # THE IDENTITY CHECKS REFUSE THE THINGS THAT ACTUALLY HAPPENED.
    #
    # Parity proves the markdown matches the PDF beside it. It cannot tell you
    # the PDF is the RIGHT one — swap the two files and parity stays green while
    # every defense application carries consulting framing. That swap was one
    # command away three times in a row on 2026-09-02.
    from resume_from_pdf import VARIANTS, check, identity

    tech_txt = extract(VARIANTS["tech"][0])
    fin_txt = extract(VARIANTS["finance"][0])

    ok(identity(tech_txt)["variant"] == "tech", "the tech PDF is recognised as tech")
    ok(identity(fin_txt)["variant"] == "finance", "the finance PDF is recognised as finance")

    # Each accepted as itself, so the checks are not simply always-refusing.
    ok(check(tech_txt, "tech") == [], "the tech PDF passes the tech checks")
    ok(check(fin_txt, "finance") == [], "the finance PDF passes the finance checks")

    # THE DISASTER, both directions.
    ok(check(fin_txt, "tech") != [],
       "the FINANCE pdf is REFUSED as tech — the swap that parity cannot see")
    ok(check(tech_txt, "finance") != [],
       "and the TECH pdf is refused as finance")

    # An assertion about the specific edit, which is what --expect-contains is.
    ok(check(tech_txt, "tech", ["zzz-not-in-any-resume"]) != [],
       "a missing --expect-contains string refuses")
    ok(check(tech_txt, "tech", [OWNER["name"].split()[-1]]) == [],
       "and a present one does not")

    # ONE TABLE OF PATHS, TWO LANGUAGES. web/lib/variant.js decides what the app
    # serves; this decides what the converter writes. They must not drift, or
    # the installer writes a file the app never reads.
    js = io.open("web/lib/variant.js", encoding="utf-8").read()
    for name, (pdf, md, _lead) in VARIANTS.items():
        base = os.path.basename(pdf)
        ok(('filename: "%s"' % base) in js,
           "variant.js serves %s, the file resume_from_pdf.py installs" % base)
        ok(('source: "%s"' % md) in js,
           "variant.js names %s, the file resume_from_pdf.py writes" % md)

    # The guard against measuring nothing: if both pairs were skipped above,
    # every assertion is vacuous and the run would still print green.
    if checked != len(PAIRS):
        print("ABORT: examined %d of %d resume pairs. A parity test that checked "
              "nothing must not pass." % (checked, len(PAIRS)))
        return 2

    print("%d passed, %d failed  (%d pairs, %d assertions)"
          % (len(PASS), len(FAIL), checked, len(PASS) + len(FAIL)))
    for f in FAIL:
        print("  FAIL  %s" % f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
