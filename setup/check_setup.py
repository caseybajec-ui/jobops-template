#!/usr/bin/env python3
"""Is this instance set up for one real person, or is it still the template?

    python setup/check_setup.py

Exits 1 with a list of everything wrong, 0 with a one-line summary. It never
fixes anything. Each check is a thing that would otherwise fail SILENTLY: the
fictional example person's name landing on a stranger's cover note, a
placeholder email receiving nobody's digest, a metro code the app does not
know rendering every role as "somewhere else".
"""
from __future__ import annotations

import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# Strings that only the template or its fictional example person contain.
PLACEHOLDERS = ["Jordan Reyes", "example.edu", "Westlake", "jordan.reyes",
                "Casey Bajec", "bajec@", "caseybajec", "USC Marshall"]
# Files allowed to carry them: the example itself and this script.
PLACEHOLDER_OK = {"profile.example.json", "setup/inputs.example.yaml",
                  "setup/check_setup.py", "setup/SETUP.md", "projects.md"}

problems: list[str] = []


def bad(msg: str) -> None:
    problems.append(msg)


def read(path: str) -> str:
    with io.open(path, encoding="utf-8") as f:
        return f.read()


# ---------------------------------------------------------------- profile.json
if not os.path.exists("profile.json"):
    bad("profile.json is missing. Copy profile.example.json and rewrite it (SETUP.md step 1).")
else:
    try:
        p = json.loads(read("profile.json"))
    except Exception as e:  # noqa: BLE001
        p = None
        bad(f"profile.json is not valid JSON: {e}")
    if p:
        if "_readme" in p:
            bad("profile.json still has the example's _readme key.")
        for k in ("name", "graduation", "school", "owner", "citizenship", "clearance",
                  "evidence", "targets", "hard_no", "skills"):
            if k not in p:
                bad(f"profile.json has no `{k}`.")
        o = p.get("owner") or {}
        if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", str(o.get("email", ""))):
            bad("profile.json owner.email is missing or not an address (it is the only digest recipient).")
        terms = o.get("school_search_terms") or []
        if not terms:
            bad("profile.json owner.school_search_terms is empty (alumni ranking and LinkedIn search need it).")
        if not re.match(r"^[A-Za-z]+ \d{4}$", str(p.get("graduation", ""))):
            bad("profile.json graduation must look like 'May 2027'.")
        ev = p.get("evidence") or []
        if len(ev) < 4:
            bad(f"profile.json has {len(ev)} evidence items; a resume has more than that. Aim for 6-12.")
        allowed = {"product", "consulting", "defense", "finance"}
        for item in ev:
            for e in item.get("emphasis") or []:
                if e not in allowed:
                    bad(f"evidence {item.get('id')!r} has emphasis {e!r}; allowed: {sorted(allowed)}.")
            if "[" in str(item.get("text", "")):
                bad(f"evidence {item.get('id')!r} contains a bracket placeholder.")
        if re.search(r"\b(cleared|clearance-eligible|eligible for (a )?(TS|Secret))\b",
                     str(p.get("clearance", "")), re.I):
            bad("profile.json clearance wording claims eligibility or clearance; see CLAUDE.md.")

# ------------------------------------------------------------------- resumes
for f in ("web/public/resume/resume-tech.pdf", "web/public/resume/resume-finance.pdf",
          "resume_tech.md", "resume_finance.md"):
    if not os.path.exists(f):
        bad(f"{f} is missing (SETUP.md step 2).")
for f in ("resume_tech.md", "resume_finance.md"):
    if os.path.exists(f) and len(read(f)) < 800:
        bad(f"{f} is under 800 characters; the converter probably read an empty or image-only PDF.")

# ----------------------------------------------------------- companies.yaml
if not os.path.exists("companies.yaml"):
    bad("companies.yaml is missing.")
else:
    c = read("companies.yaml")
    slugs = len(re.findall(r"^\s{2}-\s+slug:", c, re.M))
    firms = len(re.findall(r"^\s{2}-\s+firm:", c, re.M))
    if slugs < 10:
        bad(f"companies.yaml lists {slugs} boards; the build needs at least 10.")
    if firms < 10:
        bad(f"companies.yaml deadlines: lists {firms} programs; the build needs at least 10.")
    if not re.search(r"^title_include:\s*$", c, re.M):
        bad("companies.yaml has no title_include: block.")

# ------------------------------------------------------------- config.yaml
if not os.path.exists("config.yaml"):
    bad("config.yaml is missing.")
else:
    cfg = read("config.yaml")
    if "2026-01-01T00:00:00" in cfg:
        bad("config.yaml cost.cap_reset is still the template placeholder; set it to the deploy date.")
    gy = re.search(r"^\s+graduation_year:\s*(\d{4})", cfg, re.M)
    if not gy:
        bad("config.yaml preferences.graduation_year is missing.")
    elif os.path.exists("profile.json"):
        try:
            py = re.search(r"(\d{4})", json.loads(read("profile.json")).get("graduation", "")).group(1)
            if py != gy.group(1):
                bad(f"config.yaml graduation_year {gy.group(1)} != profile.json graduation {py}.")
        except Exception:  # noqa: BLE001
            pass
    if os.path.exists("web/lib/geo.js"):
        geo = read("web/lib/geo.js")
        known = set(re.findall(r'^\s*\["([a-z_]+)",', geo, re.M))
        metros = re.search(r"^\s+preferred_metros:\s*\[(.*?)\]", cfg, re.M)
        home = re.search(r"^\s+home_metro:\s*(\S+)", cfg, re.M)
        for code in ([m.strip() for m in metros.group(1).split(",")] if metros else []) \
                + ([home.group(1)] if home else []):
            code = code.strip("'\"")
            if code and code not in known:
                bad(f"config.yaml names metro {code!r}, which web/lib/geo.js does not know "
                    f"(known: {', '.join(sorted(known))}).")
    if re.search(r"^\s+from:\s*JobOps <jobops@example\.com>", cfg, re.M) \
            and not re.search(r"^\s+enabled:\s*false", cfg, re.M):
        bad("config.yaml notifications.from is the placeholder but notifications are enabled; "
            "set a Resend-verified sender or enabled: false.")

# ---------------------------------------------------- placeholders anywhere
SKIP_DIRS = {".git", "node_modules", ".next", ".next-precommit", ".next-verify", "__pycache__", "setup"}
for root, dirs, files in os.walk("."):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        path = os.path.join(root, f).replace("\\", "/")[2:]
        if path in PLACEHOLDER_OK or not f.endswith((".json", ".yaml", ".yml", ".md", ".js", ".mjs", ".py")):
            continue
        try:
            text = read(path)
        except Exception:  # noqa: BLE001
            continue
        for ph in PLACEHOLDERS:
            if ph in text:
                bad(f"{path} still contains {ph!r}.")
                break

if os.path.exists("projects.md") and "Jordan Reyes" in read("projects.md"):
    bad("projects.md still describes the example person's projects (SETUP.md step 3).")

# ------------------------------------------------------------------ report
if problems:
    print("NOT READY. %d problem(s):" % len(problems))
    for m in problems:
        print("  - " + m)
    sys.exit(1)
print("ready: profile, resumes, companies, config and projects are this person's.")
