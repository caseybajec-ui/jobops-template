#!/usr/bin/env python3
"""Fails if anything private is staged, or if a second database appears.

Run: python test_nothing_private_staged.py

`.gitignore` is the guard. This is the guard on the guard, because .gitignore
fails open in two ways that matter:

  * `git add -f` overrides it without complaint;
  * a file already TRACKED stays tracked forever, and adding its name to
    .gitignore does nothing at all.

Neither is loud. This is, and the pre-commit hook runs it, so the failure lands
before the commit rather than after the push.

Three checks:

  1. Nothing on the deny list is staged. `contacts.csv` and `outreach/` hold
     other people's names and contact details, and that is the line: the owner's own
     profile and resumes are in the repo deliberately, other people's
     information is not.

  2. Exactly one *.db exists in the tree. A stray empty `web/jobs.db` sat there
     for a day from a path mistake, which is precisely how you end up reading
     stale data and not knowing it.

  3. No dump of an AUTHENTICATED PAGE, and no file carrying a credential. A
     debug script wrote `web/daily.html` — the full signed-in Daily page, every
     role and every note — into the repo, and it was staged before anyone
     noticed. The deny list did not catch it because a page dump is not on the
     list, which is exactly the point: the list enumerates files, and this is a
     CATEGORY. A rendered private page is the same kind of thing as the files
     above, so the rule is now about content, not names.
"""
import io
import os
import re
import subprocess
import sys
from console import utf8_stdout

# Matched ANYWHERE in the repo-relative path. Only for names that are private
# wherever they appear: `.env` has to catch web/.env.local, which is a real file
# in a real subdirectory holding a live Anthropic key.
DENY_ANYWHERE = [
    ".env",
]

# ROOT-ANCHORED. These are private BECAUSE OF WHERE THEY ARE — the repo-root
# files holding other people's names, roles and contact details.
#
# THEY USED TO BE MATCHED AS BARE SUBSTRINGS AND IT BROKE A DEPLOY. `outreach/`
# anywhere in a path meant web/app/outreach/page.js — a perfectly ordinary Next
# route — was reported as a privacy violation and refused the commit. The
# identical over-match in .gitignore had already made that file invisible to
# `git status` entirely. One word, two guards, both wrong in the same direction:
# a rule about a repo-root directory silently became a rule about a NAME.
#
# The files themselves moved INTO Postgres (contacts and outreach tables) so the
# deployed app could read them without them ever entering the repo. The paths
# stay on this list anyway: a file that is no longer produced is not a file that
# is safe to commit, because the old one still has names in it.
DENY_ROOT = [
    "contacts.csv",
    "contacts.json",
    "outreach/",
    "outreach.csv",
    "voice/",
    "logs/",
    ".daily.lock",
]
DENY_SUFFIX = [".db", ".sqlite", ".sqlite3", ".pem", ".key"]
# A retired database is still a database. Renaming jobs.db to
# jobs.db.retired-<date> took it out of range of both the .db suffix and the
# bare `jobs.db` gitignore line at the same time.
#
# ANYWHERE, not root-anchored: a stray empty web/jobs.db sat in the tree for a
# day from a path mistake, which is how you end up reading stale data without
# knowing. A database is private wherever it is.
DENY_ANYWHERE.append("jobs.db")

# HTML anywhere in the repo is a dump until proven otherwise. Nothing here is
# authored as a static page: the app renders through Next.js, so a .html file is
# something a script wrote — and the one that appeared was a signed-in page.
# There is no allow-list because there is nothing to allow yet; when a real
# static page is needed, adding it here is a deliberate act.
HTML_ALLOW = set()

# Patterns that mean a file is carrying something it should not, whatever it is
# called. Checked against the file's TEXT, not its name.
#
# These match the VALUE, never the label. The first version matched
# "jobops_session=" and "postgresql://" as bare strings, and promptly failed on
# CLAUDE.md, HOSTING.md and on this file — all of which discuss the shape of a
# secret without holding one. A check that fires on its own documentation is a
# check you learn to skip, which is the same failure as a nag you cannot answer.
SECRET_PATTERNS = [
    # A signed session cookie: expiry, dot, base64url MAC.
    ("a live session cookie", re.compile(r"jobops_session=\d{10,}\.[A-Za-z0-9_\-]{20,}")),
    # A connection string WITH credentials in it.
    ("a database URL with credentials", re.compile(r"postgres(?:ql)?://[^\s/]+:[^\s@]+@")),
    ("an Anthropic API key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("a password assignment", re.compile(r"JOBOPS_PASSWORD\s*=\s*\S+")),
    ("a personal email address", re.compile(r"caseybajec@(?:icloud|gmail)\.com")),
    # THE PROFILE CARD'S OWN DATA. Phase 5 put the owner's street address and phone
    # number into the database, which is where they belong -- and one debug
    # script away from a file. That is not hypothetical: a script once wrote the
    # entire signed-in Daily page to web/daily.html and it was staged before
    # anyone noticed, because a page dump was not on the deny list.
    #
    # NO re.I on the address. The first attempt had it, which defeated the
    # capitalisation the pattern relies on -- "110 minutes that way" in
    # fetch_jobs.py matched as a street address. A street name is capitalised;
    # a sentence about minutes is not.
    ("a street address", re.compile(
        r"\b\d{1,5}\s+(?:[NSEW]\.?\s+)?[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+"
        r"(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|"
        r"Way|Court|Ct|Place|Pl|Terrace|Circle|Cir)\b\.?")),
    ("a phone number", re.compile(
        r"(?<![\d-])(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?![\d-])")),
]

# Exemptions, matched on the FULL REPO PATH rather than the basename.
#
# It compared basenames, which is both too loose and too surprising: any file
# anywhere called sf86.js would have been exempt, and "web/test_writes.mjs" in
# this set matched nothing at all, because the staged path never equals its own
# last segment. The commit that added the address patterns failed on exactly
# that.
SECRET_SCAN_SKIP = {
    # This file names the patterns, so it necessarily contains them.
    "test_nothing_private_staged.py",
    # DELIBERATE, and documented in CLAUDE.md: the resumes are in this private
    # repo on purpose, because they are what the owner hands a recruiter anyway --
    # and a resume carries a phone number. Failing the commit on them would be a
    # nag with no possible answer, which is how a guard stops being read.
    # The pair replaced resume_current.md on 2026-09-02; the retired copy keeps
    # its exemption because the phone number in it did not stop being his when
    # the file was renamed. The PDFs are the same documents and carry the same
    # number in their text -- they are what actually gets sent.
    "resume_tech.md", "resume_finance.md",
    "web/public/resume/resume-tech.pdf",
    "web/public/resume/resume-finance.pdf",
    # The owner's own cover letter, used as a voice sample by the pack
    # writer, and the profile card's own fields. Same reasoning as the
    # resumes: the owner's data, in the owner's private repo, on purpose.
    "cover_letter_example.md", "profile.json",
    # The SF-86 form's own placeholder text, "1234 Example St".
    "web/lib/sf86.js", "web/test_writes.mjs",
}

SKIP_DIRS = {"node_modules", "__pycache__", ".git"}


def staged():
    r = subprocess.run(["git", "diff", "--cached", "--name-only"],
                       capture_output=True, text=True)
    return [p for p in r.stdout.splitlines() if p.strip()]


def tracked():
    r = subprocess.run(["git", "ls-files"], capture_output=True, text=True)
    return [p for p in r.stdout.splitlines() if p.strip()]


def databases():
    out = []
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".next")]
        for f in files:
            if f.endswith((".db", ".sqlite", ".sqlite3")) or ".db." in f:
                out.append(os.path.join(root, f).replace("\\", "/").lstrip("./"))
    return sorted(out)


def html_dumps(paths):
    """Staged or tracked .html that nobody deliberately authored."""
    out = []
    for p in paths:
        low = p.replace("\\", "/").lower()
        if low.endswith(".html") and low not in HTML_ALLOW:
            out.append(p)
    return out


def carrying_secrets(paths):
    """Files whose CONTENT holds a credential, an address, or a live session.

    Name-based rules cannot catch this — daily.html was not on any list and held
    a signed-in page. Only staged files are read, because reading the whole tree
    on every commit is slow and the tracked set is already covered by the two
    checks above.
    """
    out = []
    for p in paths:
        if p.replace("\\", "/") in SECRET_SCAN_SKIP:
            continue
        try:
            with io.open(p, encoding="utf-8", errors="ignore") as f:
                body = f.read()
        except (OSError, IsADirectoryError):
            continue
        hits = [name for name, rx in SECRET_PATTERNS if rx.search(body)]
        if hits:
            out.append("%s  (%s)" % (p, ", ".join(hits)))
    return out


def offending(paths):
    bad = []
    for p in paths:
        low = p.replace("\\", "/").lower()
        # NOT lstrip("./") — lstrip takes a SET of characters, so it ate the
        # leading dot of ".env" and ".daily.lock" and both stopped being caught.
        # Only a literal "./" prefix is meant to go.
        while low.startswith("./"):
            low = low[2:]
        if (any(d in low for d in DENY_ANYWHERE)
                or any(low == d or low.startswith(d) for d in DENY_ROOT)
                or low.endswith(tuple(DENY_SUFFIX))):
            bad.append(p)
    return bad


def app_sources_ignored():
    """Source files the app NEEDS that .gitignore is silently swallowing.

    THE INVERSE OF EVERYTHING ELSE IN THIS FILE, and it cost a deploy. The rest
    of these checks ask "is something private about to escape". This one asks
    "is something REQUIRED about to be left behind", which fails in a way no
    check here could see: `git status` simply does not list an ignored file.

    What happened: .gitignore carried `outreach/` to keep the repo-root
    directory of drafted messages to real people out of the repo. A gitignore
    pattern with no leading slash matches a directory of that name at ANY depth,
    so when the app grew a route at web/app/outreach/, its page.js was ignored
    too. No error, no warning, nothing in `git status`. The commit would have
    gone in without it and Vercel would have served a 404 for /outreach while it
    rendered perfectly on localhost — the "renders locally is not renders in
    production" failure, with a one-character cause and a whole afternoon of
    reading the data layer waiting on the other side of it.

    The fix was to anchor the pattern (`/outreach/`). This is the guard, because
    the next over-broad pattern will look just as reasonable: `out/`, `logs/`,
    `voice/` and `contacts.csv` are all in there and all would swallow an app
    directory of the same name without a word.
    """
    roots = [os.path.join("web", "app"), os.path.join("web", "lib"),
             os.path.join("web", "components")]
    wanted = []
    for root in roots:
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            for f in files:
                if f.endswith((".js", ".jsx", ".mjs", ".css")):
                    wanted.append(os.path.join(dirpath, f).replace("\\", "/"))
    if not wanted:
        # A POSITIVE ASSERTION. If the walk finds nothing, this check silently
        # passes forever — the exact green-on-nothing it exists to prevent.
        return ["<walked web/app and web/lib and found NO source files at all>"]

    # Anything generated is legitimately ignored and is regenerated by the build.
    generated = ("config.generated.js", "resumes.generated.js")
    wanted = [p for p in wanted if not p.endswith(generated)]

    r = subprocess.run(["git", "check-ignore", "--stdin"],
                       input="\n".join(wanted), capture_output=True, text=True)
    # git echoes the path back; strip the CR that survives text mode on Windows
    # and the quotes it adds when a path needs them. Left raw, the message read
    # `"web/app/outreach/page.js\r"` — legible, but the kind of noise that makes
    # a real finding look like a broken test.
    out = []
    for line in r.stdout.splitlines():
        p = line.strip().strip('"')
        if p.endswith("\\r"):
            p = p[:-2]
        if p:
            out.append(p)
    return sorted(out)


# The matcher's own fixtures, checked on every run.
#
# WHY THESE EXIST. Every other check here runs against whatever happens to be in
# the tree, so on a clean day they all pass without classifying anything — and a
# check that passes when pointed at nothing is not a check. These are the known
# answers: paths that MUST be refused, and paths that MUST be allowed.
#
# The allowed list is the half that was missing, and its absence cost a deploy.
# `outreach/` was matched as a bare substring, so web/app/outreach/page.js — an
# ordinary Next route — was refused as a privacy violation, while the identical
# over-match in .gitignore had already hidden it from `git status` entirely.
# Nothing here would have caught either, because nothing here ever asserted that
# a legitimate file is allowed through.
MUST_REFUSE = [
    "outreach/2026-09-06-anduril.md",   # a drafted message to a real person
    "contacts.csv", "contacts.json", "outreach.csv",
    "voice/casey.wav", "logs/daily.log", ".daily.lock",
    ".env", "web/.env.local",           # a live key, in a subdirectory
    "jobs.db", "web/jobs.db", "jobs.db.retired-2026-09-01",
    "web/private.pem",
]
MUST_ALLOW = [
    "web/app/outreach/page.js",         # THE ONE THAT BROKE
    "web/app/Outreach.js",
    "web/lib/outreachQueue.js",
    "web/app/logs/page.js",             # a route that happens to be called logs
    "web/lib/voice.js",
]


def matcher_self_check():
    """The deny list classifies its own known cases correctly, in both directions."""
    wrong = []
    for p in MUST_REFUSE:
        if not offending([p]):
            wrong.append(f"NOT REFUSED but must be: {p}")
    for p in MUST_ALLOW:
        if offending([p]):
            wrong.append(f"REFUSED but must be allowed: {p}")
    return wrong


def main():
    utf8_stdout()
    fails = []

    wrong = matcher_self_check()
    if wrong:
        fails.append("the deny list itself is misclassifying:\n"
                     + "\n".join("    " + w for w in wrong))

    bad_staged = offending(staged())
    if bad_staged:
        fails.append("STAGED and must not be:\n" + "\n".join("    " + p for p in bad_staged))

    # Belt and braces: catch anything already tracked, where .gitignore is inert.
    bad_tracked = offending(tracked())
    if bad_tracked:
        fails.append("TRACKED and must not be (.gitignore does not untrack):\n"
                     + "\n".join("    " + p for p in bad_tracked))

    bad_html = html_dumps(staged()) + html_dumps(tracked())
    if bad_html:
        fails.append("HTML in the repo — a page dump, not a source file:\n"
                     + "\n".join("    " + p for p in sorted(set(bad_html))))

    leaking = carrying_secrets(staged())
    if leaking:
        fails.append("carrying a credential, an address or a live session:\n"
                     + "\n".join("    " + p for p in leaking))

    dbs = databases()
    if len(dbs) > 1:
        fails.append("more than one database in the tree — which one is real?\n"
                     + "\n".join("    " + p for p in dbs))

    swallowed = app_sources_ignored()
    if swallowed:
        fails.append("app source IGNORED by .gitignore — it would not deploy:\n"
                     + "\n".join("    " + p for p in swallowed)
                     + "\n    Anchor the offending pattern to the repo root with a"
                     + "\n    leading slash. `foo/` matches ANY directory named foo.")

    n = len(staged())
    print("%d staged, %d tracked, %d database%s in tree; deny list checked "
          "against %d must-refuse and %d must-allow paths"
          % (n, len(tracked()), len(dbs), "" if len(dbs) == 1 else "s",
             len(MUST_REFUSE), len(MUST_ALLOW)))
    if fails:
        print()
        for f in fails:
            print("  " + f)
        print("\n  Nothing here should ever reach GitHub. If a file is genuinely")
        print("  needed, it belongs in the DB or in .env, not in a commit.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
