#!/usr/bin/env python3
"""
verify_deadlines.py — the one part of this system where being out of date is expensive.

  python verify_deadlines.py            # report status and staleness
  python verify_deadlines.py --check    # also HEAD each source URL for rot
  python verify_deadlines.py --stale 14 # staleness threshold in days

This does NOT re-scrape dates automatically, and that is deliberate. Every firm
here runs a JS careers site behind a custom ATS; a scraper would produce
confident-looking wrong dates, which is exactly the failure that already nearly
cost a cycle. What it does instead: surface what is stale, what is unconfirmed,
what closes soon, and whether the source URL still resolves — so re-verification
is a five-minute human task with a worklist rather than a vague intention.
"""
import argparse
import datetime as dt
import io
import sys

import yaml
from console import utf8_stdout
from paths import repo

try:
    import requests
except ImportError:
    requests = None

TODAY = dt.date.today()
CONF_RANK = {"verified": 0, "secondary-source": 1, "historical-estimate": 2,
             # A date the owner set themselves, for a firm that has published none.
             # Lives in `target:`, never `closes:` — refused below if it does.
             "planning-target": 3}


def load():
    with io.open(repo("companies.yaml"), encoding="utf-8") as f:
        return yaml.safe_load(f).get("deadlines", [])


def days_until(d):
    return None if not d else (d - TODAY).days if isinstance(d, dt.date) else None


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="HEAD each source URL")
    ap.add_argument("--stale", type=int, default=14)
    a = ap.parse_args()

    rows = load()
    if not rows:
        print("No `deadlines` section in companies.yaml.")
        return 1

    urgent, stale, unconfirmed, ok = [], [], [], []
    for r in rows:
        # The same refusal web/lib/deadlines.js makes, so the CLI and the app
        # cannot disagree about whether the file is well-formed.
        if r.get("confidence") == "planning-target" and r.get("closes"):
            print(f"REFUSED: {r['firm']} — a planning-target row may not carry "
                  f"closes: {r['closes']}. Your own date goes in `target:`.")
            return 1
        if r.get("target") and r.get("confidence") != "planning-target":
            print(f"REFUSED: {r['firm']} — a row with target: {r['target']} must be "
                  f"confidence: planning-target, or nobody can tell whose date it is.")
            return 1
        vdays = days_until(r.get("verified"))
        r["_stale"] = vdays is not None and abs(vdays) > a.stale
        r["_close_in"] = days_until(r.get("closes"))
        if r.get("status") == "open" and r["_close_in"] is not None and r["_close_in"] <= 21:
            urgent.append(r)
        elif r.get("status") == "unconfirmed":
            unconfirmed.append(r)
        elif r["_stale"]:
            stale.append(r)
        else:
            ok.append(r)

    def show(title, group, note=""):
        if not group:
            return
        print(f"\n{title}  ({len(group)})")
        if note:
            print(f"  {note}")
        for r in group:
            when = ""
            if r.get("target"):
                d = days_until(r.get("target"))
                when = f"YOUR TARGET {r['target']} ({d:+d}d)"
            elif r.get("closes"):
                d = r["_close_in"]
                when = f"closes {r['closes']} ({d:+d}d)"
            elif r.get("status") == "closed":
                when = f"CLOSED {r.get('closes') or '(no date recorded)'}"
            elif r.get("rolling"):
                when = "rolling — no cutoff"
            else:
                when = "no date"
            flag = "STALE" if r["_stale"] else ""
            print(f"  {r['firm'][:34]:34s} {when:26s} {r['confidence']:20s} {flag}")

    print(f"DEADLINE STATUS — {TODAY}   ({len(rows)} tracked)")
    show("!! CLOSING WITHIN 21 DAYS", urgent)
    show("?? UNCONFIRMED — no published date", unconfirmed,
         "These need a human to open the careers page. Highest value per minute.")
    show("~~ STALE — verified more than %dd ago" % a.stale, stale)
    show("ok", ok)

    by_conf = {}
    for r in rows:
        by_conf.setdefault(r["confidence"], 0)
        by_conf[r["confidence"]] += 1
    print("\nConfidence mix: " + ", ".join(
        f"{k}={v}" for k, v in sorted(by_conf.items(), key=lambda kv: (CONF_RANK.get(kv[0], 9), kv[0]))))
    verified = by_conf.get("verified", 0)
    print(f"  Only {verified}/{len(rows)} read from a firm's own site. "
          f"Everything else is a prompt to check, not a fact to trust.")

    if a.check:
        if requests is None:
            print("\n--check needs `requests`.")
            return 1
        print("\nSource URL check:")
        for r in rows:
            url = r.get("source")
            if not url:
                print(f"  {r['firm'][:34]:34s} no source URL recorded")
                continue
            try:
                resp = requests.get(url, timeout=15, allow_redirects=True,
                                    headers={"User-Agent": "jobops/0.1"})
                mark = "ok " if resp.status_code < 400 else "DEAD"
                print(f"  {r['firm'][:34]:34s} {mark} {resp.status_code}")
            except Exception as e:  # noqa: BLE001
                print(f"  {r['firm'][:34]:34s} ERR  {type(e).__name__}")

    print("\nNext action: open the careers site for anything unconfirmed or stale, "
          "then update `closes` + `verified` + `confidence: verified` in companies.yaml.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
