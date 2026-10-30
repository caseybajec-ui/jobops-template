"""A regex that ends an abbreviation with a period must still match one.

    python test_regex_boundaries.py

WHY THIS IS A TEST AND NOT A NOTE. CLAUDE.md already records this bug, for the
clearance patterns: "'U.S.' contains periods, so 'an active U.S. government
security clearance is required' matched nothing." It recurred anyway, forty
lines away in the same file, in `_US_HINT` — where `u\\.s\\.a?\\.?` was followed
by a trailing `\\b`. A prose rule cannot catch a regex that can never match.

THE MECHANISM. `\\b` requires a word/non-word TRANSITION. An alternative ending
in a literal period already ends on a non-word character, so a trailing `\\b`
demands the NEXT character be a word one — and in real prose it is a comma, a
space, or the end of the string. The pattern then matches only in the case
nobody wanted ("U.S.A") and never in the cases everybody writes.

HOW IT IS CHECKED. Behaviourally, not syntactically. Trying to decide from the
pattern source whether a `\\b` is reachable from a literal period means writing
a regex parser, and a wrong parser here fails silently in the direction of
passing. So instead: every alternative in every module-level pattern that
contains a literal period is turned back into the plain string it is meant to
match, and that string is required to match in the contexts abbreviations
actually appear in — followed by a comma, by a space, by a full stop, and at the
end of the input.

WHAT IT REFUSES TO DO QUIETLY. An alternative whose literal cannot be
reconstructed (a character class, a nested group, a quantifier this does not
model) is REPORTED as unchecked rather than counted as passing, and the run
fails if nothing at all could be checked. "0 hazards, 0 failures" is what this
test would print if it were pointed at nothing.
"""
import re
import sys

import score_jobs
from console import utf8_stdout

# The contexts an abbreviation actually appears in. Every one of these is a real
# shape from the corpus: "across the U.S., Europe" / "the U.S. and Canada" /
# "based in the U.S." / "U.S.-based".
CONTEXTS = [
    ("{lit}", "on its own"),
    ("{lit}, Europe", "followed by a comma"),
    ("{lit} and Canada", "followed by a space"),
    ("based in the {lit}", "at the end of a sentence"),
    ("{lit}-based", "followed by a hyphen"),
]

# Regex syntax this can turn back into a literal. Anything else and the
# alternative is reported as unchecked.
SIMPLE = re.compile(r"^(?:[a-z0-9 /,'&-]|\\\.|\\-|\[[- ]\]|[a-z]\?|\\\.\?)+$", re.I)


def literals(alt):
    """Every plain string a simple alternative could match, or [] if too complex.

    Handles exactly what these patterns use: escaped periods, optional single
    letters, and the [- ] class. Deliberately narrow — a generous expander would
    invent strings the pattern never claimed to match and report false alarms.
    """
    if not SIMPLE.match(alt):
        return []
    out = [""]
    i = 0
    while i < len(alt):
        if alt.startswith(r"\.", i):
            nxt = "." if not alt.startswith(r"\.?", i) else None
            if nxt is None:
                out = [o + "." for o in out] + list(out)   # \.? -> with and without
                i += 3
            else:
                out = [o + "." for o in out]
                i += 2
        elif alt.startswith(r"\-", i):
            out = [o + "-" for o in out]
            i += 2
        elif alt.startswith("[- ]", i):
            out = [o + "-" for o in out] + [o + " " for o in out]
            i += 4
        elif i + 1 < len(alt) and alt[i + 1] == "?":
            out = [o + alt[i] for o in out] + list(out)
            i += 2
        else:
            out = [o + alt[i] for o in out]
            i += 1
        if len(out) > 64:
            return []
    return [o for o in dict.fromkeys(out) if o.strip()]


def alternatives(pattern):
    """Top-level alternatives of a pattern, flattened one group deep.

    Good enough for the shapes in this file: `\\b( a | b | c )\\b` and bare
    `a|b|c`. Nested alternation is left alone and reported as unchecked.
    """
    src = pattern
    src = re.sub(r"^\\b\(", "", src)
    src = re.sub(r"\)(\\b|\(\?!\\w\))$", "", src)
    return [a for a in src.split("|") if a]


def main():
    utf8_stdout()
    fails = []
    unchecked = []
    checked = 0
    hazards = 0

    names = [n for n in dir(score_jobs)
             if isinstance(getattr(score_jobs, n, None), re.Pattern)]
    for name in sorted(names):
        rx = getattr(score_jobs, name)
        for alt in alternatives(rx.pattern):
            if r"\." not in alt:
                continue
            hazards += 1
            lits = literals(alt)
            if not lits:
                unchecked.append("%s  %r" % (name, alt[:48]))
                continue
            for lit in lits:
                for tmpl, why in CONTEXTS:
                    text = tmpl.format(lit=lit)
                    checked += 1
                    if not rx.search(text):
                        fails.append(
                            "%s  alternative %r cannot match %r (%s)"
                            % (name, alt[:34], text[:44], why))

    print("%d patterns, %d alternatives containing a literal period, "
          "%d strings checked" % (len(names), hazards, checked))
    for u in unchecked:
        print("  unchecked (too complex to reconstruct): %s" % u)

    # A run that checked nothing is not a passing run.
    if hazards == 0:
        print("\nNO PATTERN CONTAINS A LITERAL PERIOD. Either the patterns changed\n"
              "shape or the alternative splitter has stopped working — this test\n"
              "cannot pass by finding nothing to look at.")
        return 1
    if checked == 0:
        print("\n%d hazards found and NONE could be checked. This is a green run\n"
              "that measured nothing." % hazards)
        return 1

    if fails:
        print("\n%d FAILED — a period-terminated alternative that cannot match:\n" % len(fails))
        for f in fails:
            print("  " + f)
        print("\n  A trailing \\b after a literal period demands the next character be a\n"
              "  word one. Use (?!\\w) instead, which asks only that the match not run\n"
              "  into a word character.")
        return 1

    print("every period-terminated alternative matches in all %d contexts" % len(CONTEXTS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
