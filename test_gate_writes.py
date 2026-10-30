#!/usr/bin/env python3
"""The gate's write-skip must skip only genuine no-ops.

Run: python test_gate_writes.py

cmd_gate reads all ~1,560 candidates because the seniority threshold is
per-company and relative, but it only WRITES rows whose values moved. On a
normal day that is zero rows, which took the gate from 544s to 9s.

That optimisation has two opposite failure modes and both are silent:

  * TOO EAGER — the comparison says "changed" when nothing did, every row is
    rewritten, and the gate is slow again while every test still passes. The
    obvious cause is including triaged_at, which moves every run by definition.
  * TOO KEEN TO SKIP — the comparison says "same" when something did change,
    and the gate silently stops updating verdicts FOREVER. Nothing errors. The
    kill list quietly goes stale and the owner never learns a role was reclassified.

The second is far worse, so the dangerous conflations are asserted explicitly:
None must not equal 0, and None must not equal "". A stored NULL and a computed
0 mean different things in every column the gate writes.

The end-to-end proof (perturb a real row, re-run, watch it restore) was done by
hand against Postgres; it is not automated here because it writes to live rows.
"""
import sys

from console import utf8_stdout
from score_jobs import (_GATE_CLASS_COLS, _GATE_VERDICT_COLS, _changed, _norm)

fails = []


def check(label, ok, detail=""):
    print("  %-4s %s%s" % ("ok" if ok else "FAIL", label,
                           "" if ok else "  -- " + detail))
    if not ok:
        fails.append(label)


def main():
    utf8_stdout()
    from decimal import Decimal

    print("values that mean the same thing must compare equal")
    for a, b in [(1, "1"), (1, Decimal("1")), (1.0, 1), (True, 1),
                 (None, None), ("x", "x"), (0, "0")]:
        check("%r == %r" % (a, b), _norm(a) == _norm(b))

    print("\nvalues that mean different things must NOT")
    # None vs 0 and None vs "" are the ones that would disable writes silently.
    for a, b in [(None, 0), (None, ""), (0, 1), ("a", "b"), (1, 2),
                 ("entry", "experienced"), (None, "gate/experience")]:
        check("%r != %r" % (a, b), _norm(a) != _norm(b))

    print("\n_changed over a row")
    cols = ["entry_level", "triage"]
    row = {"entry_level": "entry", "triage": 1}
    check("identical values are not a change",
          not _changed(row, cols, ("entry", 1)))
    check("a differing value is a change",
          _changed(row, cols, ("experienced", 1)))
    check("a value becoming NULL is a change",
          _changed(row, cols, (None, 1)))
    check("a NULL becoming a value is a change",
          _changed({"entry_level": None, "triage": 1}, cols, ("entry", 1)))

    print("\nthe column lists")
    check("triaged_at is NOT compared — it moves every run and would defeat "
          "the skip entirely",
          "triaged_at" not in _GATE_CLASS_COLS + _GATE_VERDICT_COLS)
    check("no column is listed twice",
          len(set(_GATE_CLASS_COLS + _GATE_VERDICT_COLS))
          == len(_GATE_CLASS_COLS + _GATE_VERDICT_COLS))
    check("the verdict columns are the ones the gate actually sets",
          set(_GATE_VERDICT_COLS) == {"triage", "triage_reason", "gate_name",
                                      "gate_text", "gate_field"})

    print()
    if fails:
        print("%d check%s failed: %s"
              % (len(fails), "" if len(fails) == 1 else "s", "; ".join(fails)))
        return 1
    print("the gate writes exactly when something moved")
    return 0


if __name__ == "__main__":
    sys.exit(main())
