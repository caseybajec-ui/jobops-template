#!/usr/bin/env python3
"""Where the repo's own files are, regardless of where you ran the command.

WHY THIS EXISTS. `score_jobs.py` opened `"config.yaml"` relative to the CURRENT
WORKING DIRECTORY. Run from anywhere but the repo root the open failed, the
`except OSError` swallowed it, and the cap window silently fell back to
1970-01-01 — which made the meter sum EVERY batch ever submitted and report
"OVER THE CAP — do not run further scoring this month."

So a `cd` into the wrong directory could stop the pipeline scoring, with a
message that looked like a real budget problem rather than a path problem. The
identical shape produced three stray `jobs.db` files before `DB` was anchored to
`__file__`.

CLAUDE.md does say "run commands from the repo root", and that is exactly the
kind of rule this codebase has learned not to rely on: a rule enforced by
discipline fails silently, usually in the direction of spending money or
reporting a wrong number.

Anchored to THIS FILE rather than to the caller's, so it gives the same answer
from a subdirectory, from a test, and from the Actions runner.
"""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


def repo(*parts):
    """An absolute path to something in the repo. `repo("config.yaml")`."""
    return os.path.join(ROOT, *parts)
