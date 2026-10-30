"""Who runs this instance, read from profile.json and nowhere else.

Every personal fact the code needs -- the owner's name, school, graduation
month, email -- comes through here. Nothing in the pipeline may carry a
person's name, school or class year as a literal: the template was built for
one person and had those baked into prompts, outreach templates and the
class-year classifier, which is exactly the kind of thing that survives a copy
and then quietly produces someone else's cover letter.

    from owner import OWNER
    OWNER["name"], OWNER["first_name"], OWNER["grad_year"], OWNER["grad_month"]

profile.json is the source of truth (CLAUDE.md). This module reads the few
fields the code needs and derives the rest; it never writes.
"""
from __future__ import annotations

import json
import re

import paths

_MONTHS = ["january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december"]


def _parse_graduation(s: str):
    """'May 2027' or '2027-05' -> (2027, 5). Raises on anything else."""
    t = str(s or "").strip()
    m = re.match(r"^([A-Za-z]+)\s+(\d{4})$", t)
    if m and m.group(1).lower() in _MONTHS:
        return int(m.group(2)), _MONTHS.index(m.group(1).lower()) + 1
    m = re.match(r"^(\d{4})-(\d{2})(?:-\d{2})?$", t)
    if m:
        return int(m.group(1)), int(m.group(2))
    raise ValueError(f"profile.json graduation is {s!r}; write it as 'May 2027'")


def load(path=None) -> dict:
    path = path or paths.repo("profile.json")
    with open(path, encoding="utf-8") as f:
        p = json.load(f)
    name = str(p.get("name") or "").strip()
    if not name:
        raise ValueError("profile.json has no `name`")
    o = dict(p.get("owner") or {})
    year, month = _parse_graduation(p.get("graduation"))
    first = str(o.get("first_name") or name.split()[0]).strip()
    terms = o.get("school_search_terms") or []
    if isinstance(terms, str):
        terms = [terms]
    school_short = str(o.get("school_short") or (terms[0] if terms else "")).strip()
    return {
        "name": name,
        "first_name": first,
        "email": str(o.get("email") or "").strip(),
        "school": str(p.get("school") or "").strip(),
        "school_short": school_short,
        "school_search_terms": [str(t) for t in terms if str(t).strip()],
        "school_linkedin_alumni_url": str(o.get("school_linkedin_alumni_url") or "").strip(),
        "class_label": str(o.get("class_label") or "student").strip(),
        "degree": str(o.get("degree") or "").strip(),
        "home_city": str(o.get("home_city") or "").strip(),
        "graduation": str(p.get("graduation")).strip(),
        "grad_year": year,
        "grad_month": month,
        "grad_month_name": _MONTHS[month - 1].capitalize(),
        "target_start": str(p.get("target_start") or "").strip(),
        "citizenship": str(p.get("citizenship") or "").strip(),
        "clearance": str(p.get("clearance") or "").strip(),
    }


OWNER = load()
