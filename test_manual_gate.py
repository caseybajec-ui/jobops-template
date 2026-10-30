#!/usr/bin/env python3
"""A manually entered role is never killed by a gate. Run: python test_manual_gate.py

WHY THIS EXISTS. The deterministic gates exist to stop the owner reading ten
thousand board postings. A source='manual' row is the opposite of that: they
typed it in themselves, on purpose, because the company does not publish to any
board this tool can poll. The gates hold no information the owner lacks, and
they are pattern matches over prose THE OWNER WROTE — so their only possible
effect on a manual row is to delete something they asked for, silently, by
never showing it in Inbox.

RED FIRST, AND HONESTLY. The Truist row that prompted this PASSES every gate
today; the guard rescues nothing that is currently broken. Saying otherwise
would be inventing a fix for a bug that does not exist. What is true is that
four plausible manual descriptions are each killed by a different gate, and
every one of them is a thing a real note about a real programme might say. Those
four are the test: each is asserted to be killed WITHOUT the manual source, and
to survive WITH it. If the guard is removed, half of these go red.
"""
import io
import sys

import yaml

from classify import GRAD_YEAR, GRAD_LABEL
from console import utf8_stdout
from score_jobs import gate_verdict

PASS = []
FAIL = []


def ok(cond, what):
    (PASS if cond else FAIL).append(what)


# The owner's class year, from profile.json. The fixtures below were written
# when it was 2027; they substitute whatever it is now so the note keeps
# reading as the owner's own.
Y = GRAD_YEAR

# Each is a real gate's real trigger, phrased the way a hand-written note about
# a rotational programme plausibly would be.
KILLED_WHEN_POLLED = [
    ("contract",
     f"Wealth Analyst Program ({Y})", "Atlanta, GA",
     "A 12 month fixed-term contract rotational programme."),
    ("experience",
     f"Wealth Analyst Program ({Y})", "Atlanta, GA",
     "Requires 8+ years of wealth management experience for the senior track."),
    ("level",
     "Senior Product Manager, Rotational", "Atlanta, GA",
     "A programme for new grads."),
    ("location",
     f"Wealth Analyst Program ({Y})", "London, United Kingdom",
     "Graduate programme."),
]

# The row the original owner actually asked for, with the class year made the
# current owner's.
TRUIST_NOTE = (
    "12–18 month rotational program (Financial Advisor, Investment Analyst, "
    "Wealth/Private Banking Advisor rotations). SIE required BEFORE start date; "
    "Series 7, Series 66, Life/Health & Variable within 130 days of start. "
    f"Requires enrollment with grad date Fall {Y - 1} or Spring {Y} (I qualify — "
    f"{GRAD_LABEL}), GPA 3.0+. No visa sponsorship needed on my end."
)
TRUIST = {
    "source": "manual",
    "title": f"Wealth Analyst Program ({Y})",
    "location": "Atlanta; Charlotte; Greater Miami (relocation post-program required)",
    "description": TRUIST_NOTE,
}


def main():
    utf8_stdout()
    cfg = yaml.safe_load(io.open("companies.yaml", encoding="utf-8").read())
    senior = cfg.get("title_senior", [])
    protect = cfg.get("title_protect", [])

    # ---------------------------------------------- the gates still work
    # Without this half, "manual rows survive" would also pass against a
    # gate_verdict that had stopped killing anything at all.
    for expected, title, loc, desc in KILLED_WHEN_POLLED:
        polled = {"source": "greenhouse", "title": title,
                  "location": loc, "description": desc}
        g, reason, phrase, field = gate_verdict(polled, senior, protect)
        ok(g == expected,
           "polled: %r is killed by the %s gate (got %s)" % (title, expected, g))

    # ---------------------------------------------- and never on a manual row
    for expected, title, loc, desc in KILLED_WHEN_POLLED:
        manual = {"source": "manual", "title": title,
                  "location": loc, "description": desc}
        g, reason, phrase, field = gate_verdict(manual, senior, protect)
        ok(g is None,
           "manual: the same row SURVIVES the %s gate (got %s: %s)"
           % (expected, g, reason))

    # ---------------------------------------------- the actual Truist entry
    g, reason, phrase, field = gate_verdict(TRUIST, senior, protect)
    ok(g is None, "the Truist row passes (got %s: %s)" % (g, reason))

    # AND IT PASSES ON ITS OWN MERITS, not only because of the guard. Worth
    # asserting separately: if the guard were the only reason, a later change to
    # the row's text could start relying on it without anyone noticing.
    as_polled = dict(TRUIST, source="greenhouse")
    g2, reason2, _, _ = gate_verdict(as_polled, senior, protect)
    ok(g2 is None,
       "and would pass even as a POLLED row — the guard is insurance here, "
       "not a rescue (got %s: %s)" % (g2, reason2))

    # A row with no source at all must not crash the guard: gate_verdict is
    # called with a sqlite3.Row, a pgdb row and a plain dict in different places,
    # and a Row raises on a column its SELECT did not include.
    try:
        gate_verdict({"title": "Analyst", "location": "Atlanta, GA",
                      "description": "Graduate programme."}, senior, protect)
        ok(True, "a row with no `source` key does not raise")
    except Exception as e:
        ok(False, "a row with no `source` key raised %s" % type(e).__name__)

    print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
    for p in PASS:
        print("  ok    %s" % p)
    for f in FAIL:
        print("  FAIL  %s" % f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
