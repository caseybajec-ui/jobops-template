#!/usr/bin/env python3
"""Watch careers pages the fetcher cannot read, and say when they change.

  python watch_pages.py check          # fetch every page, hash, report
  python watch_pages.py list           # what is watched, and when it last moved
  python watch_pages.py add <url> <label> [--company X] [--category Y] [--regex R]
  python watch_pages.py probe <url>    # fetch once and show what would be hashed

WHY THIS EXISTS. McKinsey's 2027 window ran 2026-07-01 to 2026-08-11 and shut
before this tool existed, while companies.yaml said "typically mid/late
September". Consulting, PM cohorts and the primes' LDPs have no machine-readable
board and never will; the only thing automatable about them is noticing the page
moved.

NO MODEL IN THIS PATH, DELIBERATELY. Hash and regex only. A model reading a
careers page produces a confident wrong date -- the exact failure the McKinsey
note already caused, and the reason verify_deadlines.py refuses to scrape. This
does not decide what a page MEANS. It reports that the bytes moved and prints
the lines that differ. A human reads them.

FAILURE IS NEVER "NO CHANGE". A 403, a login redirect, a bot check, an empty
body: each is a broken watcher and is reported red. "An always-empty source and
an always-zero count are the same bug" -- a watcher that quietly reports nothing
for six weeks is worse than no watcher, because it occupies the slot.
"""
import argparse
import difflib
import hashlib
import io
import os
import re
import sys
import time

import requests

import fetch_jobs
from console import utf8_stdout

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

TIMEOUT = 25
DIFF_CAP = 5000          # characters of diff kept; the rest is truncated loudly
STALE_DAYS = 90          # unchanged for this long gets a quiet flag

# Everything that is not content. Stripped BEFORE hashing, because a careers
# page rewrites a build id, a CSRF token and a timestamp on every request --
# hash the raw body and every page "changes" every night, which is noise, and
# noise in this section is indistinguishable from the thing it exists to report.
_STRIP = [
    (re.compile(r"<script\b.*?</script>", re.S | re.I), " "),
    (re.compile(r"<style\b.*?</style>", re.S | re.I), " "),
    (re.compile(r"<noscript\b.*?</noscript>", re.S | re.I), " "),
    (re.compile(r"<svg\b.*?</svg>", re.S | re.I), " "),
    (re.compile(r"<!--.*?-->", re.S), " "),
    # Nav and chrome: present on every page, changes when the company ships a
    # new marketing banner, tells us nothing about the programme.
    (re.compile(r"<nav\b.*?</nav>", re.S | re.I), " "),
    (re.compile(r"<header\b.*?</header>", re.S | re.I), " "),
    (re.compile(r"<footer\b.*?</footer>", re.S | re.I), " "),
]

# Volatile tokens inside the content region itself.
_VOLATILE = [
    # Cache-busting and build ids: ?v=abc123, /_next/static/<hash>/
    (re.compile(r"[?&](?:v|ver|version|build|cb|t|ts|_)=[A-Za-z0-9._-]+"), ""),
    (re.compile(r"/_next/static/[A-Za-z0-9_-]+/"), "/_next/static/BUILD/"),
    # Tracking parameters, which some pages regenerate per request.
    (re.compile(r"[?&]utm_[a-z]+=[^&\"'\s>]*"), ""),
    (re.compile(r"[?&]gh_src=[^&\"'\s>]*"), ""),
    # Long hex/base64 blobs: nonces, CSRF tokens, asset digests.
    (re.compile(r"\b[0-9a-f]{16,}\b", re.I), "HEX"),
    # Dates and times that are simply "now".
    (re.compile(r"\b20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d[0-9.:+Z-]*"), "TS"),
    (re.compile(r"\b(?:19|20)\d\d\b"), "YEAR"),
]

# A page that came back as one of these is BROKEN, not unchanged.
_BOT_MARKERS = re.compile(
    r"(?:just a moment|checking your browser|cf-browser-verification|"
    r"enable javascript and cookies|access denied|are you a robot|"
    r"unusual traffic|captcha|incapsula|distil|please verify you are a human)",
    re.I)
# A PARKED OR FOR-SALE DOMAIN. It loads, it has content, and it contains the
# company's own name -- which is exactly why a name-match check confirms it.
# chaosindustries.com returned "ChaosIndustries.com is for sale | HugeDomains"
# and passed identity verification on the strength of the name in the sale
# listing. A page that loads is not a page that is theirs.
_PARKED_MARKERS = re.compile(
    r"(is for sale|hugedomains|domain (?:is )?(?:for sale|parking)|"
    r"buy this domain|godaddy auctions|sedo\.com|dan\.com|afternic|"
    r"this domain (?:may be|is) for sale|inquire about this domain)", re.I)

_LOGIN_MARKERS = re.compile(
    r"(?:<input[^>]+type=[\"']password|sign in to continue|please log in|"
    r"you must be logged in)", re.I)


def normalize(html):
    """The content region, with everything volatile removed.

    Returns plain text lines. Text rather than markup because a diff of markup
    is unreadable, and the digest has to show a human what moved -- an added
    <div class="x"> tells nobody anything, "Applications open 30 September"
    tells them everything.
    """
    s = html or ""
    for pat, rep in _STRIP:
        s = pat.sub(rep, s)
    for pat, rep in _VOLATILE:
        s = pat.sub(rep, s)
    # Tags to spaces, entities to something readable enough to diff.
    s = re.sub(r"<[^>]+>", "\n", s)
    s = (s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&#39;", "'")
          .replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">"))
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in s.split("\n")]
    # Drop empties and one-character fragments left by tag removal.
    return [ln for ln in lines if len(ln) > 1]


def content_hash(lines):
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def fetch(url):
    """(lines, error). `error` is a string when the watcher could not see the page."""
    try:
        r = requests.get(url, timeout=TIMEOUT, allow_redirects=True,
                         headers={"User-Agent": UA,
                                  "Accept": "text/html,application/xhtml+xml",
                                  "Accept-Language": "en-US,en;q=0.9"})
    except requests.RequestException as e:
        return None, f"request failed: {type(e).__name__}"

    if r.status_code == 403:
        return None, "HTTP 403 (blocked)"
    if r.status_code == 429:
        return None, "HTTP 429 (rate limited)"
    if r.status_code >= 400:
        return None, f"HTTP {r.status_code}"

    return classify(r.text or "")


def classify(body):
    """(lines, error) for a response body. Pure, so it can be tested.

    Split out of fetch() because the interesting decisions -- is this a bot
    wall, a login, a JS shell, or a real page -- are the ones worth a test, and
    they were unreachable while they sat behind a network call. The mutation
    audit found exactly that: removing the JS-shell floor changed nothing that
    any test could see.
    """
    if len(body.strip()) == 0:
        return None, "empty body"

    # NORMALISE FIRST, THEN LOOK FOR BOT MARKERS.
    #
    # Checking the RAW body rejected Atlassian's and Adobe's real careers pages
    # -- both HTTP 200 with 85 and 75 lines of genuine content -- because each
    # loads reCAPTCHA for its apply form and the word "captcha" appears in a
    # <script src>. A watcher that reports every healthy page as blocked is
    # worse than none: it fills the health line with false alarms until the
    # section is ignored, which is the failure mode this whole item exists to
    # prevent.
    #
    # A real interstitial has almost no content, so it is caught here AND by
    # the line-count floor below. The markers now only fire on text a human
    # would have seen.
    lines = normalize(body)
    visible = "\n".join(lines)[:20000]
    if _BOT_MARKERS.search(visible):
        return None, "bot check page"
    if _LOGIN_MARKERS.search(visible) or _LOGIN_MARKERS.search(body[:4000]):
        return None, "redirected to a login"
    if _PARKED_MARKERS.search(visible[:4000]):
        return None, "parked/for-sale domain, not the company"

    # A page that normalises to almost nothing is a JS shell, not a careers
    # page. Ashby returns HTTP 200 with a JS shell for ANY slug -- a 200 proves
    # nothing, which is the lesson already written into board discovery.
    if len(lines) < 15:
        return None, f"only {len(lines)} content lines (JS shell?)"
    return lines, None


def window_opened(has_regex, prev_hit, hit, first_sight):
    """Is this a WINDOW OPENED event?

    Pure, and called by do_check, so a test can exercise the real rule instead
    of a copy of it. The first version of test_watch reimplemented this as a
    local `flip()` helper -- which passed happily while the shipped code had
    the bug, because the two were never the same code. That is the
    "structure verified, value unverified" failure exactly.

    Absent -> present only. A page that STOPS saying "apply now" has closed:
    worth seeing in the diff, not worth an alarm at the top of the digest.

    NEVER ON FIRST SIGHT. last_status_hit defaults to 0, so a page already
    saying "applications are open" on the night it is added would report an
    opening that happened before this tool could see it. Four of the fifteen
    seeds did exactly that on the baseline run.
    """
    return bool(has_regex) and bool(hit) and not prev_hit and not first_sight


def diff_summary(old_lines, new_lines, cap=DIFF_CAP):
    """Added and removed lines, capped, saying so when it truncates."""
    old = old_lines or []
    add, rem = [], []
    for ln in difflib.unified_diff(old, new_lines, n=0, lineterm=""):
        if ln.startswith("+++") or ln.startswith("---") or ln.startswith("@@"):
            continue
        if ln.startswith("+"):
            add.append(ln[1:])
        elif ln.startswith("-"):
            rem.append(ln[1:])
    parts = []
    if add:
        parts.append("ADDED:\n" + "\n".join("  + " + a for a in add))
    if rem:
        parts.append("REMOVED:\n" + "\n".join("  - " + r for r in rem))
    out = "\n".join(parts)
    if len(out) > cap:
        out = out[:cap] + f"\n... TRUNCATED at {cap} characters, {len(add)} added / {len(rem)} removed in total"
    return out


def do_check(con, only=None, quiet=False):
    rows = con.execute(
        "SELECT url, label, company, category, last_hash, status_regex, "
        "       last_status_hit, last_changed_at, fail_streak "
        "  FROM watched_pages ORDER BY label").fetchall()
    if only:
        rows = [r for r in rows if only.lower() in (r["label"] or "").lower()
                or only.lower() in r["url"].lower()]
    if not rows:
        # A run that checked NOTHING must not report success. This is the
        # zero-output guard: an empty table means the seed never ran, and a
        # cheerful "0 pages changed" would hide that indefinitely.
        print("NOTHING WATCHED. watched_pages is empty, so this run checked "
              "nothing and proved nothing. Seed it with `python watch_pages.py "
              "add`, or run seed_watched.py.")
        return 2

    changed = opened = broke = 0
    now = fetch_jobs.now()
    for r in rows:
        lines, err = fetch(r["url"])
        if err:
            con.execute(
                "UPDATE watched_pages SET last_checked_at = ?, last_error = ?, "
                "fail_streak = fail_streak + 1 WHERE url = ?",
                (now, err, r["url"]))
            broke += 1
            if not quiet:
                print(f"  BROKEN  {r['label']}: {err}")
            time.sleep(1)
            continue

        h = content_hash(lines)
        text = "\n".join(lines)
        hit = 0
        if r["status_regex"]:
            try:
                hit = 1 if re.search(r["status_regex"], text, re.I) else 0
            except re.error as e:
                # A broken regex is reported, never silently treated as "no".
                con.execute(
                    "UPDATE watched_pages SET last_checked_at = ?, last_error = ? "
                    "WHERE url = ?", (now, f"bad status_regex: {e}", r["url"]))
                broke += 1
                if not quiet:
                    print(f"  BROKEN  {r['label']}: bad status_regex ({e})")
                continue

        # WINDOW OPENED: the regex went from absent to present. Only that
        # direction -- a page that stops saying "apply now" is a closing, which
        # is worth seeing in the diff but is not an emergency.
        #
        # NEVER ON THE FIRST SIGHTING. `last_status_hit` defaults to 0, so a
        # page already saying "applications are open" on the night it is added
        # would report an opening that happened before this tool could see it.
        # Four of the fifteen seeds did exactly that on the baseline run. It is
        # the same rule already applied to the hash one branch below -- a first
        # check establishes what IS, and only a later check can report a change
        # -- and forgetting it here would put a false emergency at the top of
        # the digest, which is the one place a false alarm is most expensive.
        first_sight = r["last_hash"] is None
        just_opened = window_opened(r["status_regex"], r["last_status_hit"],
                                    hit, first_sight)

        if r["last_hash"] is None:
            # First sight. Record the baseline; a first check is not a change,
            # or every page would "change" on the night it is added.
            con.execute(
                "UPDATE watched_pages SET last_hash = ?, last_checked_at = ?, "
                "last_error = NULL, fail_streak = 0, last_status_hit = ?, "
                "last_diff = NULL WHERE url = ?",
                (h, now, hit, r["url"]))
            if not quiet:
                print(f"  baseline {r['label']} ({len(lines)} lines)")
        elif h != r["last_hash"]:
            prev = con.execute(
                "SELECT last_lines FROM watched_snapshots WHERE url = ?",
                (r["url"],)).fetchone()
            old_lines = (prev["last_lines"] or "").split("\n") if prev else []
            summary = diff_summary(old_lines, lines)
            con.execute(
                "UPDATE watched_pages SET last_hash = ?, last_changed_at = ?, "
                "last_checked_at = ?, last_error = NULL, fail_streak = 0, "
                "last_status_hit = ?, last_diff = ? WHERE url = ?",
                (h, now, now, hit, summary, r["url"]))
            changed += 1
            if not quiet:
                print(f"  CHANGED {r['label']}")
        else:
            con.execute(
                "UPDATE watched_pages SET last_checked_at = ?, last_error = NULL, "
                "fail_streak = 0, last_status_hit = ? WHERE url = ?",
                (now, hit, r["url"]))

        # The full normalised text, so the NEXT run can diff against it.
        con.execute(
            "INSERT INTO watched_snapshots (url, last_lines, saved_at) "
            "VALUES (?,?,?) ON CONFLICT (url) DO UPDATE SET "
            "last_lines = excluded.last_lines, saved_at = excluded.saved_at",
            (r["url"], text[:400000], now))

        if just_opened:
            opened += 1
            if not quiet:
                print(f"  *** WINDOW OPENED: {r['label']} ***")
        con.commit()
        time.sleep(1)

    print(f"\n{len(rows)} watched: {changed} changed, {opened} WINDOW OPENED, "
          f"{broke} broken.")
    if broke == len(rows):
        # Every single page failed. That is a network or a user-agent problem,
        # not twenty companies redesigning at once, and it must not read as a
        # quiet night.
        print("EVERY page failed. That is this tool, not those pages.")
        return 1
    return 0


def do_list(con):
    rows = con.execute(
        "SELECT * FROM watched_pages ORDER BY category, label").fetchall()
    if not rows:
        print("Nothing watched.")
        return 2
    for r in rows:
        state = (f"ERROR {r['last_error']}" if r["last_error"]
                 else (f"changed {str(r['last_changed_at'])[:10]}"
                       if r["last_changed_at"] else "no change yet"))
        print(f"  {str(r['category'] or '-'):10s} {r['label'][:34]:34s} {state}")
        print(f"             {r['url'][:96]}")
    print(f"\n{len(rows)} pages watched.")
    return 0


def do_add(con, url, label, company, category, regex, notes):
    con.execute(
        "INSERT INTO watched_pages (url, label, company, category, "
        " status_regex, notes, created_at) VALUES (?,?,?,?,?,?,?) "
        "ON CONFLICT (url) DO UPDATE SET label = excluded.label, "
        " company = excluded.company, category = excluded.category, "
        " status_regex = excluded.status_regex, notes = excluded.notes",
        (url, label, company, category, regex, notes, fetch_jobs.now()))
    con.commit()
    print(f"watching {label}: {url}")
    return 0


def do_probe(url):
    lines, err = fetch(url)
    if err:
        print(f"FAILED: {err}")
        return 1
    print(f"{len(lines)} content lines, hash {content_hash(lines)[:16]}")
    for ln in lines[:25]:
        print("  " + ln[:110])
    if len(lines) > 25:
        print(f"  ... {len(lines) - 25} more")
    return 0


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--only")
    c.add_argument("--quiet", action="store_true")
    sub.add_parser("list")
    a = sub.add_parser("add")
    a.add_argument("url")
    a.add_argument("label")
    a.add_argument("--company")
    a.add_argument("--category")
    a.add_argument("--regex")
    a.add_argument("--notes")
    p = sub.add_parser("probe")
    p.add_argument("url")
    args = ap.parse_args()

    if args.cmd == "probe":
        return do_probe(args.url)

    con = fetch_jobs.db()
    if args.cmd == "check":
        return do_check(con, only=args.only, quiet=args.quiet)
    if args.cmd == "list":
        return do_list(con)
    if args.cmd == "add":
        return do_add(con, args.url, args.label, args.company, args.category,
                      args.regex, args.notes)
    return 1


if __name__ == "__main__":
    sys.exit(main())
