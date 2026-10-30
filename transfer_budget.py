#!/usr/bin/env python3
"""Where the Neon transfer allowance goes, per job, per month.

  python transfer_budget.py            # projection from measured constants
  python transfer_budget.py --live     # re-measure the constants from the DB

NO DATABASE BY DEFAULT. The allowance ran out; a tool for diagnosing that must
not be another consumer of it. The constants below were measured on 2026-09-06
and each one carries where it came from, so the arithmetic can be checked
without trusting this file.

WHAT THIS IS NOT. It is not what Neon bills. Neon's own consumption figure is
the authority and this cannot see it -- see the note in the digest health line.
This prices the ROW PAYLOAD each job moves, which is the part this repository
controls and the part that changed.
"""
import argparse
import io
import sys

from console import utf8_stdout
from paths import repo

# ---- measured 2026-09-06, after the full-text change ----------------------
OPEN_ROLES = 11_494          # last fetch: "11495 open roles seen"
CANDIDATES = 1_792           # gate: "Deterministic gate over 1792 candidates"
SCORED_60 = 141              # funnel: "scored 60+ 141"
MEAN_DESC = 6_358            # SELECT avg(length(description)) after the re-fetch
MEAN_DESC_BEFORE = 2_656     # weighted mean when non-candidates were cut at 2000
OTHER_COLS = 300             # key, title, location, url, company, timestamps
KEY_BYTES = 40               # a key plus statement overhead, for touch rows
CHANGE_RATE = 0.01           # descriptions that actually move on a given day:
                             # 73 of ~9,900 on the first fetch after the backfill


def _allowance_gb():
    """The plan's monthly transfer allowance, from config.yaml. ONE definition.

    This was `ALLOWANCE_GB = 5.0`, hardcoded to the free tier. The plan moved
    to Launch (500 GB) and the constant did not, which would have made every
    percentage below wrong by 100x -- "ALLOWANCE EXHAUSTED" at 1% of the real
    budget. The allowance is a fact about the account, so it lives in
    config.yaml under `database.transfer_allowance_gb`, next to the warn
    threshold the digest reads, and the two cannot drift.

    Same shape as score_jobs._monthly_cap(): pyyaml, which is already required,
    and it RAISES rather than defaulting. A missing allowance must not quietly
    become a number nobody chose, because a default that changes what a
    percentage MEANS is worse than a crash.
    """
    import yaml
    with io.open(repo("config.yaml"), encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    block = cfg.get("database") or {}
    if isinstance(block, dict) and block.get("transfer_allowance_gb") is not None:
        return float(block["transfer_allowance_gb"])
    raise RuntimeError(
        "config.yaml has no database.transfer_allowance_gb. Refusing to guess "
        "the plan's transfer allowance.")


ALLOWANCE_GB = _allowance_gb()


def mb(n):
    return n / 1e6


def report(live=False):
    utf8_stdout()
    if live:
        # Only when explicitly asked. Reads two aggregates, not row bodies.
        import fetch_jobs
        con = fetch_jobs.db()
        r = con.execute(
            "SELECT COUNT(*) n, AVG(length(description)) d FROM jobs "
            "WHERE closed_at IS NULL").fetchone()
        globals()["OPEN_ROLES"] = int(r["n"])
        globals()["MEAN_DESC"] = int(float(r["d"] or 0))
        print(f"(live: {OPEN_ROLES} open roles, mean description {MEAN_DESC})\n")

    row = MEAN_DESC + OTHER_COLS
    row_before = MEAN_DESC_BEFORE + OTHER_COLS

    fetch_old = OPEN_ROLES * row
    fetch_new = OPEN_ROLES * CHANGE_RATE * row + OPEN_ROLES * KEY_BYTES
    gate = CANDIDATES * row
    digest = 1_000_000
    backfill = OPEN_ROLES * row

    print("PER RUN, row payload only\n")
    print(f"  {'job':34s} {'before':>10s} {'after':>10s}")
    print(f"  {'fetch (nightly)':34s} {mb(fetch_old):9.1f}M {mb(fetch_new):9.1f}M")
    print(f"  {'gate (nightly, reads candidates)':34s} {mb(gate):9.1f}M {mb(gate):9.1f}M")
    print(f"  {'score (nightly, survivors only)':34s} {mb(2e6):9.1f}M {mb(2e6):9.1f}M")
    print(f"  {'digest (nightly)':34s} {mb(digest):9.1f}M {mb(digest):9.1f}M")
    print(f"  {'blocker backfill (manual)':34s} {mb(backfill):9.1f}M {'n/a':>10s}")

    nightly_old = fetch_old + gate + 2e6 + digest
    nightly_new = fetch_new + gate + 2e6 + digest
    print(f"\n  {'NIGHTLY TOTAL':34s} {mb(nightly_old):9.1f}M {mb(nightly_new):9.1f}M")

    m_old = nightly_old * 30 / 1e9
    m_new = nightly_new * 30 / 1e9
    print(f"\nPROJECTED MONTHLY (30 nightly runs, no manual work)")
    print(f"  before: {m_old:5.2f} GB  =  {100*m_old/ALLOWANCE_GB:5.0f}% of the {ALLOWANCE_GB:.0f} GB allowance")
    print(f"  after : {m_new:5.2f} GB  =  {100*m_new/ALLOWANCE_GB:5.0f}% of the {ALLOWANCE_GB:.0f} GB allowance")
    print(f"  saved : {m_old - m_new:5.2f} GB/month  ({100*(1-m_new/m_old):.0f}% less)")

    # THE PART THAT IS NOT THE CRON'S FAULT.
    print(f"\nWHAT THE STORAGE CHANGE DID. Keeping full text for every tracked")
    print(f"board raised the mean stored description from {MEAN_DESC_BEFORE:,} to "
          f"{MEAN_DESC:,} chars,")
    print(f"which alone took the nightly fetch from "
          f"{mb(OPEN_ROLES*row_before):.0f}M to {mb(fetch_old):.0f}M "
          f"({OPEN_ROLES*row_before*30/1e9:.2f} GB/month to {fetch_old*30/1e9:.2f} GB).")
    print(f"Storage was quantified at the time; transfer was not. That is the miss.")

    print(f"\nONE-OFF COSTS ALREADY SPENT TODAY (not recurring)")
    for label, n in (("re-fetch, full write", OPEN_ROLES * row),
                     ("blocker backfill x5", 5 * OPEN_ROLES * row),
                     ("ad-hoc corpus probes x8", 8 * OPEN_ROLES * row)):
        print(f"  {label:34s} {mb(n):9.1f}M")
    session = (1 + 5 + 8) * OPEN_ROLES * row
    print(f"  {'SESSION TOTAL':34s} {mb(session):9.1f}M  ({session/1e9:.2f} GB)")
    print("\nThat session total is the immediate cause of hitting the wall, and it")
    print("was mine. The recurring fetch cost is the one that would have hit it")
    print("again in a fortnight regardless.")

    print(f"\nFIRST RUN AFTER THE FIX writes everything once more "
          f"(~{mb(fetch_old):.0f}M) because every content_hash is NULL, then drops "
          f"to ~{mb(fetch_new):.0f}M a night.")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true",
                    help="re-measure row counts from the database (two aggregates)")
    sys.exit(report(ap.parse_args().live))
