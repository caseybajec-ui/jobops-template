#!/usr/bin/env python3
"""Turn a resume PDF into the markdown the tool reads.

    python resume_from_pdf.py "My_Resume.pdf" resume_tech.md

WHY THIS IS A SCRIPT AND NOT A TYPING JOB. Hard rule 4 is "never invent resume
content", and the most likely way to break it is not fabrication — it is a
transcription slip nobody notices, in a document that then gets sent to a
recruiter. Generating the markdown means the text cannot drift from the PDF,
and `python test_resume_parity.py` proves it line by line.

It is also the answer to "how do I drop in a replacement": overwrite the PDF in
web/public/resume/ and re-run this. No hand-editing of the .md, ever — anything
typed into it directly is lost on the next run, which is the point.

EXTRACTION IS pdftotext -layout, already on this machine via Git Bash's poppler.
No new dependency: CLAUDE.md says ask before adding one, and a resume converter
is not worth a wheel that may not build on win_arm64.

The bullet glyph comes out as U+FFFD because the PDF's font maps it privately
and poppler cannot resolve it. That is not corruption of the text — every other
character in both files is ASCII — so it is treated as the bullet marker it is.
"""
import hashlib
import io
import os
import re
import shutil
import subprocess
import sys

from console import utf8_stdout

# Every glyph a resume exports a bullet as. Word and Google Docs usually give
# pdftotext a symbol it cannot map (U+FFFD); LaTeX and ReportLab give a real
# U+2022; some templates use a hyphen or an en dash at the start of a line. A
# converter that knew one of these read the other resumes as prose with no
# bullets at all -- 0 bullets on a page with twelve -- and the identity check
# then refused the file as "not a resume".
BULLETS = ("�", "•", "▪", "◦", "·", "‣", "", "- ", "– ")
BULLET = "•"


def bullet_prefix(line):
    """The bullet glyph a stripped line starts with, or None."""
    for b in BULLETS:
        if line.startswith(b):
            return b
    return None

# Right-aligned second column: three or more spaces with real text either side.
# Two would catch sentence spacing; the PDF's columns are separated by dozens.
# Matched against the STRIPPED line: pdftotext -layout indents wrapped bullet
# text by a few spaces, and against the raw line that indentation read as an
# empty left column, which turned every wrapped continuation into a header.
TWO_COL = re.compile(r"^(\S.*?)\s{3,}(\S.*)$")
HEADING = re.compile(r"^[A-Z][A-Z&\s]{3,}$")
SKILL_LABEL = re.compile(r"^([A-Z][A-Za-z ]*):\s*(.*)$")


def extract(pdf):
    """The PDF's text, or a clear failure. Never a silent empty string."""
    try:
        out = subprocess.run(["pdftotext", "-layout", pdf, "-"],
                             capture_output=True, check=True)
    except FileNotFoundError:
        sys.exit("pdftotext is not on PATH. It ships with Git Bash's poppler;\n"
                 "  try /mingw64/bin/pdftotext, or install poppler-utils.")
    except subprocess.CalledProcessError as e:
        sys.exit("pdftotext failed on %s: %s" % (pdf, e.stderr.decode("utf-8", "replace")))
    text = out.stdout.decode("utf-8", "replace")
    # A converter that writes an empty file rather than failing is the
    # measured-nothing bug in a new costume.
    if len(text.strip()) < 500:
        sys.exit("pdftotext returned %d characters from %s — that is not a resume."
                 % (len(text.strip()), pdf))
    return text


def tidy(s):
    """One space between words, and the double hyphen restored to an em dash."""
    return re.sub(r"\s+", " ", s).replace("--", "—").strip()


def convert(text):
    lines = [ln.rstrip() for ln in text.split("\n")]
    lines = [ln for ln in lines if ln.strip()]

    out = ["# %s" % tidy(lines[0]), ""]
    out.append(tidy(lines[1]).replace(" | ", " · "))
    out.append("")

    section = None
    pending_entry = None      # a two-column line waiting for its partner
    bullet = None             # the bullet being accumulated across wrapped lines
    skill = None              # the skills line being accumulated

    def flush_bullet():
        nonlocal bullet
        if bullet:
            out.append("- %s" % tidy(bullet))
            bullet = None

    def flush_skill():
        nonlocal skill
        if skill:
            label, rest = skill
            out.append("**%s:** %s" % (label, tidy(rest)))
            skill = None

    def flush_entry():
        """A two-column header that never got its partner line.

        Many resumes put the whole header on ONE line -- "Org, Title" left,
        "City | Dates" right -- rather than the two-line shape the original
        converter was written against. Dropping it silently turned every job
        into a bulleted list with no employer above it, which test_resume_parity
        cannot see (it compares the PDF to whatever the converter produced).
        Emit what we have, as a header, and move on.
        """
        nonlocal pending_entry
        if pending_entry is not None:
            name, place = pending_entry
            out.append("**%s** · %s" % (name, place))
            out.append("")
            pending_entry = None

    for raw in lines[2:]:
        line = raw.strip()

        if HEADING.match(line):
            flush_bullet()
            flush_skill()
            flush_entry()
            section = line
            while out and not out[-1].strip():
                out.pop()                 # exactly one blank line before a rule
            out += ["", "---", "", "## %s" % line, ""]
            continue

        glyph = bullet_prefix(line)
        if glyph:
            flush_bullet()
            flush_entry()
            bullet = line[len(glyph):]
            continue

        m = TWO_COL.match(line)
        if m:
            # A two-column line ENDS whatever bullet was open. Wrapped bullet
            # text is left-aligned prose and never carries a wide column gap,
            # so this cannot swallow a continuation — whereas the reverse did
            # happen: every employer after the first was absorbed into the last
            # bullet of the job above it ("...daily review. Govic Capital /
            # Civog Funds Los Angeles, CA Strategy & Research Intern").
            flush_bullet()
            left, right = tidy(m.group(1)), tidy(m.group(2))
            if pending_entry is None:
                pending_entry = (left, right)
            else:
                name, place = pending_entry
                if section == "EDUCATION":
                    # Two lines, because that is what resume_current.md does
                    # here and the detail is a qualification, not a job title.
                    out.append("**%s** · %s" % (name, place))
                    out.append("%s · %s" % (left.replace(" | ", " · "), right))
                else:
                    out.append("**%s** — %s · %s · %s"
                               % (name, left, place, right))
                out.append("")
                pending_entry = None
            continue

        if section and section.startswith("SKILLS"):
            sm = SKILL_LABEL.match(line)
            if sm:
                flush_skill()
                skill = [sm.group(1), sm.group(2)]
            elif skill:
                skill[1] += " " + line
            continue

        if bullet is not None:
            bullet += " " + line          # a wrapped continuation
        elif pending_entry is not None:
            # A one-column line where a partner was expected: emit what we have
            # rather than dropping it silently, then the line itself.
            flush_entry()
            out.append(tidy(line))
            out.append("")

    flush_bullet()
    flush_skill()

    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- identity
#
# THE HIGHEST-CONSEQUENCE SILENT SUCCESS THIS TOOL CAN PRODUCE is regenerating
# resume_tech.md from the finance PDF. Nothing would error. test_resume_parity.py
# would pass, because it asserts the markdown matches WHATEVER PDF is sitting
# there — it is a parity check, not an identity check. The tool would then feed
# consulting framing to every defense application, confidently, forever.
#
# That is not hypothetical. Three consecutive replacement attempts went wrong in
# three different ways on 2026-09-02: two copies of the FINANCE resume landed in
# web/public/resume/ while both correct PDFs were deleted; a path reported as
# updated was untouched; and a named file turned out to be the exact PDF already
# committed. Every one of them would have converted cleanly.
#
# So the checks run on the SOURCE, BEFORE the copy. After the copy is too late:
# by then the wrong document is the one on disk and every check agrees with it.

VARIANTS = {
    # variant: (canonical pdf path, canonical markdown, first skills label)
    "tech":    ("web/public/resume/resume-tech.pdf",
                "resume_tech.md", "Engineering"),
    "finance": ("web/public/resume/resume-finance.pdf",
                "resume_finance.md", "Analysis"),
}

SKILL_LEAD = re.compile(r"^(Engineering|Analysis):", re.M)


def _owner_name_in(text):
    """The owner's name, as profile.json spells it, anywhere in the text.

    Case- and whitespace-insensitive, because pdftotext -layout can split a
    header across columns. The original checked one person's full name in
    capitals; a template checks whoever profile.json says the owner is.
    """
    from owner import OWNER
    want = re.sub(r"\s+", " ", OWNER["name"]).strip().lower()
    have = re.sub(r"\s+", " ", text).lower()
    return bool(want) and want in have


def identity(text):
    """What this PDF actually is, judged on structure rather than wording.

    The lead skills label is the fingerprint when the resume has one: the tech
    variant leads with "Engineering:", the finance one with "Analysis:", and
    they carry the same labels in a different order. It survives content edits,
    which a check for today's phrasing would not. A resume with no such line
    fingerprints as None, and install then TRUSTS THE SLOT NAMED on the command
    line and says so -- a template cannot insist on one skills layout.
    """
    lead = SKILL_LEAD.search(text)
    return {
        "variant": {"Engineering": "tech", "Analysis": "finance"}.get(
            lead.group(1) if lead else None),
        "is_resume": _owner_name_in(text),
        "sections": len(re.findall(r"^[A-Z][A-Z&\s]{3,}$", text, re.M)),
        "bullets": sum(1 for ln in text.splitlines() if bullet_prefix(ln.strip())),
    }


def check(text, expect, contains=(), source=None, dest=None):
    """Every reason to refuse, collected. Empty list means it may be copied."""
    bad = []
    seen = identity(text)

    if not seen["is_resume"]:
        bad.append("it does not contain the owner's name from profile.json — "
                   "this is not the owner's resume")
    if seen["sections"] < 3:
        bad.append("only %d section headings found, expected at least 3 "
                   "(e.g. EDUCATION / EXPERIENCE / SKILLS in capitals)"
                   % seen["sections"])
    if seen["bullets"] < 6:
        bad.append("only %d bullets found — the extraction is wrong or the file is"
                   % seen["bullets"])

    # THE ONE THAT MATTERS. Handing the finance PDF to the tech slot is the
    # failure this whole flag exists for, and it is the failure that looks most
    # like success. It can only be judged when the resume carries the skills
    # fingerprint; without one the slot you named is trusted, out loud.
    if seen["variant"] is None:
        print("note: no Engineering:/Analysis: skills line to fingerprint the "
              "variant; trusting the %s slot you named" % expect)
    elif seen["variant"] != expect:
        bad.append(
            "this is the %s resume, not the %s one — its skills lead with \"%s:\"\n"
            "       Copying it would put %s framing in front of every %s application."
            % (seen["variant"] or "unrecognised", expect,
               VARIANTS[expect][2] if seen["variant"] == expect else
               ("Analysis" if seen["variant"] == "finance" else "Engineering"),
               seen["variant"] or "unknown",
               "defense and product" if expect == "tech" else "consulting and VC"))

    for want in contains:
        if want.lower() not in text.lower():
            bad.append("it does not contain %r — the edit you described is not in "
                       "this file" % want)

    # A file identical to the one already in place is not an update. This is
    # exactly attempt three: a named PDF that was the committed file itself.
    if source and dest and os.path.exists(dest):
        if _md5(source) == _md5(dest):
            bad.append("it is byte-identical to %s — nothing would change" % dest)

    return bad


def _md5(path):
    h = hashlib.md5()
    with io.open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def write_md(pdf, md):
    body = convert(extract(pdf))
    # utf-8 AND newline="\n": bare open() inherits cp1252 and rewrites every
    # newline as CRLF, which test_line_endings.py fails on. Four separate bugs
    # in this project came from that one line.
    io.open(md, "w", encoding="utf-8", newline="\n").write(body)
    print("%s -> %s  (%d chars, %d bullets)"
          % (pdf, md, len(body), body.count("\n- ")))


USAGE = """usage:
  resume_from_pdf.py <pdf> <md> [--expect tech|finance] [--expect-contains TEXT]...
      Regenerate a markdown file from a PDF already in place.

  resume_from_pdf.py install <source.pdf> tech|finance [--expect-contains TEXT]...
      VERIFY the source, then copy it into web/public/resume/ and regenerate.
      The checks run before the copy; a failure copies nothing.

  --expect-contains may be repeated. Use it for the specific edit you just made
  ("Python", "AI-assisted development"), on top of the structural checks that
  always run."""


def main():
    utf8_stdout()
    args = sys.argv[1:]
    contains = []
    while "--expect-contains" in args:
        i = args.index("--expect-contains")
        if i + 1 >= len(args):
            sys.exit("--expect-contains needs a value")
        contains.append(args[i + 1])
        del args[i:i + 2]
    expect = None
    if "--expect" in args:
        i = args.index("--expect")
        if i + 1 >= len(args):
            sys.exit("--expect needs tech or finance")
        expect = args[i + 1]
        del args[i:i + 2]

    if args and args[0] == "install":
        if len(args) != 3 or args[2] not in VARIANTS:
            sys.exit(USAGE)
        source, variant = args[1], args[2]
        dest, md, _ = VARIANTS[variant]
        if not os.path.exists(source):
            sys.exit("no such file: %s" % source)

        bad = check(extract(source), variant, contains, source=source, dest=dest)
        if bad:
            # The headline follows the reason. Saying "is not the tech resume"
            # about a file that IS the tech resume, merely unchanged, is the
            # kind of confidently-wrong message that teaches you to stop
            # reading them.
            print("REFUSED — nothing was copied. %s cannot be installed as the "
                  "%s resume:\n" % (source, variant))
            for b in bad:
                print("  - %s" % b)
            print("\nThe checks run BEFORE the copy on purpose. Afterwards the wrong\n"
                  "document is the one on disk and every later check agrees with it.")
            return 2

        shutil.copyfile(source, dest)
        print("verified as the %s resume -> copied to %s" % (variant, dest))
        write_md(dest, md)
        return 0

    if len(args) != 2:
        sys.exit(USAGE)
    pdf, md = args
    if expect:
        if expect not in VARIANTS:
            sys.exit("--expect takes tech or finance, not %r" % expect)
        bad = check(extract(pdf), expect, contains)
        if bad:
            print("REFUSED — %s was NOT rewritten. %s failed the %s checks:\n"
                  % (md, pdf, expect))
            for b in bad:
                print("  - %s" % b)
            return 2
    write_md(pdf, md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
