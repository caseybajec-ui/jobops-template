#!/usr/bin/env python3
"""
classify.py — deterministic classification of a posting. No model calls, ever.

Everything here is derived from text the fetcher already stored: entry level,
compensation, clearance situation. Kept in its own module because it is the part
most likely to need tuning, and because regex-heavy code should not be edited
through shell heredocs — several patterns were silently corrupted that way
(a `\\b` collapsed into a literal backspace byte, so the pattern matched nothing
and every management title was classified as entry level).

Run `python classify.py --validate` to hand-check a stratified sample.
"""
import argparse
import re

from owner import OWNER

# ---------------------------------------------------------------- entry level
#
# The single most important field in the product. The owner graduates at
# OWNER["graduation"] and wants roles that hire out of college. The inbox was
# mixing those with roles wanting five years and nothing on screen told them
# apart.
#
#   program      explicit new-grad / early-career programme
#   entry        0-1 years or unstated, no seniority signal
#   experienced  2+ years or seniority signals — networking intelligence only

ENTRY_LEVELS = ("program", "entry", "experienced")

PROGRAM_RE = re.compile(
    r"\b(new[ -]grad(uate)?|early[ -]career|university (grad|recruit|program)"
    r"|campus|class of 202[6-9]|202[6-9] start|graduating in|rotational"
    r"|leadership development|analyst program|associate program|apm program"
    r"|new college grad|recent graduate|entry[- ]level program)\b", re.I)

SENIOR_TITLE_RE = re.compile(
    r"\b(senior|sr\.?|staff|principal|director|head of|vp|lead|distinguished"
    r"|architect|chief)\b", re.I)

# Titles that contain a seniority word but are NOT senior. "Chief of Staff" trips
# both `chief` and `staff`; it is a tier-1 target and must survive. Same trap the
# title filter hit — see title_protect in companies.yaml.
PROTECT_RE = re.compile(r"\bchief of staff\b", re.I)

# "Manager" alone is NOT a seniority signal — "Product Manager" and "Program
# Manager" are legitimate new-grad titles. But "Engineering Manager" and "Field
# Marketing Manager" run a function or a team and never hire a new grad.
FUNCTION_MANAGER_RE = re.compile(
    r"\b(engineering|marketing|sales|finance|accounting|people|hr|talent|design"
    # NOT "operations": "Product Operations Manager", "Business Operations
    # Manager" and "Mission Operations Manager" are all tier-1 target titles.
    r"|security|account|customer success|partner|regional|district|general"
    r"|communications|recruiting|facilities|legal)\s+manager\b"
    r"|^manager\s*[,:]|\bmanager\s+of\b", re.I)

# Any stated years figure, used as a soft signal only. A high number under
# "preferred qualifications" does not disqualify at the gate, but it does say
# the role is not aimed at a new grad.
SOFT_YEARS_RE = re.compile(
    r"(\d{1,2})\s*\+?\s*years?(?:\s+of)?\s+(?:\w+\s+){0,3}?experience", re.I)
SOFT_YEARS_CUTOFF = 4


# A base-salary floor far above the new-grad range is itself a seniority signal.
# Confirmed new-grad programme roles in this corpus top out at $203K with a p90
# of $140K, so anything starting at $200K+ is not a new-grad role. This caught
# 124 misclassifications in one pass — Anthropic's Technical Program Managers at
# $365K and Research Product Managers at $385K, none of which state a years
# requirement anywhere, so no other rule could see them.
#
# Checked AFTER the programme rules, so an explicit new-grad posting can never be
# reclassified by its pay.
COMP_SENIOR_FLOOR = 200000

# A flat floor cuts deepest at the companies that simply pay most, which is
# backwards: Anthropic's lowest-paid role is $131K and OpenAI's is $146K, so
# $200K there is mid-level, while at Hadrian it is far above anything on the board.
#
# Primary rule is therefore RELATIVE — above that company's own 75th percentile.
# A percentile needs a real sample to mean anything, so below this many known-pay
# roles the company falls back to the absolute floor.
COMP_MIN_SAMPLE = 10


def comp_thresholds(rows):
    """{company: base-salary threshold above which a role reads as senior}.

    `rows` is any iterable of mappings with `company` and `comp_min`.
    """
    by = {}
    for r in rows:
        v = r["comp_min"] if not hasattr(r, "get") else r.get("comp_min")
        co = r["company"] if not hasattr(r, "get") else r.get("company")
        if v:
            by.setdefault(co, []).append(v)
    out = {}
    for co, vals in by.items():
        if len(vals) >= COMP_MIN_SAMPLE:
            vals.sort()
            out[co] = vals[int(len(vals) * 0.75)]
        else:
            out[co] = COMP_SENIOR_FLOOR
    return out


def entry_level(title, description, yoe=None, comp_min=None, comp_floor=None):
    """One of ENTRY_LEVELS. Title carries far more signal than body prose, so a
    programme phrase in the TITLE wins outright."""
    title = title or ""
    body = (description or "")[:6000]

    if PROGRAM_RE.search(title):
        return "program"
    protected = bool(PROTECT_RE.search(title))
    if not protected and (SENIOR_TITLE_RE.search(title)
                          or FUNCTION_MANAGER_RE.search(title)):
        return "experienced"
    if yoe is not None and yoe >= 2:
        return "experienced"
    if PROGRAM_RE.search(body):
        return "program"
    # Company-relative first, absolute floor as a second check. Both must be
    # cleared: a role above its company's p75 AND above the absolute floor is
    # senior; one above only the relative bar at a low-paying company is not.
    if comp_min:
        rel = comp_floor if comp_floor else COMP_SENIOR_FLOOR
        if comp_min > rel and comp_min >= COMP_SENIOR_FLOOR:
            return "experienced"
    # The soft-years signal applies ONLY when nothing was extracted as required.
    # An extracted requirement of 0-1 years beats a "preferred: 5+ years" line —
    # it wrongly marked Anduril's Mission Software Engineer (requires 1) and
    # Stripe's Consumer Operations Program Manager (requires 1) as experienced.
    if yoe is None:
        m = SOFT_YEARS_RE.search(body)
        if m and int(m.group(1)) >= SOFT_YEARS_CUTOFF:
            return "experienced"
    return "entry"


# ----------------------------------------------------------------- class year
#
# The owner graduates in GRAD_MONTH of GRAD_YEAR (from profile.json) and can
# start work the summer after. A role that hires a graduate from the class
# before is not theirs, however perfectly it matches otherwise — and it reads
# as a perfect match, because "New Grad" is exactly the phrase the entry-level
# classifier is looking for. With a May 2027 graduation these were on screen
# tagged "new-grad program":
#
#   Notion            Software Engineer, New Grad (Dec 2026)
#   Applied Intuition Software Engineer - New Grad (December 2026)
#   Verkada           Technical Support Engineer - University Graduate 2026
#   Anduril           2026 Early Career Software Engineer
#   Bessemer          Summer Analyst 2027        (an internship, and the class after)
#
# Nothing else in the pipeline can catch these: they are not senior, not remote,
# not foreign, and not underpaid.

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
# Seasons map to the month a class actually starts, not the solstice.
_SEASONS = {"spring": 3, "summer": 6, "fall": 9, "autumn": 9, "winter": 12}

_MONTH_RE = (r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?"
             r"|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?"
             r"|dec(?:ember)?)")
_SEASON_RE = r"(spring|summer|fall|autumn|winter)"
_GRAD = r"(?:new[ -]grad(?:uate)?s?|university grad(?:uate)?s?|early career|college grad(?:uate)?s?)"

# STRONG patterns state a class or a start explicitly. Safe to read from the body.
_STRONG = [
    ("class", re.compile(r"class of (20\d\d)", re.I)),
    ("class", re.compile(r"(20\d\d)\s+(?:college\s+)?grad(?:uate)?s\b", re.I)),
    ("class", re.compile(_GRAD + r"[\s,:/-]*\(?\s*(20\d\d)", re.I)),
    ("class", re.compile(r"(20\d\d)[\s,:/-]*" + _GRAD, re.I)),
    ("class", re.compile(r"graduat\w*\s+(?:in|by|between)?\s*(?:" + _MONTH_RE
                         + r"|" + _SEASON_RE + r")?\s*,?\s*(20\d\d)", re.I)),
    ("start", re.compile(r"start(?:ing|s)?\s+(?:date\s*:?\s*)?(?:in\s+)?(?:"
                         + _MONTH_RE + r"|" + _SEASON_RE + r")?\s*,?\s*(20\d\d)", re.I)),
    ("start", re.compile(r"(20\d\d)\s+start\b", re.I)),
]

# WEAK patterns are a bare month or season plus a year. A posting body says
# "Summer 2026" in boilerplate constantly, so these are read from the TITLE ONLY.
_WEAK = [
    re.compile(_MONTH_RE + r"\s+(20\d\d)", re.I),
    re.compile(_SEASON_RE + r"\s+(20\d\d)", re.I),
]

# Last resort, title only: a bare year with no month, season or grad word next to
# it. Checked AFTER everything above so a more specific pattern always wins.
#
# Needed because titles put the year where none of the shaped patterns reach it:
# "Full Time Analyst 2027" and "[2027] Software Engineer, Early Career" both
# extracted nothing and passed only because absent evidence fails open — which
# means "Full Time Analyst 2026" would have passed too. A year in a title this
# short is naming a class, so it is read as one.
_BARE_YEAR = re.compile(r"\b(20\d\d)\b")

# Internship-shaped titles are never a full-time new-grad role, whatever year
# they name. Word boundaries throughout: a bare substring "intern" deleted every
# *International* role the last time this pattern class was written.
_INTERNSHIP = re.compile(
    r"\b(summer analyst|summer associate|intern|interns|internship|internships"
    r"|co[- ]?op|externship|apprentice(?:ship)?)\b", re.I)

# From profile.json, through owner.py. Nothing in this file may name a year as
# a literal: the template was built for one person and carried their class year
# here, which is exactly the kind of thing that survives a copy and then quietly
# kills every role for the new owner's class.
GRAD_YEAR = OWNER["grad_year"]
GRAD_MONTH = OWNER["grad_month"]
GRAD_LABEL = f"{OWNER['grad_month_name']} {GRAD_YEAR}"   # "May 2027"


def _month_of(m):
    """First month-ish group in a match, as a number, or None."""
    for g in m.groups()[:-1]:
        if not g:
            continue
        k = g.lower()[:3]
        if k in _MONTHS:
            return _MONTHS[k]
        if g.lower() in _SEASONS:
            return _SEASONS[g.lower()]
    return None


def start_detail(title, description=""):
    """(start_year, start_month, class_year, matched phrase).

    Title wins over body. Only the strong patterns are ever read from the body.
    """
    title = title or ""
    body = (description or "")[:4000]

    for kind, pat in _STRONG:
        for text in (title, body):
            m = pat.search(text)
            if not m:
                continue
            year = int(m.group(m.lastindex))
            if not 2020 <= year <= 2035:
                continue
            phrase = re.sub(r"\s+", " ", m.group(0)).strip()
            if kind == "class":
                return None, None, year, phrase
            return year, _month_of(m), None, phrase

    for pat in _WEAK:
        m = pat.search(title)
        if not m:
            continue
        year = int(m.group(2))
        if not 2020 <= year <= 2035:
            continue
        return year, _month_of(m), None, re.sub(r"\s+", " ", m.group(0)).strip()

    m = _BARE_YEAR.search(title)
    if m:
        year = int(m.group(1))
        if 2024 <= year <= 2032:
            return None, None, year, m.group(0)

    return None, None, None, ""


def class_detail(title, description=""):
    """(verdict, reason, start_year, start_month, class_year, deciding phrase).

    Absent evidence is 'ok' — fail open. Every branch is arithmetic on a number
    already extracted, which is exactly the kind of decision that must not be
    handed to a model.

    The phrase returned is always the one that DECIDED the verdict. The internship
    rule runs first and has its own phrase; returning the year found elsewhere in
    the title would have made "Summer Analyst 2027" read as though it were killed
    for being the 2027 class, which is not why it was killed.
    """
    title = title or ""
    m = _INTERNSHIP.search(title)
    if m:
        return "wrong_year", "internship", None, None, None, m.group(0)

    sy, sm, cy, text = start_detail(title, description)

    if cy is not None:
        if cy == GRAD_YEAR:
            return "ok", "their class", None, None, cy, text
        return "wrong_year", "class of %d" % cy, None, None, cy, text
    if sy is None:
        return "ok", "no year stated", None, None, None, ""
    if sy < GRAD_YEAR:
        return "wrong_year", "starts %d" % sy, sy, sm, None, text
    if sy > GRAD_YEAR:
        return "wrong_year", "starts %d" % sy, sy, sm, None, text
    if sm is not None and sm < GRAD_MONTH:
        return "wrong_year", "starts before " + GRAD_LABEL, sy, sm, None, text
    return "ok", "starts %d" % sy, sy, sm, None, text


def class_fit(title, description=""):
    """'ok' or 'wrong_year'."""
    return class_detail(title, description)[0]


# --------------------------------------------------------------- compensation
#
# CA/NY/CO/WA pay-transparency laws mean most postings carry a range in the body.
# Ashby also returns structured compensation when asked.
#
# UNKNOWN IS NOT LOW. Never rank an unknown range below a known one; show it as
# unknown and let the reader decide.

_RANGE_RE = re.compile(
    r"\$\s?(\d{2,3})(?:,(\d{3}))?\s?([kK])?\s*(?:-|–|—|to)\s*"
    r"\$?\s?(\d{2,3})(?:,(\d{3}))?\s?([kK])?")
_SINGLE_RE = re.compile(
    r"\$\s?(\d{2,3}),(\d{3})\s*(?:per year|/\s?year|annually|USD)", re.I)
# Hourly rates and equity totals are not base salary; skip postings that only
# show those rather than reporting a nonsense range.
_HOURLY_RE = re.compile(r"\$\s?\d{1,3}(\.\d{2})?\s*(?:-|–|to)?\s*\$?\d{0,3}\s*(?:per hour|/\s?hour|hourly)", re.I)


def _money(whole, thousands, k_suffix):
    if thousands:
        return int(whole + thousands)
    n = int(whole)
    if k_suffix or n < 1000:
        return n * 1000
    return n


def extract_comp(description, structured=None):
    """(min, max, currency, source). source is 'structured' | 'parsed' | 'none'."""
    if structured:
        lo = structured.get("min")
        hi = structured.get("max")
        if lo:
            return int(lo), int(hi or lo), structured.get("currency", "USD"), "structured"

    d = description or ""
    m = _RANGE_RE.search(d)
    if m:
        lo = _money(m.group(1), m.group(2), m.group(3))
        hi = _money(m.group(4), m.group(5), m.group(6))
        if 30000 <= lo <= 1000000 and lo <= hi <= 2000000:
            return lo, hi, "USD", "parsed"
    m = _SINGLE_RE.search(d)
    if m:
        v = _money(m.group(1), m.group(2), None)
        if 30000 <= v <= 1000000:
            return v, v, "USD", "parsed"
    return None, None, None, "none"


# ----------------------------------------------------------------- validation

def _validate(n=10):
    # db(), not sqlite3.connect(): under Postgres the local jobs.db is a frozen
    # pre-migration snapshot, so a direct connect would validate the gate
    # against months-stale rows and look like it passed.
    from fetch_jobs import db
    con = db()
    rows = con.execute(
        "SELECT title, COALESCE(display_name, company) co, description, yoe "
        "FROM jobs WHERE candidate=1 AND closed_at IS NULL AND triage=1"
    ).fetchall()
    tagged = [(entry_level(r["title"], r["description"], r["yoe"]), r) for r in rows]

    print("ENTRY LEVEL over %d gated roles" % len(rows))
    for lvl in ENTRY_LEVELS:
        c = sum(1 for t, _ in tagged if t == lvl)
        print("   %-12s %4d (%.0f%%)" % (lvl, c, 100 * c / len(rows)))

    print("\n%d per class, with the deciding evidence:" % n)
    for lvl in ENTRY_LEVELS:
        print("\n--- %s ---" % lvl.upper())
        shown = 0
        for t, r in tagged:
            if t != lvl or shown >= n:
                continue
            shown += 1
            title = r["title"]
            if lvl == "program":
                m = PROGRAM_RE.search(title) or PROGRAM_RE.search((r["description"] or "")[:6000])
                ev = "%r%s" % (m.group(0) if m else "?", "" if PROGRAM_RE.search(title) else " (body)")
            elif lvl == "experienced":
                if SENIOR_TITLE_RE.search(title):
                    ev = "senior word %r" % SENIOR_TITLE_RE.search(title).group(0)
                elif FUNCTION_MANAGER_RE.search(title):
                    ev = "function manager %r" % FUNCTION_MANAGER_RE.search(title).group(0)
                elif r["yoe"] and r["yoe"] >= 2:
                    ev = "required %s yrs" % r["yoe"]
                else:
                    m = SOFT_YEARS_RE.search((r["description"] or "")[:6000])
                    ev = "body mentions %r" % (m.group(0) if m else "?")
            else:
                ev = "yoe=%s, no seniority signal" % (r["yoe"] if r["yoe"] is not None else "none")
            print("  %-18s %-50s %s" % (r["co"][:18], title[:50], ev[:44]))

    print("\n\nCOMPENSATION")
    got = [(extract_comp(r["description"]), r) for r in rows]
    have = [(c, r) for c, r in got if c[3] != "none"]
    print("   parsed a range for %d of %d (%.0f%%)" % (len(have), len(rows), 100 * len(have) / len(rows)))
    print("\n   %d samples, check each against the posting:" % n)
    for (lo, hi, cur, src), r in have[:n]:
        print("  %-18s %-46s $%s-$%s" % (r["co"][:18], r["title"][:46], f"{lo:,}", f"{hi:,}"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--n", type=int, default=10)
    a = ap.parse_args()
    if a.validate:
        _validate(n=a.n)
