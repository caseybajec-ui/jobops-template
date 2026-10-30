#!/usr/bin/env python3
"""Fails if a CLI can be killed by a character in its own data.

Run: python test_console_encoding.py

Python on Windows writes stdout in the locale codepage (cp1252 here), not UTF-8.
A character with no cp1252 equivalent raises UnicodeEncodeError at the print --
after the work succeeded -- so it surfaces as a crash in whatever produced the
string. `contacts.py list` dies on a contact named with the Polish barred L;
`fetch_jobs.py` dies on a posting titled with a CJK office name. Neither
character appears anywhere in the source, which is why grepping for it finds
nothing and why this has to be a test.

Two checks, because either alone passes while the bug is live:

  1. every CLI calls utf8_stdout() -- the fix is present;
  2. utf8_stdout() actually survives the characters -- the fix works.

The line-ending test next door exists for the same reason: Windows defaults
quietly produce output that is wrong everywhere else.
"""
import io
import re
import subprocess
import sys

from console import utf8_stdout

# Every module with a command line the owner or cron can run. Each name is
# checked to EXIST below, so a file deleted from the repo fails here by name
# rather than silently shrinking the list.
CLIS = ["contacts.py", "outreach.py", "gap_themes.py",
        "verify_deadlines.py", "seed_items.py", "fetch_jobs.py", "score_jobs.py",
        "backfill_descriptions.py", "apply_packs.py", "pack_critic.py",
        "prep_pack.py", "source_contacts.py", "watch_pages.py",
        "transfer_budget.py", "google_check.py", "jobops-local/read_alumni.py"]

# Characters that are NOT in cp1252 and do turn up in real data.
HOSTILE = "\u0141ukasz \u2192 \u2265 \u6771\u4eac \u2713"

fails = []


def check(label, ok, detail=""):
    print("  %-4s %s%s" % ("ok" if ok else "FAIL", label,
                           "" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


def main():
    utf8_stdout()

    print("every CLI installs the UTF-8 wrapper")
    for p in CLIS:
        try:
            s = io.open(p, encoding="utf-8").read()
        except OSError:
            check(p, False, "missing")
            continue
        has_import = "from console import utf8_stdout" in s
        has_call = re.search(r"^\s+utf8_stdout\(\)", s, re.M) is not None
        check(p, has_import and has_call,
              "import=%s call=%s" % (has_import, has_call))

    print("\nthe wrapper survives characters cp1252 cannot represent")
    # A child process, because the encoding is fixed when stdout is created and
    # this process already has it right. Redirected to a pipe, which is the
    # case that actually breaks -- a console may negotiate UTF-8 on its own.
    src = ("from console import utf8_stdout\n"
           "utf8_stdout()\n"
           "print(%r)\n" % HOSTILE)
    r = subprocess.run([sys.executable, "-c", src],
                       capture_output=True, cwd=".")
    check("child process exits 0", r.returncode == 0,
          r.stderr.decode("utf-8", "replace").strip()[-120:])
    check("output round-trips as UTF-8",
          r.stdout.decode("utf-8", "strict").strip() == HOSTILE,
          repr(r.stdout[:60]))

    # And prove the failure is real rather than theoretical.
    bare = "print(%r)" % HOSTILE
    r2 = subprocess.run([sys.executable, "-c", bare], capture_output=True,
                        cwd=".", env={"PYTHONIOENCODING": "cp1252",
                                      "SYSTEMROOT": "C:/Windows"})
    check("without the wrapper it really does crash", r2.returncode != 0,
          "exited 0 -- this platform may already default to UTF-8, so the "
          "wrapper is belt-and-braces here")

    print()
    if fails:
        print("%d check%s failed: %s"
              % (len(fails), "" if len(fails) == 1 else "s", "; ".join(fails)))
        return 1
    print("console output is UTF-8 everywhere")
    return 0


if __name__ == "__main__":
    sys.exit(main())
