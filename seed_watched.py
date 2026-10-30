#!/usr/bin/env python3
"""Seed watched_pages, and record what could NOT be reached.

  python seed_watched.py            # add the reachable pages, report the rest
  python seed_watched.py --probe    # fetch each first and only add what works

EVERY URL HERE WAS FETCHED AND READ, not guessed. The ones that failed are
listed at the bottom of this file with the reason, because "we could not watch
Meta" is a fact the owner needs in the morning report and an empty row is not.

WHY SOME ROWS ARE THIRD-PARTY TRACKERS. Deloitte, Accenture and EY-Parthenon
have no single machine-readable programme page; the deadline data in
companies.yaml already comes from extern.com, and that tracker IS the source of
record for those three today. The label says so, so nobody mistakes a tracker
moving for the firm announcing something. Where the firm's own page works --
Bain, BCG, Atlassian, Adobe, RTX, Boeing, a16z -- the firm's own page is used.

STATUS REGEX. Only where the page could plausibly say it. A regex on a search
results page would fire on any posting containing "apply now", which is every
posting, so those rows have none: the hash is the signal there.
"""
import argparse
import sys

import fetch_jobs
import watch_pages as W
from console import utf8_stdout

OPEN_RE = (r"(applications?\s+(?:are\s+)?(?:now\s+)?open"
           r"|now\s+accepting\s+applications"
           r"|accepting\s+applications"
           r"|apply\s+by\s+\w+\s+\d"
           r"|applications?\s+close)")

# (url, label, company, category, status_regex, notes)
PAGES = [
    # ---- consulting -------------------------------------------------------
    ("https://www.extern.com/post/consulting-internships-summer-2027-guide",
     "Deloitte / Accenture / EY-Parthenon (tracker)", None, "consulting", OPEN_RE,
     "Third-party tracker. It is already the source for these three dates in "
     "companies.yaml; none of the firms has a readable programme page. A change "
     "here is the TRACKER moving, not the firm announcing."),
    ("https://www.myconsultingcoach.com/consulting-application-deadlines",
     "L.E.K. / Kearney / ZS / Analysis Group (tracker)", None, "consulting", OPEN_RE,
     "Third-party tracker, same caveat. Four firms share it."),
    ("https://managementconsulted.com/mbb-application-deadlines/",
     "MBB deadlines (tracker)", None, "consulting", OPEN_RE,
     "Tracker. McKinsey's 2027 window closed 11 Aug 2026 while companies.yaml "
     "said mid/late September -- this page is watched so that miss is visible "
     "next cycle."),
    ("https://www.bain.com/careers/find-a-role/", "Bain, own careers page",
     None, "consulting", OPEN_RE, "The firm's own page, not a tracker."),
    ("https://careers.bcg.com/global-search-results", "BCG, own careers page",
     None, "consulting", None,
     "Search results: a status regex would fire on any posting."),
    ("https://www.extern.com/post/oliver-wyman-internship-guide",
     "Oliver Wyman (tracker)", None, "consulting", OPEN_RE, None),

    # ---- product / APM cohorts -------------------------------------------
    ("https://www.atlassian.com/company/careers/graduates/apm",
     "Atlassian APM, own programme page", "atlassian", "product", OPEN_RE,
     "The firm's own APM page. 85 content lines."),
    ("https://careers.adobe.com/us/en/university",
     "Adobe university programmes", "adobe", "product", OPEN_RE, None),
    ("https://www.google.com/about/careers/applications/jobs/results/"
     "?q=associate%20product%20manager",
     "Google APM search", "google", "product", None,
     "Search results, so no status regex. Last cycle ran 30 Sep to 28 Oct -- a "
     "28-day window, not a season."),
    ("https://www.uber.com/us/en/careers/list/?query=associate%20product%20manager",
     "Uber APM search", "uber", "product", None, "Search results."),
    ("https://www.coinbase.com/careers/positions", "Coinbase careers",
     "coinbase", "product", None, "Full listing; hash is the signal."),
    ("https://www.linkedin.com/jobs/linkedin-jobs/", "LinkedIn jobs at LinkedIn",
     "linkedin", "product", None,
     "LinkedIn's own hiring page. Reading a public page, not scraping profiles "
     "-- CLAUDE.md rule 2 is about member data."),

    # ---- defense primes ---------------------------------------------------
    ("https://www.rtx.com/careers/early-career", "RTX early career",
     None, "defense", OPEN_RE, "133 content lines."),
    ("https://jobs.boeing.com/category/university-jobs/185/4567/1",
     "Boeing university jobs", None, "defense", None,
     "1,147 content lines -- a full listing page, so hash-only."),

    # ---- venture ----------------------------------------------------------
    ("https://a16z.com/jobs/", "a16z jobs", None, "vc", OPEN_RE, None),
]

# Fetched and failed, 2026-09-07. Recorded rather than dropped: a page nobody
# can watch is a gap the owner has to cover by hand, and an absent row says nothing.
UNREACHABLE = [
    ("Meta RPM", "https://www.metacareers.com/rotational-programs/", "HTTP 400"),
    ("Meta RPM (alt)", "https://www.metacareers.com/careerprograms/pathways/rpm", "HTTP 400"),
    ("Microsoft PM", "https://jobs.careers.microsoft.com/global/en/search?et=Students%20and%20graduates",
     "JS shell, 5 content lines"),
    ("Duolingo APM", "https://careers.duolingo.com/", "JS shell, 1 content line"),
    ("Capital One", "https://www.capitalonecareers.com/students-and-grads", "HTTP 404"),
    ("Lockheed Martin", "https://www.lockheedmartinjobs.com", "HTTP 502"),
    ("Lockheed Martin (alt)", "https://www.lockheedmartin.com/en-us/careers/students-and-graduates.html", "HTTP 502"),
    ("Northrop Grumman", "https://www.northropgrumman.com/careers/students-and-entry-level", "HTTP 404"),
    ("General Dynamics", "https://www.gd.com/careers/students-and-grads", "HTTP 410"),
    ("McKinsey", "https://www.mckinsey.com/careers/search-jobs", "ConnectionError"),
    ("Bain (tracker)", "https://www.hackingthecaseinterview.com/pages/bain-application-deadline", "HTTP 403"),
    ("McKinsey (Yale blog)", "https://ocs.yale.edu/blog/2026/03/06/mckinsey-bain-and-bcg-application-deadlines-for-2026-summer-and-full-time-roles/", "HTTP 410"),
    # NOT worked around. CLAUDE.md: never disable certificate verification to
    # make a connection work. An SSLError has a real cause and turning off
    # verification hides it forever.
    ("General Catalyst", "https://www.generalcatalyst.com/careers", "SSLError -- NOT bypassed"),
]


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true",
                    help="fetch each page first; add only what actually works")
    args = ap.parse_args()

    con = fetch_jobs.db()
    added = skipped = 0
    for url, label, company, category, regex, notes in PAGES:
        if args.probe:
            lines, err = W.fetch(url)
            if err:
                print(f"  SKIP  {label}: {err}")
                skipped += 1
                continue
            print(f"  ok    {label} ({len(lines)} lines)")
        con.execute(
            "INSERT INTO watched_pages (url, label, company, category, "
            " status_regex, notes, created_at) VALUES (?,?,?,?,?,?,?) "
            "ON CONFLICT (url) DO UPDATE SET label = excluded.label, "
            " company = excluded.company, category = excluded.category, "
            " status_regex = excluded.status_regex, notes = excluded.notes",
            (url, label, company, category, regex, notes, fetch_jobs.now()))
        added += 1
    con.commit()

    # A SEED THAT SEEDED NOTHING IS A FAILURE, not a quiet success.
    if added == 0:
        print("SEEDED NOTHING. Every page failed its probe, which is this tool "
              "or this network, not fifteen companies at once.")
        return 1

    print(f"\n{added} pages watched, {skipped} skipped.")
    print(f"\n{len(UNREACHABLE)} pages could NOT be watched, and stay unwatched:")
    for label, url, why in UNREACHABLE:
        print(f"  {label:24s} {why:32s} {url[:56]}")
    print("\nThose need a human eye on a calendar, or a different URL. None of "
          "them is guessed at here.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
