#!/usr/bin/env python3
"""Fails if any tracked text file contains a CRLF line ending.

Run: python test_line_endings.py

This is here because a CRLF file broke the app silently. A script rewrote
companies.yaml in Python text mode, Windows turned every \\n into \\r\\n, and
lib/deadlines.js splits on "\\n" — so every line kept a trailing \\r, every regex
matched nothing, and the page reported "0 windows tracked". Nothing errored. The
build was green. It looked like a data problem.

The parsers are hardened now, but the durable fix is not having CRLF in the repo
at all: hand-written parsers are exactly the kind of code that assumes one line
ending, and this project has several.

Whitelist below is for files that are genuinely Windows-only by nature.
"""
import io
import subprocess
import sys
from console import utf8_stdout

# Extensions worth checking. Binaries and images are excluded by being absent.
TEXT_SUFFIXES = (
    ".py", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".json", ".yaml", ".yml",
    ".md", ".css", ".sql", ".sh", ".txt", ".gitignore",
)

# .ps1 is a PowerShell script; Windows tooling is happier with CRLF there, and
# nothing in this repo parses it.
ALLOW_CRLF = {"daily_run.ps1", "precommit.ps1"}


def tracked_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True)
    return [p for p in out.stdout.splitlines() if p.strip()]


def main():
    utf8_stdout()
    bad = []
    ctrl = []
    checked = 0
    for path in tracked_files():
        if not (path.endswith(TEXT_SUFFIXES) or "/" not in path and "." not in path):
            continue
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError:
            continue
        checked += 1
        # ALLOW_CRLF is about LINE ENDINGS ONLY. It used to `continue` past the
        # whole file, which quietly exempted it from the control-byte check as
        # well — two unrelated rules riding on one condition. A .ps1 may have
        # CRLF; it may not have a mangled regex in it.
        n = raw.count(b"\r\n")
        if n and path not in ALLOW_CRLF:
            bad.append((path, n))

        # CONTROL BYTES, and specifically 0x08.
        #
        # Same root cause as CRLF and the same silence. A regex edited through a
        # shell heredoc has its backslash escapes collapsed: `\\b` becomes a
        # literal backspace byte, and the pattern then matches nothing at all.
        # It has now happened twice in this project. Both times the file parsed,
        # the build was green, and the only symptom was a feature quietly
        # returning no results -- which reads as a data problem.
        #
        # grep does not find it, because the character is not in the source you
        # are looking at. That is exactly why it is a test.
        for byte, name in ((b"\x08", "backspace (0x08)"),
                           (b"\x01", "start-of-heading (0x01)"),
                           (b"\x00", "null (0x00)")):
            c = raw.count(byte)
            if c:
                ctrl.append((path, name, c))

    print("%d tracked text files checked, %d with CRLF, %d with control bytes"
          % (checked, len(bad), len(ctrl)))

    if ctrl:
        print("\nCONTROL BYTES found. A regex edited through a shell heredoc has")
        print("its escapes collapsed -- a backslash-b becomes a literal backspace")
        print("byte and the pattern then matches nothing. The file still parses.")
        for path, name, c in ctrl:
            print("  %-52s %d x %s" % (path, c, name))
        print("\nUse the editing tools for anything containing a backslash.")
        return 1
    if bad:
        print("\nCRLF found — a hand-written parser will read these wrong:")
        for path, n in bad:
            print("  %-52s %d CRLF line endings" % (path, n))
        print("\nFix with, from the repo root:")
        print("  python -c \"import io,sys; p=sys.argv[1];"
              " b=io.open(p,'rb').read();"
              " io.open(p,'wb').write(b.replace(b'\\r\\n',b'\\n'))\" <path>")
        print("\nAnd when writing a file from Python, always pass both:")
        print("  io.open(path, 'w', encoding='utf-8', newline='\\n')")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
