#!/usr/bin/env python3
"""Two resume PDFs for the fictional example person, so the template builds.

    python setup/make_example_resumes.py

Writes web/public/resume/resume-tech.pdf and resume-finance.pdf for "Jordan
Reyes" (profile.example.json), then the markdown the tool reasons from. This
exists so a fresh clone can run the full test suite and `npm run build` BEFORE
a real person's resume is in place -- which is how the template itself is
verified. The setup step for a real person overwrites all four files and
`setup/check_setup.py` refuses to call an instance ready while these are the
ones in place.

Nothing here is a real person. Every number is invented and matches
profile.example.json on purpose, so the pack critic's "every claim traces to
the profile" check can be exercised against known-good input.
"""
from __future__ import annotations

import os
import subprocess
import sys

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "public", "resume")

NAME = "JORDAN REYES"
HEAD = "Austin, TX  |  jordan.reyes@example.edu  |  (512) 555-0100  |  linkedin.com/in/jordan-reyes-example"

EDU = [
    ("EDUCATION", None),
    ("Westlake University, Hayden School of Business", "Austin, TX"),
    ("B.S. Business Administration, GPA 3.8", "Expected May 2027"),
]

EXPERIENCE = [
    ("Campus Textbook Marketplace", "Founder", "Austin, TX", "Jan 2025 - Present", [
        "Founded and ran a campus textbook marketplace; 1,200 registered students, 3,400 listings, $41K in transactions over two semesters.",
        "Built the site with AI-assisted development and ran payments through Stripe; cut listing-to-sale time from 9 days to 3.",
    ]),
    ("Series B Fintech", "Strategy & Operations Intern", "San Francisco, CA", "Summer 2026", [
        "Built the weekly KPI dashboard used by the COO; cut report prep from 6 hours to 40 minutes.",
        "Wrote the pricing memo that led to a two-tier plan; modeled unit economics for both tiers.",
    ]),
    ("Student Consulting Group", "Analyst", "Austin, TX", "Spring 2026", [
        "Ran 25 customer interviews and a competitor pricing scan for a regional grocery chain.",
        "Recommended a delivery pilot the client launched in three stores.",
    ]),
    ("Long/Short Equity Fund", "Research Intern", "Dallas, TX", "Summer 2025", [
        "Maintained supply/demand models for two industrial names; wrote four initiation memos, one of which became a position.",
    ]),
]

LEADERSHIP = [
    "President, Social-Impact Club: grew membership from 40 to 110, raised $22K for a local nonprofit, led 6 officers.",
    "Intramural soccer; campus hackathon volunteer.",
]

SKILLS_TECH = [
    ("Engineering", "AI-assisted development (Claude Code) across Python and JavaScript, SQL, Stripe, Vercel"),
    ("Analysis", "Excel modeling, SQL, customer interviews, pricing analysis, memo writing"),
    ("Activities", "Social-impact club, student consulting group, intramural soccer"),
    ("Interests", "AI products, marketplaces, fintech, operations"),
]
SKILLS_FINANCE = [SKILLS_TECH[1], SKILLS_TECH[0], SKILLS_TECH[2], SKILLS_TECH[3]]


def draw(path, skills, lead_experience_first):
    c = canvas.Canvas(path, pagesize=LETTER)
    w, h = LETTER
    y = h - 0.6 * inch
    c.setFont("Helvetica-Bold", 16)
    c.drawCentredString(w / 2, y, NAME)
    y -= 16
    c.setFont("Helvetica", 9)
    c.drawCentredString(w / 2, y, HEAD)
    y -= 22

    def section(title):
        nonlocal y
        c.setFont("Helvetica-Bold", 11)
        c.drawString(0.6 * inch, y, title)
        c.line(0.6 * inch, y - 2, w - 0.6 * inch, y - 2)
        y -= 14

    def line(text, bold=False, right=None, indent=0.6):
        nonlocal y
        c.setFont("Helvetica-Bold" if bold else "Helvetica", 10)
        c.drawString(indent * inch, y, text)
        if right:
            c.setFont("Helvetica", 10)
            c.drawRightString(w - 0.6 * inch, y, right)
        y -= 12

    def bullet(text):
        nonlocal y
        c.setFont("Helvetica", 9.5)
        words = text.split()
        row, rows = "", []
        for word in words:
            if c.stringWidth(row + " " + word, "Helvetica", 9.5) > w - 1.5 * inch:
                rows.append(row)
                row = word
            else:
                row = (row + " " + word).strip()
        rows.append(row)
        for i, r in enumerate(rows):
            c.drawString(0.8 * inch, y, ("• " if i == 0 else "  ") + r)
            y -= 11.5

    section("EDUCATION")
    line(EDU[1][0], bold=True, right=EDU[1][1])
    line(EDU[2][0], right=EDU[2][1])
    y -= 6
    section("PROFESSIONAL EXPERIENCE")
    exp = EXPERIENCE if lead_experience_first else [EXPERIENCE[1], EXPERIENCE[3], EXPERIENCE[0], EXPERIENCE[2]]
    for org, title, place, when, bullets in exp:
        line(f"{org}, {title}", bold=True, right=f"{place} | {when}")
        for b in bullets:
            bullet(b)
        y -= 4
    section("LEADERSHIP")
    for b in LEADERSHIP:
        bullet(b)
    y -= 4
    section("SKILLS")
    for label, text in skills:
        line(f"{label}: {text}")
    c.save()


def main():
    os.makedirs(OUT, exist_ok=True)
    tech = os.path.join(OUT, "resume-tech.pdf")
    fin = os.path.join(OUT, "resume-finance.pdf")
    draw(tech, SKILLS_TECH, True)
    draw(fin, SKILLS_FINANCE, False)
    print("wrote", tech, "and", fin)
    for src, md in ((tech, "resume_tech.md"), (fin, "resume_finance.md")):
        r = subprocess.run([sys.executable, os.path.join(ROOT, "resume_from_pdf.py"), src, md],
                           cwd=ROOT, capture_output=True, text=True)
        print(r.stdout.strip() or r.stderr.strip())
        if r.returncode:
            sys.exit(r.returncode)


if __name__ == "__main__":
    main()
