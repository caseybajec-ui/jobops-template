#!/usr/bin/env python3
"""
gap_themes.py — what to FIX, not what to click.

Across every role scoring at or above a threshold, cluster the scorer's stated
gaps into recurring themes. A gap cited forty times is a specific, addressable
weakness with a deadline attached; the ranking only tells the owner where to apply.

  python gap_themes.py [--min 40] [--top 10]

Clustering is keyword-based on purpose. The alternative is another model call per
gap, and the themes here are stable enough that a rule set is auditable, free, and
does not drift between runs. Anything that matches no theme is reported under
"unclustered" with a count, so silent under-coverage is visible rather than hidden.
"""
import argparse
import json
import re
import sqlite3
from collections import Counter, defaultdict

from console import utf8_stdout
from fetch_jobs import db

# (theme, what it means for the owner, regex). Order matters: first match wins,
# so the more specific themes come first.
#
# THE "WHAT IT MEANS" TEXT IS GENERIC ON PURPOSE. The original instance named
# the owner's own employers and projects in these lines ("frame <employer> as
# ..."), which is a personal fact in a template. Each line now says what the
# theme is and what kind of fix closes it; which of your evidence items to
# frame is in profile.json, not here.
THEMES = [
    ("customer-embedded / deployment experience",
     "Never worked on-site inside a customer's operation. Closable with one "
     "customer-facing project, and named repeatedly as the top blocker.",
     r"customer[- ]facing|customer[- ]embedded|deployment experience|on[- ]site|"
     r"client[- ]facing|enterprise deployment|professional services|field experience|"
     r"embedded (with|in) (a )?(customer|client)"),
    ("CS / technical degree screen",
     "Business degree vs an explicitly required CS/EE/Math/Physics field. Cannot "
     "change the degree; a referral routes around the screen.",
     r"\b(cs|computer science|technical) degree|degree in (computer|electrical|mechanical)|"
     r"cs/|not a (cs|technical)|business major|bachelor'?s? in (computer|engineering)"),
    ("systems / low-level language stack",
     "Python and TypeScript only. C++/Go/Rust/Java keep appearing in defense and "
     "infra postings.",
     r"\b(c\+\+|golang|\bgo\b|rust|java\b|jvm|c#|embedded systems programming)"),
    ("distributed systems / data infrastructure",
     "No Kafka/Spark/Kubernetes/large-scale data work. A side project could "
     "produce a real data point.",
     r"distributed systems|kafka|spark|kubernetes|hadoop|big data|scale[a-z]* data|"
     r"microservice|streaming (data|pipeline)"),
    ("security clearance",
     "Holds none. Sponsorable by most defense employers, but it adds months — "
     "start the conversation early.",
     r"clearance|ts/sci|secret\b|polygraph|cleared"),
    ("hardware / robotics / autonomy domain",
     "Zero hardware exposure. Named as the cap on Saronic; one robotics or "
     "sensor project would move several defense roles.",
     r"hardware|robotics|autonom|sensor|mechanical|manufactur|aerospace domain|"
     r"physical systems|flight|drone|uav|embedded hardware"),
    ("years of full-time experience",
     "Structural until graduation. Not fixable; use it to filter rather than to worry.",
     r"years of (relevant |professional |industry |work )?experience|"
     r"more experience|experience requirement|full[- ]time experience|new grad"),
    ("enterprise / large-org scale",
     "All work has been solo or small-team. Frame the client-facing and "
     "internship evidence as stakeholder-heavy engagements rather than projects.",
     r"large (enterprise|organi|company)|enterprise[- ]scale|fortune|"
     r"cross[- ]functional at scale|bureaucra|institutional"),
    ("specific product/domain knowledge",
     "Lacks the company's own product paradigm. Cheapest fix on the list: read "
     "the docs, build something small on their platform.",
     r"familiar(ity)? with|domain knowledge|product knowledge|ontology|"
     r"their (platform|product)|industry knowledge|vertical"),
    ("location / travel",
     "Role is outside the cities in profile.json location_preferences, or wants "
     "heavy travel.",
     r"location|relocat|travel|on[- ]site requirement|hybrid|in[- ]office"),
    ("PM craft / formal product process",
     "No formal PM tooling or roadmap ownership inside an org. A shipped side "
     "project covers the substance; the vocabulary is learnable.",
     r"product management experience|roadmap|prioriti|a/b test|experimentation|"
     r"product process|shipping at scale|pm experience"),
]
COMPILED = [(n, w, re.compile(p, re.I)) for n, w, p in THEMES]


def theme_of(gap):
    for name, _why, rx in COMPILED:
        if rx.search(gap):
            return name
    return None


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--min", type=int, default=40)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--all-levels", action="store_true",
                    help="include roles that want more experience")
    a = ap.parse_args()

    con = db()
    con.row_factory = sqlite3.Row
    # One model, one scale — a raw score cutoff is meaningful again.
    #
    # Only roles a new grad can actually be hired into. The gaps on a role
    # wanting five years are not gaps the owner can close; they are just facts
    # about a job they cannot take, and including them distorted every hit rate.
    where = "j.closed_at IS NULL AND s.score >= ?"
    if not a.all_levels:
        where += " AND j.entry_level IN ('program','entry')"
    rows = con.execute(
        "SELECT j.company, j.title, s.score, s.gaps, s.model, j.entry_level "
        "FROM jobs j JOIN scores s ON s.key=j.key WHERE " + where, (a.min,)
    ).fetchall()

    counts = Counter()
    roles = defaultdict(set)
    examples = defaultdict(list)
    total_gaps = unclustered = 0

    for r in rows:
        try:
            gaps = json.loads(r["gaps"] or "[]")
        except json.JSONDecodeError:
            continue
        # count each theme once per role, not once per phrasing
        hit = set()
        for g in gaps:
            total_gaps += 1
            t = theme_of(g)
            if t is None:
                unclustered += 1
                continue
            hit.add(t)
            if len(examples[t]) < 3:
                examples[t].append(g[:150])
        for t in hit:
            counts[t] += 1
            roles[t].add(f"{r['company']} — {r['title']}")

    why = {n: w for n, w, _ in THEMES}
    n = len(rows)
    print(f"GAP THEMES across {n} roles scoring {a.min}+  ({total_gaps} gap statements)\n")
    for theme, c in counts.most_common(a.top):
        print(f"  {c:3d}/{n} roles ({c / n * 100:.0f}%)  {theme}")
        print(f"       {why[theme]}")
        if examples[theme]:
            print(f"       e.g. \"{examples[theme][0]}\"")
        print()
    if unclustered:
        print(f"  {unclustered} gap statements matched no theme "
              f"({unclustered / max(1, total_gaps) * 100:.0f}%) — widen THEMES if that grows.")


if __name__ == "__main__":
    main()
