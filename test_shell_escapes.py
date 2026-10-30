#!/usr/bin/env python3
r"""Fails if a shell script contains a backslash escape the shell will not read.

Run: python test_shell_escapes.py

THE BUG THIS EXISTS FOR. Editing a file through a shell heredoc mangles
backslashes, and it has now done so three times in one week in two opposite
directions:

  intended                          landed in the file
  --------                          ------------------
  for t in a.py \                   for t in a.py \n         b.py \
           b.py \                     (a literal backslash-n, unquoted, which
                                       the shell reads as the bare letter "n")

  printf '\n%s\n' "$out"            printf '
                                    %s
                                    ' "$out"
                                      (the escape was consumed and became real
                                       line breaks inside the format string)

Both files still PARSE. `sh -n` accepts them. The first one silently looks for a
test file called "n" and skips it; the second prints the right thing by accident
and reads as a mess. Neither errors, which is why neither was noticed until
somebody read the file.

This is the sibling of test_line_endings.py's control-byte check: same cause — a
heredoc eating backslashes — different symptom. It is a separate file rather
than a third rule bolted onto that one, because that file already learned what
happens when two unrelated rules ride on one condition.

THE INVARIANT. An escape like \n, \t or \r means something to `printf` INSIDE a
quoted format string. Outside quotes the shell just drops the backslash, so an
unquoted \n is the letter "n" and has never once been what anybody meant.

It is a test rather than a note in CLAUDE.md because CLAUDE.md already says
"never edit code through a shell heredoc when the replacement text contains a
backslash", and that did not stop it happening three times.
"""
import io
import subprocess
import sys

from console import utf8_stdout

# Escapes that are meaningful to printf inside quotes and meaningless outside.
ESCAPES = "ntr"


def tracked_shell_scripts():
    """Every tracked file that a shell will run: .sh, or a sh/bash shebang."""
    out = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True)
    found = []
    for path in out.stdout.splitlines():
        if not path.strip():
            continue
        if path.endswith(".sh"):
            found.append(path)
            continue
        try:
            with io.open(path, "r", encoding="utf-8", errors="replace") as f:
                first = f.readline()
        except OSError:
            continue
        if first.startswith("#!") and ("sh" in first or "bash" in first):
            found.append(path)
    return sorted(set(found))


def scan(text):
    """(unquoted escapes, printf strings spanning a line break, quoted escapes).

    A small shell state machine: single quotes are literal to the next quote,
    double quotes honour a backslash, `#` at a word boundary starts a comment,
    and a heredoc is skipped to its terminator so its body is never judged as
    shell.

    `quoted` is returned so the caller can assert the scanner still recognises
    the LEGITIMATE ones. A quote-stripper that has broken in the direction of
    "everything looks quoted" reports no problems and looks exactly like a clean
    repository.
    """
    unquoted, spanning, quoted = [], [], 0
    i, line, col = 0, 1, 1
    state = None            # None | "'" | '"'
    open_at = None          # where the current quote started
    heredoc = None
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\n":
            if state is not None and state == "'" and open_at and open_at[2]:
                # A single-quoted string that started on a printf line and has
                # not closed by the end of that line.
                spanning.append(open_at[:2])
                open_at = (open_at[0], open_at[1], False)   # report once
            line, col = line + 1, 0
            i += 1
            col = 1
            continue

        if heredoc is not None:
            # Skip a heredoc body wholesale: its contents are not shell.
            eol = text.find("\n", i)
            eol = n if eol < 0 else eol
            if text[i:eol].strip() == heredoc:
                heredoc = None
            i = eol
            continue

        if state is None:
            if ch == "#" and (i == 0 or text[i - 1] in " \t\n"):
                eol = text.find("\n", i)
                i = n if eol < 0 else eol
                continue
            if text.startswith("<<", i):
                j = i + 2
                while j < n and text[j] in "-~":
                    j += 1
                q = ""
                if j < n and text[j] in "'\"":
                    q = text[j]
                    j += 1
                start = j
                while j < n and (text[j].isalnum() or text[j] in "_-"):
                    j += 1
                word = text[start:j]
                if q and j < n and text[j] == q:
                    j += 1
                if word:
                    heredoc = word
                col += j - i
                i = j
                continue
            if ch in "'\"":
                state = ch
                lead = text.rfind("\n", 0, i) + 1
                open_at = (line, col, "printf" in text[lead:i])
                i += 1
                col += 1
                continue
            if ch == "\\" and i + 1 < n:
                nxt = text[i + 1]
                if nxt in ESCAPES:
                    eol = text.find("\n", i)
                    unquoted.append((line, col, text[text.rfind("\n", 0, i) + 1:
                                                    n if eol < 0 else eol].strip()))
                i += 2
                col += 2
                continue
            i += 1
            col += 1
            continue

        # inside quotes
        if state == "'":
            if ch == "'":
                state, open_at = None, None
            elif ch == "\\" and i + 1 < n and text[i + 1] in ESCAPES:
                quoted += 1
                i += 2
                col += 2
                continue
        else:
            if ch == "\\" and i + 1 < n:
                if text[i + 1] in ESCAPES:
                    quoted += 1
                i += 2
                col += 2
                continue
            if ch == '"':
                state, open_at = None, None
        i += 1
        col += 1
    return unquoted, spanning, quoted


def main():
    utf8_stdout()
    scripts = tracked_shell_scripts()
    bad, spans, quoted_total = [], [], 0
    for path in scripts:
        try:
            with io.open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        unq, spanning, q = scan(text)
        quoted_total += q
        bad += [(path, ln, col, src) for ln, col, src in unq]
        spans += [(path, ln, col) for ln, col in spanning]

    print("%d shell scripts scanned, %d legitimate quoted escapes, "
          "%d unquoted, %d spanning printf strings"
          % (len(scripts), quoted_total, len(bad), len(spans)))

    # A scanner that decided everything was quoted would report a clean repo.
    if not scripts:
        print("\nNO SHELL SCRIPTS FOUND. Either they are gone or the discovery\n"
              "stopped working — this cannot pass by finding nothing to read.")
        return 1
    if quoted_total == 0:
        print("\nNO QUOTED ESCAPES FOUND ANYWHERE. Every printf in .githooks/pre-commit\n"
              "ends in a backslash-n, so finding none means the quote scanner is\n"
              "broken and would not recognise an UNQUOTED one either.")
        return 1

    if bad:
        print("\nUNQUOTED BACKSLASH ESCAPE — the shell drops the backslash, so this")
        print("is the bare letter, not a newline. Written by a heredoc that ate it:")
        for path, ln, col, src in bad:
            print("  %s:%d:%d" % (path, ln, col))
            print("      %s" % src[:96])
    if spans:
        print("\nA printf FORMAT STRING SPANNING A LINE BREAK — the escape was")
        print("consumed and became a real newline. Same cause, opposite direction:")
        for path, ln, col in spans:
            print("  %s:%d:%d" % (path, ln, col))
    if bad or spans:
        print("\nUse the editing tools for anything containing a backslash — never a")
        print("shell heredoc. CLAUDE.md has said so since the first time; saying it")
        print("again is not what stops it.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
