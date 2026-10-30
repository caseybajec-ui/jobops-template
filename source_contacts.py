#!/usr/bin/env python3
"""Find public names on company sites, rank them, and report. Writes nothing.

  python source_contacts.py --dry-run    # cost, then stop
  python source_contacts.py              # run and print the ranked names

WRITES NOTHING TO People. This prints candidates; promoting one to a contact is
a tap in the app. Nothing is drafted for a name until the owner promotes it.

NO LINKEDIN, EVER. Names come from the company's own site. The only LinkedIn
artefact is the keyword-search URL that the owner clicks themselves, which is a
string this file builds and never fetches. CLAUDE.md rule 2.

WHAT THE MODEL DOES AND DOES NOT DO. A strict regex finds candidate lines; Haiku
decides which of them are real person/title pairs AT THAT COMPANY. It never
decides whether a person is worth contacting -- that is the ranking below, which
is code, because "if code can decide it, code decides it".
"""
import argparse
import io
import json
import os
import re
import sys
import time

import fetch_jobs
import watch_pages as W
from console import utf8_stdout
from owner import OWNER

MODEL = os.environ.get("JOBOPS_SOURCE_MODEL", "claude-haiku-4-5-20251001")
PRICE = {"claude-haiku-4-5-20251001": (1.00, 5.00)}
MAX_TOKENS = 1500
ABORT_OVER = 1.00

# Roughly where a founder stops being reachable by a cold note. Derived from
# open-role count, which is the only size signal this repo actually holds --
# stated as a proxy rather than dressed up as headcount.
SMALL_COMPANY_ROLES = 60

PATHS = ["/team", "/about/team", "/company/team", "/about/leadership",
         "/company/leadership", "/leadership", "/about", "/company",
         "/about-us", "/people", "/our-team"]

# A `site` value in company_sites.json that means "too large for a team page;
# find people through the owner's school search instead". A state, not a
# domain -- see main().
ROUTE_VIA_SCHOOL = "route-via-school"

NAME = re.compile(r"^([A-Z][a-z'’-]{1,15}(?: [A-Z][a-z'’.-]{1,15}){1,2})$")
TITLE = re.compile(
    r"(founder|co-?founder|chief|ceo|cto|coo|president|head of|vp |vice president|"
    r"director|deployment|forward deployed|bizops|business operations|"
    r"chief of staff|product manager|recruit|talent|people ops|gtm|"
    r"go-to-market|operations|program manager)", re.I)

RULES = """You are reading lines scraped from one company's team or about page.

Return the ones that are a REAL PERSON who works at THAT COMPANY, with their
title. Nothing else.

Reject, and do not return:
  - page furniture: "About Us", "Our Team", "View Open Roles", "Privacy Policy"
  - product names, office names, section headings
  - a person who works somewhere ELSE (investors, board members from other
    companies, customer quotes, press mentions). If the line's context suggests
    another employer, drop it.
  - a name with no title anywhere near it

Respond with ONLY this JSON:
{"people": [{"name": "...", "title": "...", "confidence": 0.0}]}

confidence is yours, 0 to 1. Below 0.7 will be discarded, so use it."""


def candidates(dom):
    """(path, lines) for the page with the most name-shaped lines."""
    best = None
    for p in PATHS:
        lines, err = W.fetch(f"https://{dom}{p}")
        if err:
            continue
        names = [ln for ln in lines if NAME.match(ln.strip())]
        if names and (not best or len(names) > len(best[1])):
            # Keep the WHOLE page, not just the name lines: the model needs the
            # title sitting next to a name to pair them, and a list of bare
            # names with the titles stripped out is unpairable.
            best = (p, lines)
        if len(names) >= 5:
            break
        time.sleep(0.2)
    return best


def trim(lines, cap=180):
    """The part of the page worth sending: names, titles, and their neighbours."""
    keep = set()
    for i, ln in enumerate(lines):
        if NAME.match(ln.strip()) or TITLE.search(ln):
            for j in range(max(0, i - 1), min(len(lines), i + 2)):
                keep.add(j)
    out = [lines[i] for i in sorted(keep)]
    return out[:cap]


def known_people(con):
    """name -> company, for everyone the corpus already knows about.

    THE ATTRIBUTION GUARD. Brex's own page lists Alexandr Wang, who runs Scale
    AI. A name that already belongs to a different company is DROPPED rather
    than reassigned: a contact filed under the wrong employer produces a cold
    note that opens by getting the reader's job wrong.
    """
    out = {}
    for r in con.execute("SELECT name, company FROM contacts").fetchall():
        if r["name"]:
            out[norm_name(r["name"])] = r["company"]
    return out


def belongs_elsewhere(name, slug, known):
    """The other company this person already belongs to, or None.

    PURE, AND CALLED BY main(), so a test drives the real rule rather than a
    copy of it. The first version of test_sourcing reimplemented this as a dict
    lookup and passed happily while the shipped check could be deleted
    outright -- the "structure verified, value unverified" failure, for the
    third time in this repository.
    """
    owner = known.get(norm_name(name))
    return owner if owner and owner != slug else None


def norm_name(s):
    return re.sub(r"[^a-z]", "", str(s or "").lower())


# The owner's school, for the alumni ranks. The first search term is the
# school unit the owner actually belongs to (a business school, a college) and
# outranks the wider university, which is every other term. Labels are built
# from the terms so nothing here names a school.
SCHOOL_TERMS = [t for t in (list(OWNER["school_search_terms"])
                            or [OWNER["school_short"]]) if t]
SCHOOL_RANKS = [(0 if i == 0 else 1, f"{t} alum") for i, t in enumerate(SCHOOL_TERMS)]


def school_rank(alum_of):
    """(rank, label) for an alum of the given school term, or None.

    `alum_of` is one of OWNER["school_search_terms"], matched case-insensitively
    so a caller can pass whatever spelling the directory used.
    """
    want = str(alum_of or "").strip().lower()
    for term, (rank, label) in zip(SCHOOL_TERMS, SCHOOL_RANKS):
        if want and want == term.lower():
            return rank, label
    return None


def rank_of(title, company_roles, school_unit=False, university=False, alum_of=None):
    """How useful this person is TO THE OWNER. Lower is better.

    NOT SENIORITY. The CEO of a 40-person startup answers their own email; the
    CEO of Samsara does not. A 56-name Samsara page should surface ops and
    product people, and a 4-name Chaos Industries page should surface the
    founder.

    `school_unit` is an alum of the owner's own school (the first search term,
    rank 0); `university` is an alum of the wider institution (any other term,
    rank 1). `alum_of` names the term directly and takes the same ranks.
    """
    t = (title or "").lower()
    if alum_of:
        got = school_rank(alum_of)
        if got:
            return got
    if school_unit and SCHOOL_RANKS:
        return SCHOOL_RANKS[0]
    if university and SCHOOL_RANKS:
        return SCHOOL_RANKS[1] if len(SCHOOL_RANKS) > 1 else SCHOOL_RANKS[0]
    # The roles the owner is actually applying to.
    if re.search(r"(deployment|forward deployed|chief of staff|bizops|"
                 r"business operations|product manager|operations associate|"
                 r"program manager|gtm|go-to-market)", t):
        return (2, "does the job you are applying for")
    # The people who hire for them.
    if re.search(r"(recruit|talent|people ops|university|campus)", t):
        return (3, "hires for it")
    # A founder is reachable only at a company small enough to answer.
    if re.search(r"(founder|co-?founder|ceo)", t):
        if company_roles is not None and company_roles <= SMALL_COMPANY_ROLES:
            return (4, f"founder at a small company ({company_roles} open roles)")
        return (7, f"founder, but the company is large ({company_roles} roles)")
    if re.search(r"(head of|vp |vice president|director|chief)", t):
        return (5, "senior, may route you to the right person")
    return (6, "on the team")


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    sites = json.loads(io.open(fetch_jobs.repo("company_sites.json"),
                               encoding="utf-8").read())
    con = fetch_jobs.db()
    known = known_people(con)

    roles = {r["company"]: r["n"] for r in con.execute(
        "SELECT company, count(*) AS n FROM jobs WHERE closed_at IS NULL "
        "GROUP BY company").fetchall()}

    payloads = []
    for slug, info in sites.items():
        dom = info.get("site")
        # "unresolved" and "route-via-school" are STATES, not domains.
        # Fetching them would 404 four times and report a quiet flag,
        # which reads as "this company has no team" rather than "we
        # deliberately did not look".
        if dom in (None, "", "unresolved", ROUTE_VIA_SCHOOL):
            why = {"unresolved": "domain unconfirmed",
                   ROUTE_VIA_SCHOOL: "too large for a team page; "
                                     f"route via {SCHOOL_TERMS[0]} search"
                   }.get(dom, "no site recorded")
            print(f"  {info['name']:18s} SKIPPED -- {why}")
            continue
        got = candidates(dom)
        if not got:
            print(f"  {info['name']:18s} no names on any page -- quiet flag")
            continue
        path, lines = got
        payloads.append((slug, info, path, trim(lines)))
        print(f"  {info['name']:18s} {path:20s} {len(trim(lines))} lines to read")

    if not payloads:
        print("NOTHING TO READ. Every site yielded no candidate lines, which is "
              "this tool or this network, not eighteen companies at once.")
        return 1

    inp, outp = PRICE[MODEL]
    tin = sum(700 + len("\n".join(p[3])) // 4 for p in payloads)
    cost = (tin * inp + 400 * len(payloads) * outp) / 1e6 * 0.5
    print(f"\n  {len(payloads)} companies, ~{tin:,} in, batch estimate ${cost:.3f}")
    if cost > ABORT_OVER:
        print(f"REFUSING: over ${ABORT_OVER:.2f}")
        return 1
    if args.dry_run:
        print("--dry-run: nothing sent.")
        return 0

    import anthropic
    client = anthropic.Anthropic()
    results = {}
    for slug, info, path, lines in payloads:
        m = client.messages.create(
            model=MODEL, max_tokens=MAX_TOKENS, system=RULES,
            messages=[{"role": "user",
                       "content": f"COMPANY: {info['name']}\nPAGE: {path}\n\n"
                                  + "\n".join(lines)}])
        txt = "".join(b.text for b in m.content
                      if getattr(b, "type", "") == "text")
        try:
            obj = json.loads(txt[txt.index("{"):txt.rindex("}") + 1])
        except Exception:
            print(f"  {info['name']}: verdict unreadable, skipped")
            continue
        results[slug] = (info, path, obj.get("people") or [])

    print()
    total = dropped = 0
    for slug, (info, path, people) in results.items():
        rows = []
        for p in people:
            nm, ti = p.get("name"), p.get("title")
            if not nm or not ti or (p.get("confidence") or 0) < 0.7:
                continue
            # THE CROSS-COMPANY CHECK.
            owner = belongs_elsewhere(nm, slug, known)
            if owner:
                dropped += 1
                print(f"  DROPPED {nm} from {info['name']}: already known at "
                      f"{owner}")
                continue
            r, why = rank_of(ti, roles.get(slug))
            rows.append((r, nm, ti, why))
        rows.sort(key=lambda x: (x[0], x[1]))
        total += len(rows)
        print(f"\n{info['name']}  ({roles.get(slug, '?')} open roles)  "
              f"https://{info['site']}{path}")
        for r, nm, ti, why in rows[:6]:
            print(f"    {r}  {nm:26s} {ti[:38]:38s} {why}")
        if not rows:
            print("    no usable names")

    print(f"\n{total} candidates across {len(results)} companies, "
          f"{dropped} dropped by the cross-company check.")
    print("NOTHING WAS WRITTEN. Promote a name in the app to make it a contact.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
