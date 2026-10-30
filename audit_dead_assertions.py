#!/usr/bin/env python3
"""Find assertions that CANNOT FAIL. Run: python audit_dead_assertions.py

WHY THIS EXISTS. The clearance-phrasing assertion in web/test_writes.mjs was
dead for weeks: its `\\b` escapes had collapsed into literal 0x08 bytes through a
shell heredoc, so the regex matched nothing and the check passed whatever the
page said. It guards the one rule in this project that becomes a false claim on
a federal form if it goes wrong.

test_line_endings.py fails on stray control bytes now, which catches that exact
MECHANISM across every tracked file. This file is about the wider CLASS: an
assertion is dead whenever it passes for a reason other than the code being
right.

WHAT IS DECIDABLE AND WHAT IS NOT. Only two of these can be settled by a
machine, and the honest thing is to say so rather than to print a confident
list:

  1. CONTROL BYTES inside a regex literal in a test file. Decidable, and it is
     the exact failure that started this.

  2. COLLAPSED SHORTHAND. `\\s` written through a shell as `s`, `\\d` as `d`.
     Unlike a control byte this leaves printable text, so nothing flags it and
     the pattern quietly means something else. Detected narrowly: a character
     class or quantifier applied to a bare `b`, `d`, `s` or `w` where the
     surrounding pattern is otherwise all escapes.

  3 and 4 are NOT decidable and are printed for a human to read. A negative
  assertion -- `ok(!BAD.test(text))` -- passes when the code is right, when the
  regex is broken, AND when `text` is empty; only a person can say which of
  those a given line is protected against. Same for a quantifier over a
  collection that might be empty: `[].every(...)` is true and sometimes that
  is the point.

An earlier version of this file tried to decide 3 and 4 by firing each regex at
text reconstructed from its own alternatives. It reported twenty-four dead
assertions, of which zero were dead -- the reconstruction mangled character
classes into nonsense. A check that cries wolf is one people learn to skip,
which is how the real dead assertion survived for weeks in the first place. It
was deleted rather than tuned.
"""
import io
import re
import subprocess
import sys

from console import utf8_stdout

CONTROL = {b"\x00": "null", b"\x01": "start-of-heading", b"\x08": "backspace",
           b"\x0b": "vertical-tab", b"\x0c": "form-feed", b"\x1b": "escape"}

# A JS regex literal. Conservative: a missed regex is better than a false
# positive, for the reason in the docstring.
JS_REGEX = re.compile(r"(?<![\w)\]])/((?:[^/\\\n\[]|\\.|\[(?:[^\]\\]|\\.)*\])+)/([gimsuy]*)")

# The signature of a collapsed shorthand: a quantifier hanging off a bare
# letter, in a pattern that is otherwise escape-heavy. `s+` in a pattern full of
# `\w` and `\d` is almost certainly a `\s+` that lost its backslash.
COLLAPSED = re.compile(r"(?<![\\\w])([bdsw])([+*?{])")


def test_files():
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True)
    return [p for p in out.stdout.splitlines()
            if re.search(r"(^|/)test_[^/]+\.(py|mjs)$", p)]


def main():
    utf8_stdout()
    files = test_files()
    ctrl_hits, collapsed, vacuous, negatives = [], [], [], []

    for path in files:
        raw = io.open(path, "rb").read()
        for byte, name in CONTROL.items():
            n = raw.count(byte)
            if n:
                ctrl_hits.append((path, name, n))

        text = raw.decode("utf-8", "replace")
        lines = text.split("\n")

        for i, line in enumerate(lines, 1):
            s = line.strip()
            if s.startswith("*") or s.startswith("//") or s.startswith("#"):
                continue

            if path.endswith(".mjs"):
                for m in JS_REGEX.finditer(line):
                    src = m.group(1)
                    escapes = src.count("\\")
                    for c in COLLAPSED.finditer(src):
                        # Only suspicious where the pattern already leans on
                        # escapes. A literal "s+" in a plain word pattern is
                        # just an "s".
                        if escapes >= 2:
                            collapsed.append((path, i, src[:70], c.group(0)))

            if re.search(r"\.every\(|\.some\(", line):
                vacuous.append((path, i, s[:88]))
            if re.search(r"ok\(\s*!|assert\s+not\b", line):
                negatives.append((path, i, s[:88]))

    print("%d test files audited\n" % len(files))

    print("1. CONTROL BYTES IN A TEST FILE  (decidable)")
    if ctrl_hits:
        for path, name, n in ctrl_hits:
            print("   DEAD  %-42s %d x %s" % (path, n, name))
    else:
        print("   none — no regex in any test file has been mangled")

    print("\n2. COLLAPSED SHORTHAND, e.g. \\s written as s  (decidable, narrow)")
    if collapsed:
        for path, i, src, hit in collapsed:
            print("   SUSPECT  %s:%d  /%s/  -> %r" % (path, i, src, hit))
    else:
        print("   none")

    print("\n3. QUANTIFIERS OVER A POSSIBLY-EMPTY COLLECTION  (%d — for a human)"
          % len(vacuous))
    for path, i, s in vacuous:
        print("   %s:%d  %s" % (path, i, s))

    print("\n4. NEGATIVE ASSERTIONS  (%d — each needs a nearby proof its subject was non-empty)"
          % len(negatives))
    for path, i, s in negatives:
        print("   %s:%d  %s" % (path, i, s))

    print("\nOnly 1 and 2 fail this audit. 3 and 4 are a reading list, and the")
    print("mutation checks in audit_mutation.mjs are what actually prove them.")
    return 1 if (ctrl_hits or collapsed) else 0


if __name__ == "__main__":
    sys.exit(main())
