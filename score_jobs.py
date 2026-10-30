#!/usr/bin/env python3
"""
score_jobs.py — score unscored candidate jobs against profile.json and rank them.

Usage:
  python score_jobs.py verify-models               # 1-token probe of each model ID
  python score_jobs.py gate [--reset]              # stage 1: deterministic gate
  python score_jobs.py kills [--gate G] [--group]  # every kill + the phrase that caused it
  python score_jobs.py score [--limit N] [--all]   # stage 2: score gate survivors
  python score_jobs.py rank [--min 60] [--n 25]    # print ranked open jobs
  python score_jobs.py show <key>                  # full assessment for one job

Two stages, and stage 1 uses no model at all:
  stage 1 `gate`  — deterministic. Kills only on a stated 3+ year requirement, a
           location outside the US with no US option, a senior-level title, or an
           explicit contract/temp/part-time statement. Nothing else.
  stage 2 `score` — full assessment against profile.json for everything that
           survives. Clearance and specialist-domain questions belong here, where
           the answer is a score with stated gaps rather than a silent deletion.

Every gate records the literal phrase that fired it (jobs.gate_text) and the field
it came from (jobs.gate_field), the same way yoe_text has always been stored. A
gate is a regex making a delete decision; the only defence against one firing on a
word used in a sense it never meant is to be able to read what it matched.
`kills --group` lists the distinct phrases, which is where a bad pattern shows up
as a high count attached to a wrong meaning.

There was an LLM triage stage between them. It was deleted: it bought roughly a
dollar of savings by permanently deleting roles the scorer never got to see,
including Palantir's Forward Deployed Software Engineer, New Grad posting.

Env:
  ANTHROPIC_API_KEY      required (loaded from .env)
  JOBOPS_MODEL           stage 2, default claude-haiku-4-5-20251001 (see MODEL)
  JOBOPS_TRIAGE_MODEL    stage 1, default claude-haiku-4-5-20251001

The profile goes in the system prompt with cache_control so you pay for it once per
cache window, not once per job.
"""
import argparse
import datetime as dt
import io
import json
import os
import re
import sqlite3
import sys
import textwrap
import time

import anthropic

from console import utf8_stdout
from fetch_jobs import db, funnel, now
from classify import (entry_level, extract_comp, comp_thresholds, ENTRY_LEVELS,
                      class_detail, GRAD_YEAR, GRAD_LABEL)
from owner import OWNER
from paths import repo

# Load ANTHROPIC_API_KEY (and JOBOPS_MODEL, if set) from .env so the key is
# available every session without exporting it by hand. Never print the value.
try:
    from dotenv import load_dotenv
except ImportError:

    def load_dotenv(*_args, **_kwargs):
        print(
            "warning: python-dotenv not installed; "
            "run pip install -r requirements.txt",
            file=sys.stderr,
        )


load_dotenv()

# Haiku, not Sonnet. CLAUDE.md has recorded Haiku as the validated scorer since
# 2026-08-25 — Spearman +0.82 against Sonnet, 9/10 top-10 overlap — while this
# line went on defaulting to Sonnet, roughly ten times the price. A run intended
# as $0.07 cost $1.19 on that gap alone.
#
# The rule and the default now say the same thing. A rule enforced only by a
# document is a rule waiting to be missed.
MODEL = os.environ.get("JOBOPS_MODEL", "claude-haiku-4-5-20251001")
SCORE_EFFORT = os.environ.get("JOBOPS_EFFORT", "high")
SCORE_SAMPLES = int(os.environ.get("JOBOPS_SAMPLES", "3"))
MAX_DESC_CHARS = 9000  # trim absurdly long postings; fit signal is in the first few thousand chars

# The candidate is named from profile.json, never here: a name in a prompt
# survives a copy of the repo and scores someone else's roles against it.
SYSTEM = f"""You are a rigorous recruiting screener working for ONE candidate, {OWNER['name']}, a
{OWNER['class_label']} graduating {GRAD_LABEL}. You are given the candidate's verified profile (below)
and one job posting. Your job is to estimate real fit and to say why, in a way the candidate can act on.

Rules:
- Only use the evidence in the profile. Never invent experience. If the posting wants something the
  candidate lacks, say so plainly in gaps.
- "score" is your calibrated probability (0-100) that a serious application plus a warm intro would
  reach a first-round interview. Be harsh: most postings for most candidates score under 40.
- Penalize hard: requires 3+ years, requires specific degree with no substitution, requires sponsorship
  the candidate can't use, location outside preferences with no remote.
- Reward: tier_1 target categories, new-grad / early-career framing, AI-native companies, roles where
  a shipped product with revenue is unusual and valuable, roles that read like the projects in the
  candidate's evidence.
- "angle" is the single strongest pitch for this specific role, one sentence, in the candidate's voice.
- "evidence_ids" lists which profile evidence items to lead with, most relevant first.
- CLEARANCE WORDING IS A HARD CONSTRAINT. Describe the candidate as "no current clearance, US citizen,
  willing to pursue one" and nothing stronger. NEVER write that they are "eligible", "clearance-eligible",
  "cleared", or that they "would be granted" anything. Eligibility is decided by a government adjudicator
  after an employer sponsors the process; it is not a fact about the candidate and asserting it is a
  false claim on a defense application. You may say what the POSTING requires and what the EMPLOYER
  sponsors. This applies to reasons, gaps and angle alike.

Respond with ONLY a JSON object, no markdown fences, no preamble:
{{"score": int, "tier": "apply"|"maybe"|"skip", "reasons": [str, ...], "gaps": [str, ...],
 "evidence_ids": [str, ...], "angle": str, "role_type": str, "seniority": str, "location_ok": bool}}

CANDIDATE PROFILE:
"""


# Pinned to the dated snapshot deliberately. Verified 2026-08-24: both
# "claude-haiku-4-5" and "claude-haiku-4-5-20251001" work, and the bare alias
# currently resolves to this same snapshot — but an alias can be repointed to a
# later model without notice, which would silently change scoring behaviour
# mid-pipeline. Pin the snapshot.
TRIAGE_MODEL = os.environ.get("JOBOPS_TRIAGE_MODEL", "claude-haiku-4-5-20251001")
# Greenhouse postings open with company boilerplate ("Who we are / About
# Stripe / Stripe is a financial infrastructure platform..."), so a 400-char
# window was largely spent before reaching anything about the role. 900 costs
# roughly $0.15 more per 1000 postings.
TRIAGE_CHARS = 900

# $ per million tokens. Batch API is 50% off both directions.
PRICES = {
    "claude-haiku-4-5":          (1.00, 5.00),
    "claude-haiku-4-5-20251001": (1.00, 5.00),
    "claude-sonnet-5":           (2.00, 10.00),  # intro pricing through 2026-08-31
    "claude-opus-5":             (5.00, 25.00),
}
BATCH_DISCOUNT = 0.5
def _monthly_cap():
    """The hard monthly spend cap, from config.yaml. ONE definition.

    This was `MONTHLY_CAP = 5.00`, hardcoded here, while web/lib/genconfig.mjs
    baked `cost.monthly_cap` out of config.yaml for the cost meter. Two
    spellings of one rule, and raising the cap in config.yaml would have moved
    the number the UI displays while this file went on refusing at the old one:
    the meter would read "$7.10 / $25.00" in black while `score` exited non-zero
    saying the month was capped. A rule enforced in two places is a rule that
    disagrees with itself the first time it changes.

    IT RAISES RATHER THAN DEFAULTING. A missing or unparseable cap must not
    quietly become a number nobody chose -- "a default that changes what a number
    MEANS is worse than a crash" is why the deployed cost meter once read
    $29.88 / $5.00 OVER CAP. The build fails on the same condition; so does this.
    """
    import yaml
    from paths import repo
    with io.open(repo("config.yaml"), encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    for block in (cfg.get("cost") or {}, cfg):
        if isinstance(block, dict) and block.get("monthly_cap") is not None:
            return float(block["monthly_cap"])
    raise RuntimeError(
        "config.yaml has no monthly_cap. Refusing to guess a spend cap.")


MONTHLY_CAP = _monthly_cap()

# Range form first ("2-3+ years") so the LOWER bound wins; a role asking for
# "2-3 years" has a floor of 2, and reading it as 3 wrongly disqualifies.
_YOE_RANGE = re.compile(
    r"(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s*\+?\s*years?(?:\s+of)?\s+(?:\w+\s+){0,3}?experience", re.I
)
_YOE = re.compile(
    r"(\d{1,2})\s*\+?\s*years?(?:\s+of)?\s+(?:\w+\s+){0,3}?experience", re.I
)
# "Preferred"/"nice to have" experience is not a requirement. Anthropic's PM
# posting lists 8+ years under *Preferred qualifications* and the first version
# of this killed it as though it were a hard minimum.
#
# Decide by the NEAREST preceding marker, not by any match in the window. Stripe
# writes "The preferred qualifications are a bonus, not a requirement." directly
# above "Minimum requirements", so "is there a preferred word nearby" wrongly
# suppressed a real 5-year minimum.
_PREFERRED = re.compile(
    r"(preferred|nice[ -]to[ -]have|bonus point|plus if|desirable|is a plus)", re.I
)
_REQUIRED = re.compile(
    # the generic terms need a lookbehind: "Preferred qualifications" contains
    # "qualifications", which would otherwise outrank the "preferred" marker it
    # belongs to purely by sitting later in the string.
    r"(minimum requirement|required qualification|basic qualification"
    r"|(?<!preferred )requirements|(?<!preferred )qualifications"
    r"|what you'll need|what we're looking for|must have)", re.I
)


def _is_required(desc, at):
    """True if the nearest section marker before `at` is a requirement marker."""
    back = desc[max(0, at - 600):at]
    p = [m.start() for m in _PREFERRED.finditer(back)]
    r = [m.start() for m in _REQUIRED.finditer(back)]
    if not p:
        return True
    if not r:
        return False
    return max(r) > max(p)  # whichever marker is closer to the match wins


YOE_CUTOFF = 3  # the owner's hard_no: roles requiring 3+ years


def yoe_detail(desc):
    """(lowest required years or None, the raw matched phrase or '').

    Lowest, because "3+ required, 5+ preferred" has a floor of 3. Required only,
    because a preferred qualification is not a disqualifier — the owner should
    still apply to a role whose wish list they don't fully meet.

    The matched phrase is returned and stored so a bad regex shows up in the data
    instead of silently killing roles.
    """
    if not desc:
        return None, ""
    found = []
    for pat in (_YOE_RANGE, _YOE):
        for m in pat.finditer(desc):
            n = int(m.group(1))
            if not 0 < n <= 20:
                continue
            if not _is_required(desc, m.start()):
                continue
            found.append((n, re.sub(r"\s+", " ", m.group(0)).strip()))
    if not found:
        return None, ""
    return min(found, key=lambda t: t[0])


def min_yoe(desc):
    return yoe_detail(desc)[0]


# Kills that claim a specialist domain must name one of these. Enforced in code,
# not left to the prompt: "specialist domain" as a free-form reason accounted for
# 17% of kills, including Product Security Engineer roles alongside Revenue
# Operations Analyst, which is really just bizops.
SPECIALIST_DOMAINS = (
    "mechanical", "structural", "gnc", "controls", " rf ", "asic", "fpga",
    "embedded", "firmware", "qa", "test", "manufactur", "production engineering",
    "ehs", "it support", "recruit", "sales quota", "quota", "security engineering",
)
_DOMAIN_CLAIM = re.compile(r"specialist|domain depth|deep domain|domain expertise", re.I)


_US_STATES = (
    "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii "
    "idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan "
    "minnesota mississippi missouri montana nebraska nevada ohio oklahoma oregon pennsylvania "
    "tennessee texas utah vermont virginia washington wisconsin wyoming"
).split() + ["new hampshire", "new jersey", "new mexico", "new york", "north carolina",
             "north dakota", "rhode island", "south carolina", "south dakota", "west virginia",
             "district of columbia"]
# KNOWN AND DELIBERATELY UNCHANGED: several of these are ordinary English words.
# With re.I, "in", "or", "me", "ok", "hi", "de", "la", "pa" and "co" all match
# prose — so "based in the U.S." registers as a US hint by matching INDIANA
# inside the word "in".
#
# That is wrong, and it is wrong in the direction that lets roles THROUGH: a
# spurious US hint means the gate declines to delete. It is also load-bearing by
# accident — it is most of why this gate almost never fired on a description.
#
# It is left alone on purpose. This list is now only ever read against the
# LOCATION field, where a bare "in" or "or" as a standalone token is vanishingly
# rare, and there is no evidence of a single wrong kill from it. Narrowing it
# would be retuning a classifier on a hypothesis, which is the thing this file
# keeps having to be talked out of. If it ever does need fixing, the fix is to
# require a comma or a state-shaped context, and it needs a full-corpus diff.
_US_ABBR = ("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv "
            "nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc").split()
_US_CITIES = ("san francisco|new york|new york city|nyc|los angeles|washington|seattle|boston|"
              "chicago|denver|atlanta|dallas|austin|san diego|irvine|costa mesa|el segundo|"
              "torrance|quincy|reston|herndon|huntsville|broomfield|long beach|santa ana|"
              "morrisville|hayward|virginia beach|colorado springs|huntington beach|jacksonville|"
              "philadelphia|pittsburgh|cleveland|sunnyvale|palo alto|mountain view|san jose|"
              "menlo park|redwood city|santa monica|culver city|bellevue|arlington|mclean|"
              "cambridge|somerville|salt lake city|phoenix|houston|miami|nashville|detroit|"
              "minneapolis|portland|st. louis|kansas city|baltimore|honolulu|anchorage|"
              "ann arbor|boulder|tampa|orlando|charlotte|raleigh|durham|columbus|indianapolis")
# IT ENDS IN (?!\w), NOT \b, AND THAT IS THE WHOLE POINT.
#
# `\b` needs a word/non-word TRANSITION. The `u\.s\.a?\.?` alternative ends in a
# literal period, which is already a non-word character — so a trailing `\b`
# demands that the next character be a word one, and in real prose it never is:
#
#   "across the U.S., Europe"   ->  no match     (period, then a comma)
#   "the U.S. and Canada"       ->  no match     (period, then a space)
#   "a U.S. citizen"            ->  no match
#   "U.S.-based"                ->  no match
#   "based in the U.S."         ->  matched "in" — INDIANA, inside the word "in"
#
# So the clearest US signal in the language was unreadable, and this gate deleted
# two roles in Wichita, Kansas out of a sentence reading "with offices across the
# U.S., Europe, the Middle East, and Asia-Pacific".
#
# This is the SECOND time this exact bug has shipped in this file: CLAUDE.md
# already records it for the clearance patterns — "'U.S.' contains periods, so
# 'an active U.S. government security clearance is required' matched nothing" —
# and it recurred forty lines away. A prose note cannot catch a regex that
# cannot match, so test_regex_boundaries.py catches it mechanically now.
#
# `(?!\w)` asks only that the match not run into a word character. For an
# alternative ending in a letter it behaves exactly as `\b` did; for one ending
# in a period it is the difference between working and not.
_US_HINT = re.compile(
    r"\b(united states|usa|usca|u\.s\.a?\.?|us|us[- ]remote|remote[- ,]+us\b|"
    r"north america|nyc|sf|atl|chi|sea|"
    + "|".join(_US_STATES) + "|" + "|".join(_US_ABBR) + "|" + _US_CITIES + r")(?!\w)", re.I)
_NONUS_HINT = re.compile(
    r"\b(uk|united kingdom|england|scotland|wales|london|portsmouth|bristol|manchester|"
    r"india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai|gurgaon|noida|"
    r"germany|munich|berlin|hamburg|france|paris|japan|tokyo|singapore|australia|sydney|"
    r"melbourne|canada|toronto|vancouver|montreal|ottawa|ireland|dublin|netherlands|"
    r"amsterdam|poland|warsaw|krakow|israel|tel aviv|brazil|sao paulo|mexico|"
    r"spain|madrid|barcelona|sweden|stockholm|switzerland|zurich|geneva|korea|seoul|"
    r"china|shanghai|beijing|taiwan|taipei|hong kong|emea|apac|latam|"
    r"united arab emirates|abu dhabi|dubai|qatar|doha|saudi|new zealand|auckland|"
    r"denmark|copenhagen|norway|oslo|finland|helsinki|austria|vienna|belgium|brussels|"
    r"portugal|lisbon|italy|rome|milan|czech|prague|romania|bucharest|turkey|istanbul|"
    r"south africa|nigeria|kenya|egypt|argentina|chile|colombia|peru|philippines|manila|"
    r"vietnam|hanoi|thailand|bangkok|indonesia|jakarta|malaysia|kuala lumpur|"
    r"costa rica|ukraine|kyiv|kiev|lviv|lithuania|vilnius|estonia|tallinn|latvia|riga|"
    r"stuttgart|cologne|frankfurt|dusseldorf|europe|uae|bulgaria|sofia|serbia|belgrade|"
    r"greece|athens|hungary|budapest|croatia|slovakia|slovenia)\b", re.I)

# Explicit employment-type statements only. A bare "contract" is not enough:
# "Contracts Manager" and "government contracts" are ordinary defense roles.
_TEMP = re.compile(
    r"\b(this is a (\d+[- ]month )?(contract|temporary|fixed[- ]term) (role|position)|"
    r"contract position|temporary position|fixed[- ]term contract|seasonal position|"
    r"part[- ]time (role|position)|\d+[- ]month contract|contract[- ]to[- ]hire|"
    r"temp[- ]to[- ]perm|co[- ]op (role|position|program))\b", re.I)


# Employment type stated as a TITLE TAG. The body pattern above demands a full
# sentence ("this is a 6-month contract role"), which no title ever writes, so
# "Data Analyst (Contract)" and "University Recruiter, Contract" were invisible —
# the same shape of bug as the clearance patterns that could not read a title.
#
# The anchoring is the whole point. Across 9,798 open postings, 112 titles
# mention contract/temp/seasonal/part-time, and they split cleanly:
#
#   a bracketed or trailing TAG      is the employment type
#     "(Contract)"  "[6 Month Contract]"  ", Contract"  "(Temp to Hire)"
#   the word MODIFYING another noun  is the subject matter, and must not match
#     "Contracts Manager"  "Contract Administrator"  "Smart Contract, Bridge"
#     "Government Contracts"  "Contract Manufacturing"  "Product Lead, Contractors"
#
# This gate deletes roles, so it stays narrow: fully bracketed, or the very last
# thing in the title. A bare "contract" anywhere in a title is never enough.
_TEMP_TITLE = re.compile(
    r"[(\[][^)\]]*\b(?:contract|contractor|temporary|temp to hire|temp to perm"
    r"|part[- ]time|seasonal|fixed[- ]term)\b[^)\]]*[)\]]"
    r"|[,–—-]\s*(?:contract|contractor|temporary|part[- ]time|seasonal"
    r"|fixed[- ]term contract)\s*$", re.I)


def outside_us_detail(location, desc=""):
    """(disqualified, matched phrase, which field matched).

    True only when nothing suggests a US option. Fails OPEN: an unrecognised
    place name passes rather than being deleted.

    The matched phrase is returned for the same reason `yoe_detail` returns one —
    a gate that deletes a role without recording the substring that decided it
    cannot be audited, and every gate in this file is one regex away from the
    class of false positive the years-of-experience matcher already demonstrated
    (a pattern that fires on a word used in a sense the gate never meant).

    THE LOCATION FIELD ONLY. There was a second branch: when the location field
    said nothing either way, it judged the first 600 characters of the posting's
    prose. Its own docstring called it the risky one and named the failure —
    "we have offices in London and New York" is a sentence about the COMPANY,
    not about where this role sits — and that is exactly how it failed.

    Swept over 9,840 open postings, it had fired TWICE, and both were wrong: two
    Shield AI engineering roles whose location field reads "Wichita Metro Area",
    deleted as outside the US on the strength of

      "With offices and facilities across the U.S., Europe, the Middle East,
       and Asia-Pacific, Shield AI's technology actively supports operations
       worldwide."

    It matched "Europe" out of a sentence whose subject is the U.S., about a
    role in Kansas. Nothing was actually lost — both rows fail the title filter
    first, and the branch has never killed a single candidate row — but that is
    luck, not design.

    Three other things the sweep showed, each enough on its own:

      - it could not read "U.S." at all (see the note on _US_HINT), so the one
        signal that would have saved these rows was invisible to it;
      - its verdict depends on WHERE the paragraph falls. Five Shield AI
        postings share that location and that boilerplate; two were killed and
        three were not, purely on whether the sentence landed inside the first
        600 characters;
      - the location branch, by contrast, is sound: 1,970 kills led by London
        (374), Dublin (128), Singapore (124), Tokyo (122), Bengaluru (113), and
        not one of them had a US signal in the same field.

    So it is deleted rather than repaired. A branch with 0% precision that has
    never contributed a correct kill is not carrying weight, and removing it
    retires the whole boilerplate-vs-fact class. This is "fail open" applied
    exactly: where the evidence is ambiguous the role passes through.

    `desc` is still accepted and now ignored — every caller passes it, and a
    signature change would ripple for no benefit.
    """
    blob = f"{location or ''}"
    if _US_HINT.search(blob):
        return False, "", ""
    m = _NONUS_HINT.search(blob)
    if m:
        return True, m.group(0), "location"
    return False, "", ""


def outside_us(location, desc=""):
    return outside_us_detail(location, desc)[0]


def temp_detail(title, desc):
    """(disqualified, matched phrase, which field matched)."""
    m = _TEMP_TITLE.search(title or "")
    if m:
        return True, m.group(0).strip(" ,-–—"), "title"
    m = _TEMP.search(title or "")
    if m:
        return True, m.group(0), "title"
    m = _TEMP.search((desc or "")[:4000])
    if m:
        return True, re.sub(r"\s+", " ", m.group(0)).strip(), "description"
    return False, "", ""


def is_temp_role(title, desc):
    return temp_detail(title, desc)[0]


def domain_claim_unsupported(reason):
    """True if a kill leans on 'specialist domain' without naming a listed one."""
    if not reason or not _DOMAIN_CLAIM.search(reason):
        return False
    low = reason.lower()
    return not any(d.strip() in low for d in SPECIALIST_DOMAINS)


def load_profile():
    with open(repo("profile.json"), encoding="utf-8") as f:
        return json.dumps(json.load(f), indent=1)


# Company boilerplate that postings open with. Skipping it buys back window for
# both stages; Greenhouse postings routinely spend 500+ chars on "About <co>".
_BOILERPLATE_END = re.compile(
    r"^\s*(about the role|the role|role overview|about this role|what you'll do"
    r"|what you will do|responsibilities|your impact|the opportunity"
    r"|position summary|job description|overview|about the (team|job)"
    r"|in this role)\b.*$",
    re.I | re.M,
)


def trim_posting(desc, limit):
    """Fit a posting into `limit` chars while keeping what actually matters.

    Postings lead with company boilerplate, so the head of a plain desc[:limit]
    is often worthless — skipping it buys back window at no cost.

    I also expected requirements to be truncated off the end, and built a
    head+tail split for it. Measured on 60 postings longer than the stage-2
    budget, the requirements section survived a plain prefix in 60/60 and the
    split made it 59/60. The concern was theoretical, so the split is gone.
    Re-measure before adding it back.
    """
    if not desc:
        return ""
    m = _BOILERPLATE_END.search(desc[:2500])
    if m and m.start() > 120:
        desc = desc[m.start():]
    return desc[:limit]


# Measured token means for this corpus, per stage. ONE definition: the cost
# meter, the pre-flight estimate and the cap guard all read these, so a run
# cannot be estimated on different arithmetic from the one that reports it.
SHAPE = {"triage": (1080, 30), "score": (4100, 455)}
EST_IN_TOK, EST_OUT_TOK = SHAPE["score"]


def _cap_reset():
    """When the current cap window opened.

    THE CAP IS PER MONTH AND THIS USED TO NEVER RESET. It returned the fixed
    `cap_reset` date from config.yaml and summed everything after it, forever —
    so on 1 September the meter was still counting August, and the web side
    showed the same running total under a label reading "this month".

    The window is the LATER of the configured reset and the first of the current
    month, in the owner's timezone. That keeps what the reset was for — excluding
    the $29.88 of pre-cap history — while making a monthly cap actually monthly.

    IT MUST MATCH web/lib/day.js capWindowStart() EXACTLY. This number decides
    whether scoring is allowed to run and the web meter decides whether the owner
    believes it can; two windows would mean the tool refusing to spend while the
    screen says there is room, or the reverse.
    """
    import re as _re
    from datetime import datetime
    from zoneinfo import ZoneInfo

    reset = "1970-01-01"
    try:
        with open(repo("config.yaml"), encoding="utf-8") as f:
            m = _re.search(r"cap_reset:\s*'?([0-9T:+\-]{10,})'?", f.read())
        if m:
            reset = m.group(1)
    except OSError:
        pass

    today = datetime.now(ZoneInfo("America/Los_Angeles"))
    month_start = "%04d-%02d-01T00:00:00+00:00" % (today.year, today.month)
    return reset if reset > month_start else month_start


def batch_cost(b):
    """Cost of one batch. MEASURED if the usage is stored, estimated if not.

    Returns (dollars, measured?) so callers can say which they are showing.
    A number that is structurally low and presented as exact is worse than one
    labelled as a floor.
    """
    if b["in_tok"] is not None:
        return price(b["model"], b["in_tok"], b["out_tok"] or 0,
                     b["cache_w_tok"] or 0, b["cache_r_tok"] or 0,
                     batch=True), True
    tin, tout = SHAPE.get(b["stage"], (2000, 300))
    return est_cost(b["model"], b["n"], tin, tout, batch=True), False


def _spend_since_reset(con):
    """Spend inside the current cap window. Returns (dollars, all_measured?).

    Shared with cmd_cost so the number in the header, the number in the
    pre-flight estimate and the number the cap is enforced against are the same
    number, computed once.
    """
    since = _cap_reset()
    total = 0.0
    every = True
    for b in con.execute(
            "SELECT stage, model, n, submitted_at, in_tok, out_tok,"
            " cache_w_tok, cache_r_tok FROM batches").fetchall():
        if (b["submitted_at"] or "") < since:
            continue
        c, measured = batch_cost(b)
        total += c
        every = every and measured
    return total, every


# Anthropic's cache multipliers against the model's base input rate. Leaving
# these out is what made the meter read $0.78 against a real $1.19 — 35% low —
# because the profile in the system prompt is written to cache once and read back
# on every request after that, and neither was priced at all.
CACHE_WRITE_MULT = 1.25
CACHE_READ_MULT = 0.10


def price(model, in_tok, out_tok, cache_w=0, cache_r=0, batch=True):
    """Dollars for a given token usage. The one pricing function.

    Takes raw token counts rather than a per-call mean, so it can price a real
    usage object from the API exactly as easily as an estimate.
    """
    pin, pout = PRICES.get(model, (3.00, 15.00))
    mult = BATCH_DISCOUNT if batch else 1.0
    return (in_tok / 1e6 * pin
            + out_tok / 1e6 * pout
            + cache_w / 1e6 * pin * CACHE_WRITE_MULT
            + cache_r / 1e6 * pin * CACHE_READ_MULT) * mult


def build_score_requests(rows, system_text, remodel=False):
    """The batch payload. THE ONLY PLACE requests are constructed.

    Extracted so the estimate and the submission cannot disagree: the pre-flight
    figures are computed by counting what this returns, not by describing what
    it is believed to do. That gap priced 20 roles for a run that sent 60
    requests — the third estimate in a row that was wrong for the same reason.

    N independent samples per role. One sample is noise at the observed
    run-to-run variance; the median is the number, and the spread is a signal in
    its own right.
    """
    reqs, keymap = [], {}
    for i, job in enumerate(rows):
        for k in range(SCORE_SAMPLES):
            cid = f"s{i:06d}r{k}"
            # offset run_idx so a re-model never overwrites the previous model's runs
            keymap[cid] = [job["key"], k + (100 if remodel else 0)]
            reqs.append(_score_request(cid, system_text, dict(job)))
    return reqs, keymap


def estimate_requests(model, reqs, system_text, batch=True):
    """Price the ACTUAL requests. Returns (dollars, detail dict).

    The system prompt carries cache_control, so it is written to cache once and
    read on every subsequent request rather than charged as fresh input each
    time. Pricing it as full input on all N would overstate; ignoring it
    understates. Both were wrong here at different times.
    """
    sys_tok = len(system_text) / 4
    body_tok = sum(len(r["params"]["messages"][0]["content"])
                   for r in reqs) / 4
    n = len(reqs)
    cache_w = sys_tok                      # written once
    cache_r = sys_tok * max(0, n - 1)      # read by the rest
    out_tok = EST_OUT_TOK * n
    dollars = price(model, body_tok, out_tok, cache_w, cache_r, batch=batch)
    return dollars, {
        "requests": n,
        "input_tokens": int(body_tok),
        "output_tokens": int(out_tok),
        "cache_write": int(cache_w),
        "cache_read": int(cache_r),
    }


def est_cost(model, n, in_tok, out_tok, batch=True):
    """Rule 5: print a cost estimate before spending anything."""
    pin, pout = PRICES.get(model, (3.00, 15.00))
    mult = BATCH_DISCOUNT if batch else 1.0
    return ((n * in_tok / 1e6) * pin + (n * out_tok / 1e6) * pout) * mult


def cmd_cost():
    """Spend to date, reconstructed from the batch records.

    Approximate by design: it prices the stored request count against the model's
    published rates and the observed mean token sizes, since the Batches API does
    not hand back per-batch usage after collection. Good enough to answer "are we
    spending pennies or dollars", which is the only question it needs to answer.
    """
    con = db()
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT * FROM batches ORDER BY submitted_at, batch_id").fetchall()
    if not rows:
        print("No batches recorded.")
        return
    # SHAPE, _cap_reset and _spend_since_reset are module-level and shared with
    # the pre-flight estimate in cmd_score.
    print("%-13s %-28s %6s  %-10s %s" % ("STAGE", "MODEL", "CALLS", "EST COST", "WHEN"))
    print("-" * 84)
    total = 0.0
    by_stage = {}
    for b in rows:
        c, measured = batch_cost(b)
        total += c
        by_stage[b["stage"]] = by_stage.get(b["stage"], 0.0) + c
        print("%-13s %-28s %6d  %s%-8.2f %s" % (
            b["stage"], b["model"][:28], b["n"],
            "$" if measured else "~$", c, (b["submitted_at"] or "")[:16]))
    print("-" * 84)
    for k, v in sorted(by_stage.items(), key=lambda kv: (-kv[1], kv[0])):
        print("  %-13s $%.2f" % (k, v))
    measured_n = sum(1 for b in rows if b["in_tok"] is not None)
    print("\n  TOTAL  %s%.2f   across %d batches (%d measured, %d estimated)"
          % ("$" if measured_n == len(rows) else "~$", total, len(rows),
             measured_n, len(rows) - measured_n))

    # Against the hard cap, counted from config.yaml's cap_reset. Spend before
    # the reset is history, not a live overage.
    since = _cap_reset()
    hist = 0.0
    for b in rows:
        if (b["submitted_at"] or "") < since:
            tin, tout = SHAPE.get(b["stage"], (2000, 300))
            hist += est_cost(b["model"], b["n"], tin, tout, batch=True)
    mtd, mtd_measured = _spend_since_reset(con)
    bar = int(min(1.0, mtd / MONTHLY_CAP) * 30)
    # Says which window, because the window moved: it is the month unless the
    # reset falls inside it.
    _label = "THIS MONTH" if since.endswith("-01T00:00:00+00:00") else "SINCE CAP RESET"
    print("\n  %s (from %s)" % (_label, since[:16]))
    print("    %s%.2f / $%.2f  [%s%s]"
          % ("$" if mtd_measured else "~$", mtd, MONTHLY_CAP,
             "#" * bar, "." * (30 - bar)))
    if not mtd_measured:
        print("    ~ means a FLOOR: some batches have no measured usage stored,")
        print("      so they are priced from mean token shapes and read low.")
        print("      Run `collect` to record usage, or accept it as a minimum.")
    print("    $%.2f before the reset (history, not an overage)" % hist)
    if mtd >= MONTHLY_CAP:
        print("    OVER THE CAP — do not run further scoring this month.")
    print("\n  Steady state should be pennies a day: a daily fetch is free, and only"
          "\n  newly-posted roles get scored. Re-scoring everything is not routine.")


def cmd_verify_models(candidates):
    """One 1-token call per candidate ID. Model IDs are cheap to test and
    expensive to guess wrong three thousand postings into a run.
    """
    client = anthropic.Anthropic()
    for mid in candidates:
        try:
            r = client.messages.create(
                model=mid, max_tokens=1,
                messages=[{"role": "user", "content": "hi"}],
            )
            print(f"  OK    {mid:32s} (served by {r.model})")
        except Exception as e:  # noqa: BLE001
            print(f"  FAIL  {mid:32s} {type(e).__name__}: {str(e)[:90]}")



def _score_user(job):
    desc = trim_posting(job["description"], MAX_DESC_CHARS)
    y = job.get("yoe")
    # A 2-year role survived triage; that is not the same as having no gap.
    # Tell the scorer so it lands in `gaps` instead of disappearing.
    exp = (f"{y}+ years (candidate is a {GRAD_LABEL} new grad — treat as a stretch "
           f"and say so in gaps)" if y else "not stated")
    # Classified deterministically. "Active clearance required" and "will sponsor"
    # are opposite situations; treating them alike inflated the clearance gap.
    # Classified deterministically, and worded to the CLAUDE.md constraint.
    #
    # Every one of these describes the POSTING or the EMPLOYER. The only thing
    # said about the owner is the approved sentence — no current clearance, US
    # citizen, willing to pursue one — because eligibility is an adjudicator's
    # determination and not a fact this pipeline holds. The previous
    # eligibility_only text said "no known disqualifying factors", which is true
    # and is in profile.json, but next to the word "eligibility" it read as an
    # invitation: a scored role came back with the gap "though you're eligible
    # and willing, which Palantir explicitly accepts". Nothing in the prompt had
    # told the model not to.
    first = OWNER["first_name"]
    clr = {
        "required_active": f"THE POSTING REQUIRES AN ACTIVE CLEARANCE AT HIRE. {first} has no "
                           "current clearance and one cannot be obtained without an employer "
                           "sponsoring the process, so this is a hard disqualifier — score it "
                           "near zero and say so.",
        "sponsorable": "The employer sponsors the clearance. This is NOT a gap. Do not "
                       "list clearance in gaps.",
        "eligibility_only": "The posting asks only that the clearance can be pursued, which the "
                            f"employer initiates after an offer. {first} has no current clearance, "
                            "is a US citizen, and is willing to pursue one. Treat this as a minor "
                            "timing note, NOT a gap, and do not describe them as eligible.",
        "none_mentioned": "No clearance requirement mentioned.",
    }.get(job.get("clearance_status") or "none_mentioned", "unknown")
    user = textwrap.dedent(f"""
        COMPANY: {job['company']}
        TITLE: {job['title']}
        LOCATION: {job['location']}
        URL: {job['url']}
        STATED EXPERIENCE REQUIREMENT: {exp}
        CLEARANCE SITUATION: {clr}

        POSTING:
        {desc}
    """).strip()

    return user


def score_one(client, system_text, job):
    kw = {"output_config": {"effort": SCORE_EFFORT}} if _supports_effort(MODEL) else {}
    resp = client.messages.create(
        model=MODEL,
        max_tokens=3000,
        **kw,
        system=[{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": _score_user(job)}],
    )
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
    text = text.replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(text), text
    except json.JSONDecodeError:
        return None, text


# ---------- stage 1: deterministic gate ----------
# There is no LLM triage stage. There was, and it cost correctness to save about
# a dollar: it deleted Palantir's Forward Deployed Software Engineer, New Grad
# role, invented "likely manages team" for individual-contributor postings, and
# called Jacksonville, FL non-US. A binary delete decision should not be
# delegated to a model when a scored ranking is available instead. Everything a
# gate can decide deterministically it decides here; everything else — clearance,
# specialist domains, real fit — goes to stage 2, where a bad call produces a
# score of 20 at the bottom of the list rather than a silent deletion.

GATES = ("experience", "location", "level", "contract")


def _comp_from_raw(raw):
    """Ashby's structured summary, e.g. "$211.4K - $290.6K"."""
    if not raw:
        return None
    import re as _re
    m = _re.findall(r"\$\s?([\d.]+)\s?([KkMm])?", str(raw))
    if not m:
        return None
    def val(n, suf):
        f = float(n)
        if suf and suf.lower() == "k":
            f *= 1000
        elif suf and suf.lower() == "m":
            f *= 1000000
        return int(f)
    nums = [val(n, s) for n, s in m if val(n, s) >= 30000]
    if not nums:
        return None
    return {"min": min(nums), "max": max(nums), "currency": "USD"}

# Defense first. The owner ranked product first, but 12 of the 13 roles scoring
# 60+ are defense, and the recurring blocker on the stretch list is a
# degree-field or language-stack screen — exactly what a referral routes
# around. Observed fit outranks stated preference.
CATEGORY_ORDER = ("defense", "product", "consulting", "vc")
_VC_RE = re.compile(r"\b(venture|investment (analyst|associate)|portfolio|growth equity|"
                    r"private equity|fund)\b", re.I)
_CONSULT_RE = re.compile(r"\b(consultant|consulting|business analyst|strategy & operations|"
                         r"strategic initiatives|corporate strategy)\b", re.I)

# "now" vs a programme for the owner's class matters more than score right now:
# the owner graduates at GRAD_LABEL, so a role open today will be filled long
# before they can start it.
#
# BUILT FROM THE CLASS YEAR, not written as one. The year the owner graduates,
# and the two after it for "class of"; the year before it for "now".
_GY = GRAD_YEAR
_CLASS_YEARS = "|".join(str(_GY + i) for i in range(3))          # 2027|2028|2029
_PROGRAM_RE = re.compile(r"\b(%d|class of (?:%s)|new grad|new graduate|university grad|"
                         r"campus|early career|rotational|graduate program|"
                         r"summer %d|start(ing)? (in )?(summer |fall )?%d)\b"
                         % (_GY, _CLASS_YEARS, _GY, _GY), re.I)
_NOW_RE = re.compile(r"\b(immediate(ly)?|as soon as possible|start date: (%d|asap)|"
                     r"%d start|urgently)\b" % (_GY - 1, _GY - 1), re.I)
# The label the gate writes into jobs.start_window for a role dated for the
# owner's class. web/lib/genconfig.mjs bakes the same string from profile.json
# for the app; the two must agree or every count of "2027 program" is zero.
PROGRAM_WINDOW = f"{_GY} program"


# "Active clearance required" and "will sponsor" are OPPOSITE situations that the
# pipeline used to treat identically. The owner holds no clearance and cannot
# obtain one without a sponsor, so the first is a hard no and the second is not a
# gap at all. Conflating them inflated the clearance gap figure.
CLEARANCE_STATES = ("required_active", "sponsorable", "eligibility_only", "none_mentioned")

# Only count clearance words in a security context. Ops roles that *administer*
# clearances ("credentialing and medical clearance", "manage security clearances")
# talk about them constantly without requiring one.
_CLR_WORD = re.compile(r"(security clearance|clearance|ts/sci|top secret|\bsecret\b|polygraph)", re.I)
_CLR_NOISE = re.compile(
    r"(medical clearance|credential|incident report|medical record|"
    r"manage[a-z]* (highly )?sensitive|predeployment|deployers)", re.I)

def _win(n):
    """Up to n characters that do not cross a sentence boundary.

    These patterns used a plain [^.]{0,40} to stay inside one sentence, and that
    breaks on "U.S." — which appears in almost every defense posting. "an active
    U.S. government security clearance is required" matched nothing, because the
    periods in the abbreviation looked like the end of the sentence.

    A sentence boundary is a period followed by whitespace where the period is
    NOT preceded by a single capital letter. That last clause is what separates
    "U.S. government" and "Washington, D.C. area" — where the period-space sits
    inside an abbreviation — from "...is required. The position...", which really
    does end a sentence.

    Newlines ARE crossed, deliberately. These requirements are written as bullet
    lists — "Must have:" then a line break then "At least an active Top Secret
    clearance." — so refusing to cross a line break loses eleven Scale AI roles
    that state the requirement perfectly plainly.
    """
    return r"(?:(?!(?<![A-Z])\.\s)[\s\S]){0,%d}" % n


_CLR_ACTIVE = re.compile(
    r"(?:(?:must|shall) (?:currently )?(?:hold|have|possess)" + _win(60) + r"clearance"
    r"|(?:active|current)" + _win(40) + r"clearance" + _win(30) + r"(?:is |are )?required"
    r"|requires? an (?:active|current)" + _win(40) + r"clearance"
    r"|active (?:ts/sci|top secret|secret)" + _win(30) + r"required"
    r"|must (?:currently )?(?:be|hold)" + _win(20) + r"cleared)", re.I)
_CLR_SPONSOR = re.compile(
    r"(will sponsor|we sponsor|sponsors? (a |the )?(security )?clearance"
    r"|clearance sponsorship|sponsor(ship)? (is )?(available|provided))", re.I)
# "eligible FOR a clearance" is the single most common way a defense posting
# offers the door the owner can actually walk through, and this missed it: it had
# "eligibilit[a-z]* (for|to)", which matches "eligibility for" but not
# "eligible for" — different stem. Applied Intuition writes "Must hold or be
# eligible for a U.S. Secret security clearance" on an entry-level Defense
# Physical AI role, and it was about to be deleted as clearance-required.
_CLR_ELIGIBLE = re.compile(
    r"(abilit[a-z]* to obtain|able to obtain|eligible\s+(?:for|to)\b"
    r"|eligibilit[a-z]* (for|to)|must be eligible|obtain and maintain"
    r"|willing(ness)? to (obtain|undergo))", re.I)
# "preferred"/"a plus" downgrades an otherwise-active phrasing to not-required.
_CLR_SOFT = re.compile(
    r"(preferred|a plus|plus\b|strongly encouraged|nice to have|bonus|desirable"
    r"|helpful|not required|but not|though most do not|if applicable"
    r"|may be required|depending on)", re.I)


# A TITLE that states a clearance requirement is the least ambiguous signal a
# posting can carry, and none of the sentence-shaped body patterns above reach
# it. "Forward Deployed Engineer - Oahu (TS/SCI Clearance Required)" was landing
# as none_mentioned — the body patterns all want the word "active" or "current"
# next to "clearance", and the title says neither. Defense boards label these in
# the title precisely so a human does not waste an application.
_CLR_TITLE = re.compile(
    r"(clearance required|required clearance|requires? clearance"
    r"|active clearance|active ts/sci|ts/sci required|ts/sci clearance"
    r"|\bts clearance\b|top secret clearance|secret clearance"
    r"|clearance\s*[-:]\s*(ts|top secret|secret))", re.I)


def clearance_status(title, description):
    """Which of the four clearance situations a posting describes.

    Softeners and eligibility alternatives are checked in a window around the
    active-clearance phrase, NOT document-wide. Two real postings forced this:
    Anduril writes "an active security clearance is helpful but not required"
    (softened, so not a hard requirement), while Databricks writes "government
    secret clearance is required" in a document that mentions "ability to obtain"
    somewhere else entirely (still a hard requirement). A document-wide test got
    both backwards.
    """
    text = f"{title or ''}\n{description or ''}"
    hits = [m for m in _CLR_WORD.finditer(text)
            if not _CLR_NOISE.search(text[max(0, m.start() - 120):m.end() + 120])]
    if not hits:
        return "none_mentioned"
    if _CLR_SPONSOR.search(text):
        return "sponsorable"
    # Title first, and only when the title itself does not soften it: a title
    # saying "Clearance Eligible" or "clearance preferred" is not a requirement.
    tm = _CLR_TITLE.search(title or "")
    if tm and not _CLR_SOFT.search(title or "") and not _CLR_ELIGIBLE.search(title or ""):
        return "required_active"
    for m in _CLR_ACTIVE.finditer(text):
        window = text[max(0, m.start() - 130):m.end() + 130]
        if _CLR_SOFT.search(window) or _CLR_ELIGIBLE.search(window):
            continue  # "preferred", "helpful but not required", "or able to obtain"
        return "required_active"
    if _CLR_ELIGIBLE.search(text):
        return "eligibility_only"
    return "none_mentioned"


def classify(title, description, company, defense_slugs):
    title = title or ""
    cat = "product"
    if company in defense_slugs:
        cat = "defense"
    elif _VC_RE.search(title):
        cat = "vc"
    elif _CONSULT_RE.search(title):
        cat = "consulting"

    blob = f"{title}\n{(description or '')[:4000]}"
    if _PROGRAM_RE.search(title) or _PROGRAM_RE.search(blob):
        win = PROGRAM_WINDOW
    elif _NOW_RE.search(blob):
        win = "now"
    else:
        win = "unknown"
    return cat, win


def _source_of(job):
    """`job`'s source, whatever row type it is, and None when absent.

    Callers hand this function a sqlite3.Row, a pgdb row and a plain dict in
    different places. A Row raises IndexError on a column the SELECT did not
    include, and a guard that raises on some callers is worse than no guard.
    """
    try:
        return job["source"]
    except (KeyError, IndexError, TypeError):
        return None


def gate_verdict(job, senior_terms, protect_terms=()):
    """(gate_name, reason, matched phrase, matched field), or four falsy values.

    Every branch reports the literal substring that decided the kill and the
    field it came from. Nothing here may delete a role on evidence it cannot
    quote back — see `outside_us_detail` for why.
    """
    # MANUAL ENTRIES BYPASS EVERY GATE.
    #
    # A polled row is one of ten thousand a board handed over, and the gates
    # exist to stop the owner reading all of them. A source='manual' row is the
    # opposite: they typed it in themselves, on purpose, because the company does
    # not publish to any board this tool can poll. The gates have no information
    # they do not already have, and they are pattern matches over prose the
    # owner wrote — so their only possible effect is to delete something the
    # owner asked for.
    #
    # It is not hypothetical. Truist's own row passes today, but four plausible
    # manual descriptions are killed by four different gates:
    #
    #   "a 12 month fixed-term contract rotational programme"  -> contract
    #   "requires 8+ years ... for the senior track"           -> experience
    #   "Senior Product Manager, Rotational"                   -> level
    #   a non-US office listed first                           -> location
    #
    # Every one is a thing a real note about a real programme might say, and the
    # kill would be silent — the row would simply never appear in Inbox.
    #
    # Here rather than in cmd_gate because CLAUDE.md's rule is that the guard
    # sits in the code path that ACTS, not in the caller. A second caller added
    # later cannot forget it.
    if _source_of(job) == "manual":
        return None, None, None, None

    y, ytext = yoe_detail(job["description"])
    if y is not None and y >= YOE_CUTOFF:
        return "experience", f"requires {y}+ years", ytext, "description"
    bad, phrase, field = outside_us_detail(job["location"], job["description"])
    if bad:
        return "location", f"no US option ({job['location']!r})", phrase, field
    # protect_terms must be honoured here exactly as in title_ok: "Chief of
    # Staff" is a tier-1 target and contains "staff". Forgetting this killed one.
    hit = _matched_term(job["title"], senior_terms)
    if hit and not _matched_term(job["title"], protect_terms):
        return "level", "senior-level title", hit, "title"
    bad, phrase, field = temp_detail(job["title"], job["description"])
    if bad:
        return "contract", "contract, temp, seasonal, or part-time", phrase, field
    return None, None, None, None


def _matched_term(text, terms):
    """The first term in `terms` that matches `text`, or '' — the term itself,
    not just True, so the level gate can record what fired."""
    from fetch_jobs import _TERM_CACHE, _term_re
    low = (text or "").lower()
    for term in terms or ():
        t = term.lower()
        if t not in _TERM_CACHE:
            _TERM_CACHE[t] = _term_re(t)
        if _TERM_CACHE[t].search(low):
            return term
    return ""


def _matches_any(text, terms):
    return bool(_matched_term(text, terms))


# The columns cmd_gate writes, in the order its UPDATEs set them. Kept as
# constants because the SELECT, the comparison and the UPDATE must agree; three
# hand-maintained lists would drift.
_GATE_CLASS_COLS = [
    "yoe", "yoe_text", "category", "start_window", "clearance_status",
    "entry_level", "comp_min", "comp_max", "comp_currency", "comp_source",
    "class_fit", "class_reason", "class_text", "start_year", "start_month",
    "class_year",
]
_GATE_VERDICT_COLS = [
    "triage", "triage_reason", "gate_name", "gate_text", "gate_field",
]

# Rows per commit. The gate writes far fewer rows than the fetch, so this is
# about bounding what a kill loses, not about round trips.
GATE_BATCH = 200


def _norm(v):
    """Compare a stored value against a freshly computed one.

    The two arrive by different routes — one through the driver, one out of a
    classifier — so 1 and "1" and Decimal("1") all turn up meaning the same
    thing. Without this the comparison reports every row as changed and the
    skip does nothing at all, which is the failure mode that looks like success.
    """
    if v is None:
        return None
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v) if v.is_integer() else v
    try:                                   # Decimal, from some drivers
        f = float(v)
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        return str(v)


def _changed(row, cols, new):
    """True if any of `cols` on `row` differs from the matching value in `new`."""
    return any(_norm(row[c]) != _norm(v) for c, v in zip(cols, new))


def cmd_gate(reset):
    import yaml
    con = db()
    con.row_factory = sqlite3.Row
    with open(repo("companies.yaml"), encoding="utf-8") as f:
        _cfg = yaml.safe_load(f)
    senior_terms = _cfg.get("title_senior", [])
    protect_terms = _cfg.get("title_protect", [])
    defense_slugs = {e["slug"] for k, v in _cfg.items()
                     if k.startswith("defense_") and isinstance(v, list) for e in v}
    defense_slugs.add("palantir")

    if reset:
        con.execute("UPDATE jobs SET triage=NULL, triage_reason=NULL, triaged_at=NULL")
        con.commit()

    # The stored verdict columns come back with the inputs, so each row can be
    # compared against what the gate is about to write and skipped when nothing
    # moved. See the write loop below for why that matters.
    rows = con.execute(
        "SELECT key, source, company, title, location, description, comp_raw,"
        " " + ", ".join(_GATE_CLASS_COLS + _GATE_VERDICT_COLS) + " FROM jobs "
        "WHERE closed_at IS NULL AND candidate=1"
    ).fetchall()

    # Compensation must be extracted for the WHOLE set before any level is
    # decided, because the seniority threshold is per-company and relative.
    comps = {}
    for j in rows:
        comps[j["key"]] = extract_comp(j["description"], _comp_from_raw(j["comp_raw"]))
    floors = comp_thresholds(
        [{"company": j["company"], "comp_min": comps[j["key"]][0]} for j in rows])
    ts = now()
    killed = {g: [] for g in GATES}
    survivors = 0
    # WRITE ONLY WHAT MOVED.
    #
    # The gate must READ all ~1,560 candidates — the seniority threshold is
    # per-company and relative, so it cannot judge one role without the set. It
    # does not have to WRITE them. It used to issue two UPDATEs per row every
    # run, ~3,100 round trips, and against Neon that was nine minutes of
    # overwriting values with themselves. Gate verdicts are deterministic: with
    # unchanged inputs the output is bit-identical, so on a normal day almost
    # every one of those writes was a no-op that still cost a round trip.
    #
    # triaged_at is deliberately NOT part of the comparison. It moves every run
    # by definition, so including it would mark every row as changed and the
    # skip would quietly do nothing — passing tests, same nine minutes.
    n_class = n_verdict = 0
    pending = 0

    def maybe_commit(force=False):
        nonlocal pending
        if pending and (force or pending >= GATE_BATCH):
            con.commit()
            pending = 0

    for j in rows:
        y, ytext = yoe_detail(j["description"])
        cat, win = classify(j["title"], j["description"], j["company"], defense_slugs)
        clr = clearance_status(j["title"], j["description"])
        lo, hi, cur, csrc = comps[j["key"]]
        lvl = entry_level(j["title"], j["description"], y, lo, floors.get(j["company"]))
        cfit, creason, syr, smon, cyr, ctext = class_detail(j["title"], j["description"])
        new_class = (y, ytext, cat, win, clr, lvl, lo, hi, cur, csrc,
                     cfit, creason, ctext, syr, smon, cyr)
        if _changed(j, _GATE_CLASS_COLS, new_class):
            n_class += 1
            pending += 1
            con.execute(
                "UPDATE jobs SET yoe=?, yoe_text=?, category=?, start_window=?, "
                "clearance_status=?, entry_level=?, comp_min=?, comp_max=?, "
                "comp_currency=?, comp_source=?, class_fit=?, class_reason=?, "
                "class_text=?, start_year=?, start_month=?, class_year=? WHERE key=?",
                new_class + (j["key"],))
        g, reason, phrase, field = gate_verdict(j, senior_terms, protect_terms)
        if g:
            killed[g].append((j, phrase, field))
            new_verdict = (0, f"gate/{g}: {reason} [{phrase}]", g, phrase, field)
            if not _changed(j, _GATE_VERDICT_COLS, new_verdict):
                maybe_commit()
                continue
            n_verdict += 1
            pending += 1
            con.execute(
                "UPDATE jobs SET triage=0, triage_reason=?, triaged_at=?, "
                "gate_name=?, gate_text=?, gate_field=? WHERE key=?",
                (f"gate/{g}: {reason} [{phrase}]", ts, g, phrase, field, j["key"]))
        else:
            survivors += 1
            # Clear any stale gate columns: a role that passes today must not
            # carry the phrase that killed it under an earlier version of the
            # gate, or the kill list will show ghosts.
            if not _changed(j, _GATE_VERDICT_COLS,
                            (1, "gate: passed all deterministic gates",
                             None, None, None)):
                maybe_commit()
                continue
            n_verdict += 1
            pending += 1
            con.execute(
                "UPDATE jobs SET triage=1, triage_reason=?, triaged_at=?, "
                "gate_name=NULL, gate_text=NULL, gate_field=NULL WHERE key=?",
                ("gate: passed all deterministic gates", ts, j["key"]))
        maybe_commit()
    maybe_commit(force=True)

    total = con.execute("SELECT COUNT(*) FROM jobs WHERE closed_at IS NULL").fetchone()[0]
    print("Deterministic gate over %d candidates (%d total open)\n" % (len(rows), total))
    print("  %-12s %7s   %s" % ("GATE", "KILLED", "EXAMPLES"))
    print("  " + "-" * 96)
    running = len(rows)
    for g in GATES:
        ks = killed[g]
        running -= len(ks)
        head = "%s  [%s]" % (ks[0][0]["title"][:44], ks[0][1]) if ks else "-"
        print("  %-12s %7d   %s" % (g, len(ks), head[:62]))
        for j, ph, _f in ks[1:5]:
            print("  %-12s %7s   %s" % ("", "", ("%s  [%s]" % (j["title"][:44], ph))[:62]))
        print("  %-12s %7s   -> %d remaining" % ("", "", running))
    print("\n  rows written: %d classification, %d verdict (of %d read)"
          % (n_class, n_verdict, len(rows)))
    print("\n  survivors to stage 2: %d (%.0f%% of candidates)"
          % (survivors, 100 * survivors / max(1, len(rows))))
    print("  full kill list with matched phrases: python score_jobs.py kills")
    funnel(con)


def kill_sentence(desc, phrase, width=150):
    """The sentence a matched phrase actually sits in.

    A PHRASE CANNOT TELL YOU WHICH FACT YOU HAVE. "This is not a contract
    position" and "this is a 6-month contract position" produce the identical
    row in the kill list — opposite facts, one string. The only way to tell them
    apart is to read the sentence around the match, and until now that meant a
    database query per row. That cost is why a review of fourteen kills took a
    session instead of a glance.

    It DECIDES NOTHING. No gate consults it; it only shows what a gate read.

    The boundary rule is a period followed by whitespace and NOT preceded by a
    capital letter — the rule the clearance patterns had to learn the hard way.
    "U.S." and "Inc." are full of periods that end nothing, and a naive split on
    ". " cuts "across the U.S., Europe" into three pieces and reports a fragment
    that reads as a different fact from the sentence it came out of.
    """
    body = desc or ""
    p = (phrase or "").strip()
    if not body or not p:
        return ""
    i = body.lower().find(p.lower())
    if i < 0:
        return ""
    j = i + len(p)
    left = 0
    for m in re.finditer(r"(?<![A-Z])[.!?]\s+|\n", body[:i]):
        left = m.end()
    right = len(body)
    m = re.search(r"(?<![A-Z])[.!?]\s+|\n", body[j:])
    if m:
        right = j + m.start() + 1
    s = re.sub(r"\s+", " ", body[left:right]).strip()
    return s if len(s) <= width else s[:width - 1] + "…"


def cmd_kills(gate=None, field=None, limit=0, group=False):
    """Every gated row with the phrase that killed it. Read this before a run.

    A gate's kill count tells you how much died, never what — the same lesson the
    triage prompt taught when a 20% survival rate looked healthy while deleting
    Palantir's Forward Deployed Software Engineer, New Grad. The only way to see
    a false positive is to read the phrase that caused it.
    """
    con = db()
    con.row_factory = sqlite3.Row
    q = ("SELECT key, COALESCE(display_name, company) co, title, location, "
         "gate_name, gate_text, gate_field, triage_reason, description FROM jobs "
         "WHERE closed_at IS NULL AND candidate=1 AND triage=0")
    args = []
    if gate:
        q += " AND gate_name=?"
        args.append(gate)
    if field:
        q += " AND gate_field=?"
        args.append(field)
    q += " ORDER BY gate_name, gate_text, co, title"
    rows = con.execute(q, args).fetchall()

    if group:
        # Phrase-first view: one line per distinct matched phrase. A bad regex
        # shows up here as a phrase with a high count and a wrong meaning.
        agg = {}
        for r in rows:
            k = (r["gate_name"], r["gate_field"], (r["gate_text"] or "").lower())
            agg.setdefault(k, []).append(r)
        print("%d kills across %d distinct phrases\n" % (len(rows), len(agg)))
        print("  %-10s %-12s %5s  %-34s %s" % ("GATE", "FIELD", "N", "MATCHED PHRASE", "EXAMPLE"))
        print("  " + "-" * 108)
        for (g, f, p), rs in sorted(agg.items(), key=lambda kv: (kv[0][0] or "", -len(kv[1]),
                                            kv[0][1] or "", kv[0][2] or "")):
            print("  %-10s %-12s %5d  %-34s %s"
                  % (g or "?", f or "?", len(rs), repr(p)[:34], rs[0]["title"][:34]))
            # ONE REAL SENTENCE PER PHRASE. This view exists so "a bad regex
            # shows up as a phrase with a high count and a wrong meaning" — and
            # the meaning lives in the sentence, never in the phrase. Only a
            # description match can differ: a title match's sentence IS the
            # title, already printed on the line above.
            if (f or "") == "description":
                sent = kill_sentence(rs[0]["description"], p)
                if sent:
                    print("  %-10s %-12s %5s  %s" % ("", "", "", "└ " + sent))
        return

    n_missing = sum(1 for r in rows if not r["gate_text"])
    print("%d gated rows%s\n" % (len(rows), " (%d with no stored phrase — re-run "
                                "`gate --reset`)" % n_missing if n_missing else ""))
    cur = None
    shown = 0
    for r in rows:
        if r["gate_name"] != cur:
            cur = r["gate_name"]
            n = sum(1 for x in rows if x["gate_name"] == cur)
            # ASCII only: the Windows console is cp1252 and mangles an em dash.
            print("\n=== gate: %s - %d killed ===" % (cur or "?", n))
            print("  %-16s %-44s %-20s %-10s %s"
                  % ("COMPANY", "TITLE", "LOCATION", "FIELD", "MATCHED PHRASE"))
        if limit and shown >= limit:
            continue
        shown += 1
        print("  %-16s %-44s %-20s %-10s %s"
              % ((r["co"] or "")[:16], (r["title"] or "")[:44],
                 (r["location"] or "")[:20], r["gate_field"] or "?",
                 repr(r["gate_text"] or "")[:40]))
        # THE SENTENCE, under the row the phrase killed. Only for a
        # description match: for a title match the sentence is the title,
        # which is already the second column.
        if (r["gate_field"] or "") == "description":
            sent = kill_sentence(r["description"], r["gate_text"])
            if sent:
                print("  %-16s └ %s" % ("", sent))


# effort is not universal. Haiku 4.5 rejects output_config.effort outright —
# "This model does not support the effort parameter" — which errored an entire
# 150-request batch. Only send it to models that accept it.
EFFORT_MODELS = ("claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
                 "claude-sonnet-5", "claude-fable-5")


def _supports_effort(model):
    return any((model or "").startswith(m) for m in EFFORT_MODELS)


def _score_request(cid, system_text, job):
    params = {
        "model": MODEL,
        # Sonnet 5 runs adaptive thinking by default and thinking tokens count
        # against max_tokens. At 900 the JSON was truncated on 21% of responses —
        # median 685 chars, some empty because thinking used the whole budget.
        "max_tokens": 3000,
        "system": [{"type": "text", "text": system_text,
                    "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": _score_user(job)}],
    }
    if _supports_effort(MODEL):
        params["output_config"] = {"effort": SCORE_EFFORT}
    return {"custom_id": cid, "params": params}


def _store_run(con, key, idx, parsed, raw, model=None):
    con.execute(
        # ON CONFLICT rather than INSERT OR REPLACE: the latter is SQLite-only
        # and Postgres rejects it outright. Both accept this spelling.
        """INSERT INTO score_runs
             (key, run_idx, score, tier, reasons, gaps, evidence_ids, angle,
              raw, model, effort, at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (key, run_idx) DO UPDATE SET
             score=excluded.score, tier=excluded.tier, reasons=excluded.reasons,
             gaps=excluded.gaps, evidence_ids=excluded.evidence_ids,
             angle=excluded.angle, raw=excluded.raw, model=excluded.model,
             effort=excluded.effort, at=excluded.at""",
        (key, idx, parsed.get("score"), parsed.get("tier"),
         json.dumps(parsed.get("reasons", [])), json.dumps(parsed.get("gaps", [])),
         json.dumps(parsed.get("evidence_ids", [])), parsed.get("angle"),
         raw, model or MODEL, SCORE_EFFORT, now()))


def _aggregate(con, key, model=None):
    """Collapse this role's runs into one row: median score, observed spread,
    and the narrative from the run that landed ON the median."""
    # Prefer runs from the ACTIVE model. Old-model runs stay in score_runs as
    # history and are never deleted — the replacement is written alongside and
    # only then becomes authoritative.
    runs = con.execute(
        "SELECT * FROM score_runs WHERE key=? AND score IS NOT NULL AND model=? "
        "ORDER BY score", (key, model or MODEL)).fetchall()
    if not runs:
        runs = con.execute(
            "SELECT * FROM score_runs WHERE key=? AND score IS NOT NULL ORDER BY score",
            (key,)).fetchall()
    if not runs:
        return
    vals = [r["score"] for r in runs]
    med_run = runs[len(runs) // 2]
    median = vals[len(vals) // 2]
    # The owner holds no clearance and cannot obtain one without a sponsor, so a
    # role demanding an active clearance at hire is unavailable to them
    # regardless of fit. Code decides that, not the model.
    clr = con.execute("SELECT clearance_status FROM jobs WHERE key=?", (key,)).fetchone()
    if clr and clr["clearance_status"] == "required_active":
        median = min(median, 5)
    con.execute(
        """INSERT INTO scores
             (key, score, tier, model, reasons, gaps, evidence_ids, angle, raw,
              scored_at, score_lo, score_hi, score_spread, n_samples, effort)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (key) DO UPDATE SET
             score=excluded.score, tier=excluded.tier, model=excluded.model,
             reasons=excluded.reasons, gaps=excluded.gaps,
             evidence_ids=excluded.evidence_ids, angle=excluded.angle,
             raw=excluded.raw, scored_at=excluded.scored_at,
             score_lo=excluded.score_lo, score_hi=excluded.score_hi,
             score_spread=excluded.score_spread, n_samples=excluded.n_samples,
             effort=excluded.effort""",
        (key, median, med_run["tier"], model or MODEL, med_run["reasons"], med_run["gaps"],
         med_run["evidence_ids"], med_run["angle"], med_run["raw"], now(),
         min(vals), max(vals), max(vals) - min(vals), len(vals), SCORE_EFFORT))


def _store_score(con, key, parsed, raw):
    _store_run(con, key, 0, parsed, raw)
    _aggregate(con, key)


def _parse_score(text):
    """Parse a score object, tolerating prose around it.

    Haiku honours "respond with ONLY a JSON object" about half the time — it
    routinely appends advice after the object ("Frame D.C. as a trade-off you're
    willing to make..."). Strict json.loads scored 27/50; pulling the first
    balanced {...} block out scores 50/50 on the same responses. Cheaper and more
    reliable than fighting it in the prompt.
    """
    raw = (text or "").strip().replace("```json", "").replace("```", "").strip()
    try:
        return json.loads(raw), raw
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(raw)):
            if raw[i] == "{":
                depth += 1
            elif raw[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(raw[start:i + 1]), raw
                    except json.JSONDecodeError:
                        break
        start = raw.find("{", start + 1)
    return None, raw


BATCH_MAX_AGE_H = 24


def in_flight_keys(con):
    """Every job key sitting in a submitted-but-uncollected batch.

    THESE MUST NOT BE SELECTED AGAIN. A batch is billed when it PROCESSES, not
    when its results are read, so a role submitted last night and not yet
    collected is already paid for. Selecting it again buys the same score
    twice.

    Nothing enforced this before, because scoring blocked on the batch and so a
    run could not end with one outstanding. daily #21 ended with one anyway --
    cancelled at the job timeout, 27m49s into a poll -- and the next run would
    have resubmitted all six roles, because the selection asks only whether a
    score row exists yet and an uncollected batch has written none.
    """
    keys = set()
    for r in con.execute(
            "SELECT keymap FROM batches WHERE stage='score' AND collected_at IS NULL"
    ).fetchall():
        try:
            for ent in json.loads(r["keymap"] or "{}").values():
                # TWO SHAPES, both live in this column. With --samples > 1 a
                # role appears several times and the value is [key, sample_idx];
                # with one sample it is the bare key. write_batch unpacks it the
                # same way, and reading only one of the two shapes here would
                # have protected exactly the runs that submit one sample --
                # which is every run the workflow makes.
                keys.add(ent[0] if isinstance(ent, list) else ent)
        except (ValueError, TypeError, IndexError, AttributeError):
            # A KEYMAP THAT WILL NOT PARSE BLOCKS NOTHING, and that is the
            # right way round: the cost of failing open here is scoring a
            # handful of roles twice, and the cost of failing closed is a
            # single corrupt row freezing scoring forever with no symptom.
            print(f"  warning: a pending batch has an unreadable keymap; its "
                  f"roles are not protected from resubmission")
    return keys


def batch_age_hours(submitted_at, now_iso=None):
    """Hours since submission, or None when the timestamp is unreadable."""
    ref = now_iso or now()
    try:
        a = dt.datetime.fromisoformat(str(submitted_at).replace("Z", "+00:00"))
        b = dt.datetime.fromisoformat(str(ref).replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return None
    if a.tzinfo is None:
        a = a.replace(tzinfo=dt.timezone.utc)
    if b.tzinfo is None:
        b = b.replace(tzinfo=dt.timezone.utc)
    return (b - a).total_seconds() / 3600.0


def cmd_score(limit, rescore_all, sync=False, no_wait=False, sample=None,
              remodel=False, include_experienced=False, dry_run=False,
              wait=False, client=None):
    """Collect what is outstanding, then submit what is new.

    THE ORDER IS THE POINT, and it lives here rather than at the call site so
    that it is a property every caller and every test gets for free.

    It never blocks on the collect: a batch still processing is left alone and
    the run carries on. Blocking on a Batch API poll inside a job with a
    30-minute timeout is what killed daily #21, and the API offers no latency
    guarantee below 24 hours, so there is no timeout that makes it correct.
    """
    reaped = []
    if not sync and not dry_run:
        reaped = cmd_collect(wait=False, client=client, quiet_when_empty=True)

    rc = _score_body(limit, rescore_all, sync, no_wait, sample, remodel,
                     include_experienced, dry_run, wait, client)

    # A REAPED BATCH IS MONEY SPENT ON ROLES THAT WERE NEVER SCORED, and it
    # must not pass as a quiet morning. Rather than invent a second alerting
    # path it reddens the step: job.status becomes failure, "Record the run"
    # writes that, and the digest's pipeline_failure line says so.
    #
    # REPORTED AFTER THE RUN, NOT INSTEAD OF IT. The first version exited
    # inside the collect above, which skipped the submission entirely -- so a
    # reap would have cost that morning's scoring on top of the batch it was
    # cleaning up after. Caught by a mutation, not by reading it.
    return 1 if reaped else rc


def _score_body(limit, rescore_all, sync=False, no_wait=False, sample=None,
                remodel=False, include_experienced=False, dry_run=False,
                wait=False, client=None):
    con = db()
    con.row_factory = sqlite3.Row
    system_text = SYSTEM + load_profile()

    # DEFAULT-ON, not opt-in. "Score only program or entry" is a standing rule,
    # and it used to sit behind --reachable-only: forget the flag and you score
    # six times the roles. That is how a $0.07 run became a 123-role one. A
    # standing rule that depends on remembering a flag is not enforced.
    reachable_only = not include_experienced

    where = "j.closed_at IS NULL AND j.candidate=1 AND (j.triage IS NULL OR j.triage=1)"
    if reachable_only:
        # Skip 'experienced' entirely: a score on a role wanting five years tells
        # the owner nothing they can use, and it is the bulk of what a new board adds.
        where += " AND j.entry_level IN ('program','entry')"
    if remodel:
        # Everything not yet on the active model's scale.
        where += " AND s.key IS NOT NULL AND s.model <> '%s'" % MODEL.replace("'", "''")
    elif not rescore_all:
        where += " AND s.key IS NULL"

    # ROLES ALREADY IN AN UNCOLLECTED BATCH ARE ALREADY PAID FOR.
    # in_flight_keys() reads the keymaps of every submitted-but-unread batch;
    # without this the next run resubmits every one of them, because "has no
    # score row yet" is true of a role whose results are sitting at the API
    # waiting to be read.
    flight = in_flight_keys(con)
    if flight:
        where += " AND j.key NOT IN (%s)" % ",".join(
            "'" + str(k).replace("'", "''") + "'" for k in sorted(flight))
        print(f"{len(flight)} role(s) are in a batch already submitted and not "
              f"yet collected — excluded, not resubmitted.")
    if sample:
        # Stratified across companies, so a 50-role sample is not a quarter Palantir.
        rows = con.execute(
            f"""WITH ranked AS (
                  SELECT j.*, ROW_NUMBER() OVER (PARTITION BY j.slug ORDER BY RANDOM()) rn
                  FROM jobs j LEFT JOIN scores s ON s.key=j.key WHERE {where}
                )
                SELECT * FROM ranked ORDER BY rn, RANDOM() LIMIT ?""", (sample,)).fetchall()
    else:
        rows = con.execute(
            f"""SELECT j.* FROM jobs j LEFT JOIN scores s ON s.key=j.key
                WHERE {where} ORDER BY j.tier, j.first_seen DESC LIMIT ?""", (limit,)).fetchall()
    if not rows:
        print("Nothing to score.")
        return

    # THE ESTIMATE COMES FROM THE SELECTION ABOVE, not from a query written by
    # hand somewhere else. An estimate that can disagree with the run is
    # decoration: the $1.19 overrun was a hand-written count that assumed a
    # different model and a filter the real run did not apply.
    #
    # Printed on EVERY run, not only --dry-run, so the numbers are in front of
    # whoever is watching before anything is spent.
    #
    # THE PAYLOAD IS BUILT FIRST AND THE ESTIMATE COUNTS IT. Not len(rows), not
    # len(rows) * SCORE_SAMPLES — the actual list of requests that is about to be
    # sent. Building it costs nothing but local string work, and --dry-run simply
    # stops before the send. Three estimates in a row were wrong here because
    # each described the submission instead of measuring it.
    reqs, keymap = build_score_requests(rows, system_text, remodel)
    est, detail = estimate_requests(MODEL, reqs, system_text, batch=not sync)
    n_req = len(reqs)
    spent, all_measured = _spend_since_reset(con)

    # ONE MODEL SCORES EVERYTHING, enforced here rather than remembered.
    #
    # Haiku scores ~14 points higher than Sonnet on the same role, so mixing
    # them in one table puts the top of the ranking in whichever model inflates
    # most. It has happened: 204 rows on Haiku beside 500 on Sonnet took two
    # attempts to clean up. The rule was written down and the default still
    # pointed at the wrong model for months.
    #
    # --remodel is the sanctioned way to change scales: it re-scores everything
    # not already on the active model, so the table ends up uniform again.
    others = [r["model"] for r in con.execute(
        "SELECT DISTINCT model FROM scores WHERE model IS NOT NULL"
        " AND model <> ?", (MODEL,)).fetchall()]
    if others and not (remodel or rescore_all):
        print("\nREFUSING: the scores table already holds %s, and this run "
              "would add %s." % (", ".join(others), MODEL))
        print("Two models on one table are not comparable — a raw 54 from the "
              "higher scale outranks a raw 82 from the lower.")
        print("Re-score everything onto one scale with --remodel, or set "
              "JOBOPS_MODEL back to %s." % others[0])
        return 1
    print("  model        %s" % MODEL)
    print("  roles        %d  (%s)"
          % (len(rows),
             "program/entry only" if reachable_only
             else "INCLUDING experienced"))
    print("  requests     %d  (%d samples per role)" % (n_req, SCORE_SAMPLES))
    print("  tokens       %d in + %d out, %d cache write + %d cache read"
          % (detail["input_tokens"], detail["output_tokens"],
             detail["cache_write"], detail["cache_read"]))
    print("  mode         %s" % ("synchronous" if sync else "batch (50% off)"))
    print("  estimate     $%.2f" % est)
    print("  month to date %s%.2f of $%.2f cap -> $%.2f after%s"
          % ("$" if all_measured else "~$", spent, MONTHLY_CAP, spent + est,
             "" if all_measured else "   (~ = a floor; some batches "
             "not yet measured)"))
    if spent + est > MONTHLY_CAP:
        print("\nREFUSING: this would pass the $%.2f monthly cap." % MONTHLY_CAP)
        print("The cap is a hard constraint, not a warning. Nothing was sent.")
        return 1
    if dry_run:
        print("\n--dry-run: nothing sent.")
        return 0

    if sync:
        client = anthropic.Anthropic()
        print(f"Scoring {len(rows)} jobs with {MODEL} (synchronous)…")
        for i, job in enumerate(rows, 1):
            parsed, raw = score_one(client, system_text, dict(job))
            if not parsed:
                print(f"  [{i}/{len(rows)}] {job['company']} — {job['title']}: unparseable, stored raw")
                parsed = {}
            _store_score(con, job["key"], parsed, raw)
            con.commit()
            print(f"  [{i}/{len(rows)}] {parsed.get('score','?'):>3}  {parsed.get('tier','?'):5s}  "
                  f"{job['company']} — {job['title']}")
        funnel(con)
        return

    print(f"Stage 2: {len(rows)} roles x {SCORE_SAMPLES} samples = {len(reqs)} calls, "
          f"{MODEL} effort={SCORE_EFFORT}, Batch API (50% off)")

    api = client or anthropic.Anthropic()
    batch = api.messages.batches.create(requests=reqs)
    con.execute(
        "INSERT INTO batches (batch_id, stage, model, n, submitted_at, keymap) VALUES (?,?,?,?,?,?)",
        (batch.id, "score", MODEL, len(reqs), now(), json.dumps(keymap)))
    con.commit()
    print(f"\nSubmitted {batch.id} ({batch.processing_status}).")

    # SUBMIT AND EXIT. This is the default, and --wait is the deliberate
    # exception for someone sitting at the terminal watching one go through.
    #
    # It used to be the other way round: the run blocked on a 60-second poll
    # until the batch ended, with --no-wait as the opt-in. The Batch API offers
    # no latency guarantee below 24 hours, so blocking on it inside a job with
    # a 30-minute timeout is wrong by design rather than unlucky -- daily #21
    # polled for 27m49s and was cancelled with the results still in flight.
    #
    # The keymap above is what makes exiting safe: the next run collects this
    # batch before it selects anything, and excludes these roles from that
    # selection until it has.
    if not wait:
        print("Not waiting. The next run collects it; "
              "`python score_jobs.py collect` reads it sooner.")
        return
    cmd_collect(wait=True, client=api)


def _reap(batch_id, status):
    """Stop a stuck batch blocking, without losing what it recorded.

    MARKED, NOT DELETED. collected_at carries a REAPED- marker in the same
    shape as the CANCELLED- one, so a later collect will not pick it up again,
    the row keeps its keymap and usage for the cost meter, and the reason is on
    the row rather than only in a log nobody reads.
    """
    def work(con):
        con.execute("UPDATE batches SET collected_at=? WHERE batch_id=?",
                    (f"{now()} REAPED-{status}", batch_id))
        con.commit()
    _retry_write(work)


def _add_usage(acc, u):
    """Accumulate one response's token usage. Missing fields count as zero.

    The cache fields are absent on models or responses that did not use the
    cache, and getattr with a default is the difference between a measured
    number and an exception on the one path that reports spend.
    """
    acc["in"] += getattr(u, "input_tokens", 0) or 0
    acc["out"] += getattr(u, "output_tokens", 0) or 0
    acc["cw"] += getattr(u, "cache_creation_input_tokens", 0) or 0
    acc["cr"] += getattr(u, "cache_read_input_tokens", 0) or 0


def cmd_collect(wait, client=None, quiet_when_empty=False):
    """Read finished batches into the database.

    ALSO THE REAPER. A batch that has not ended 24 hours after submission is
    past the Batch API's own guarantee and past its expires_at, so it is never
    going to end. Left uncollected it blocks every role in its keymap from ever
    being scored again -- in_flight_keys() would exclude them forever, silently,
    which is the always-empty-source failure with a receipt attached.

    So it is marked REAPED and stops blocking. WHATEVER SUCCEEDED IS COLLECTED
    FIRST: an expired batch still returns results for the requests that
    completed, those were billed, and discarding them would throw away work
    already paid for. Marked, never deleted -- the row keeps its usage, its
    keymap and the reason, so the cost meter and any later question still have
    it.

    THE CONNECTION IS NOT HELD ACROSS THE WAIT. Run #9 failed exactly there:
    this opened a connection, polled a batch for eight minutes, and by the time
    results arrived Neon had closed the idle socket. pg8000 raised
    InterfaceError from inside _store_run, after the API call had already been
    paid for.

    So the shape is now three phases, and the middle one holds nothing open:

      1. read the pending batches, then CLOSE
      2. wait for the batch, with no database connection at all
      3. open a FRESH connection and write, retrying the whole write if the
         transport dies again

    Retrying from the start is safe, and is the only correct option: the write
    is one transaction with a single commit at the end, so a dropped connection
    rolls the server side back completely — no score_runs, no scores, and
    collected_at still NULL. There is no partial state to resume from. Every
    statement is idempotent (ON CONFLICT DO UPDATE) and a batch's results can be
    re-read from the API as often as needed, so a repeat costs nothing and
    charges nothing: the batch was billed when it PROCESSED, not when it is
    read.
    """
    # ---- 1. what is outstanding, then let the connection go.
    con = db()
    con.row_factory = sqlite3.Row
    pending = con.execute(
        "SELECT * FROM batches WHERE stage='score' AND collected_at IS NULL").fetchall()
    con.close()

    if not pending:
        if not quiet_when_empty:
            print("No uncollected score batches.")
        return []

    api = client or anthropic.Anthropic()
    reaped = []

    for b in pending:
        # ---- 2. wait, holding NO connection. This is the eight minutes that
        # killed the last run.
        st = api.messages.batches.retrieve(b["batch_id"])
        while wait and st.processing_status != "ended":
            print(f"  {b['batch_id']}: {st.processing_status}… waiting 60s", flush=True)
            time.sleep(60)
            st = api.messages.batches.retrieve(b["batch_id"])
        if st.processing_status != "ended":
            age = batch_age_hours(b["submitted_at"])
            # AN UNREADABLE TIMESTAMP IS NOT A YOUNG BATCH. batch_age_hours
            # returns None when it cannot parse, and treating that as "recent"
            # would leave the row blocking forever -- the exact outcome the
            # reaper exists to prevent.
            if age is None or age >= BATCH_MAX_AGE_H:
                shown = "unknown" if age is None else f"{age:.1f}h"
                print(f"  {b['batch_id']}: still {st.processing_status} after "
                      f"{shown} — PAST the {BATCH_MAX_AGE_H}h guarantee. "
                      f"Reaping so its {b['n']} role(s) can be scored again.")
                _reap(b["batch_id"], st.processing_status)
                reaped.append((b["batch_id"], st.processing_status, shown))
            else:
                print(f"  {b['batch_id']}: {st.processing_status} "
                      f"({age:.1f}h old) — leaving it, the next run reads it.")
            continue

        # ---- 3. a fresh connection for the write, and retry the whole write.
        def write_batch(con, b=b):
            con.row_factory = sqlite3.Row
            keymap = json.loads(b["keymap"])
            ok = bad = err = 0
            touched = set()
            # MEASURED usage, accumulated as the results stream past.
            # Estimating this from mean token shapes read 35% low, because it
            # priced no cache traffic at all — and the cache is most of the
            # input on a run that sends the same profile with every request.
            usage = {"in": 0, "out": 0, "cw": 0, "cr": 0}
            for res in api.messages.batches.results(b["batch_id"]):
                ent = keymap.get(res.custom_id)
                if not ent:
                    continue
                key, idx = (ent if isinstance(ent, list) else [ent, 0])
                if res.result.type != "succeeded":
                    err += 1
                    continue
                _add_usage(usage, res.result.message.usage)
                text = "".join(blk.text for blk in res.result.message.content
                               if getattr(blk, "type", "") == "text")
                parsed, raw = _parse_score(text)
                if parsed is None:
                    # Fail open: keep the raw response so nothing is lost silently.
                    bad += 1
                    parsed = {}
                else:
                    ok += 1
                # The batch record is the authority on which model produced
                # this. `collect` runs in its own process where the module
                # default would otherwise win, which once stored 500 Haiku
                # responses as Sonnet.
                _store_run(con, key, idx, parsed, raw, b["model"])
                touched.add(key)
            for key in touched:
                _aggregate(con, key, b["model"])
            con.execute(
                "UPDATE batches SET collected_at=?, in_tok=?, out_tok=?,"
                " cache_w_tok=?, cache_r_tok=? WHERE batch_id=?",
                (now(), usage["in"], usage["out"], usage["cw"], usage["cr"],
                 b["batch_id"]))
            con.commit()
            return ok, bad, err

        def said(attempt, exc):
            print(f"  {b['batch_id']}: the database connection dropped "
                  f"({type(exc).__name__}). Nothing was committed; retrying "
                  f"the whole write on a fresh connection "
                  f"(attempt {attempt + 1}).", flush=True)

        ok, bad, err = _retry_write(write_batch, on_retry=said)
        print(f"\nBatch {b['batch_id']}: {ok} scored, "
              f"{bad} unparseable (raw kept), {err} errored")

    con = db()
    funnel(con)
    con.close()

    # IT REPORTS AND RETURNS. It does NOT exit here.
    #
    # The first version called sys.exit(1) on this line, and cmd_score calls
    # this before it selects anything -- so a morning that reaped a batch
    # would have died inside the collect and submitted no new work at all. The
    # reap would have cost that day's scoring on top of the batch it was
    # cleaning up after. The caller decides: `collect` exits non-zero, and
    # `score` finishes the run first and exits non-zero at the end.
    if reaped:
        print(f"\n{len(reaped)} batch(es) reaped. The roles are released and "
              f"can be scored again; the spend on them is gone.")
        for bid, status, age in reaped:
            print(f"  {bid}  {status}  after {age}")
    return reaped


def _retry_write(work, on_retry=None):
    """Run a write on a fresh connection, retrying a dropped transport.

    On Postgres this is pgdb.with_reconnect. On SQLite there is no socket to
    drop, so it is one call on one connection — and writing it this way keeps a
    single code path rather than an `if` around every write.
    """
    import pgdb
    if pgdb.using_pg():
        return pgdb.with_reconnect(work, on_retry=on_retry)
    con = db()
    try:
        return work(con)
    finally:
        con.close()


def cmd_rank(min_score, n, cap=3):
    con = db()
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """SELECT j.key, j.company, j.title, j.location, j.url, s.score, s.tier, s.angle, a.stage
           FROM jobs j JOIN scores s ON s.key=j.key LEFT JOIN applications a ON a.key=j.key
           WHERE j.closed_at IS NULL AND s.score >= ?
           ORDER BY s.score DESC LIMIT ?""",
        (min_score, max(n * 8, 200)),
    ).fetchall()
    # Cap per company. Palantir alone was 17 of the uncapped top 25 — without a
    # cap the ranking measures board size, not fit.
    if cap:
        seen, capped = {}, []
        for r in rows:
            if seen.get(r["company"], 0) >= cap:
                continue
            seen[r["company"]] = seen.get(r["company"], 0) + 1
            capped.append(r)
        rows = capped
    rows = rows[:n]
    if not rows:
        print("No scored jobs above threshold. Run `score` first.")
        return
    for r in rows:
        stage = f"[{r['stage']}]" if r["stage"] else ""
        print(f"{r['score']:>3} {r['tier']:5s} {r['company']:<14} {r['title'][:48]:<48} {r['location'][:22]:<22} {stage}")
        print(f"      {r['angle']}")
        print(f"      {r['url']}\n")


def cmd_show(key):
    con = db()
    con.row_factory = sqlite3.Row
    r = con.execute(
        """SELECT j.company, j.title, j.location, j.url, s.score, s.tier AS fit_tier,
                  s.reasons, s.gaps, s.evidence_ids, s.angle
           FROM jobs j JOIN scores s ON s.key=j.key WHERE j.key=?""", (key,)
    ).fetchone()
    if not r:
        print("Not found or not scored.")
        return
    print(f"{r['company']} — {r['title']} ({r['location']})\n{r['url']}\n")
    print(f"Score {r['score']}  tier={r['fit_tier']}\n")
    print("Reasons:");  [print("  +", x) for x in json.loads(r["reasons"])]
    print("Gaps:");     [print("  -", x) for x in json.loads(r["gaps"])]
    print("Lead with:", ", ".join(json.loads(r["evidence_ids"])))
    print("Angle:", r["angle"])


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("score")
    s.add_argument("--limit", type=int, default=2000)
    s.add_argument("--all", action="store_true")
    s.add_argument("--sync", action="store_true", help="score serially instead of via the Batch API")
    # --no-wait IS NOW THE DEFAULT and this flag is kept only so an existing
    # command line does not break. --wait is the override, for someone sitting
    # at the terminal watching one batch through; it must never be used in the
    # workflow, where a job timeout is what a 24-hour-guarantee API meets.
    s.add_argument("--no-wait", action="store_true",
                   help="(default; kept for compatibility) submit and exit")
    s.add_argument("--wait", action="store_true",
                   help="BLOCK until the batch ends — interactive use only; "
                        "the Batch API may take up to 24h")
    s.add_argument("--samples", type=int, default=None, help="independent samples per role")
    s.add_argument("--effort", default=None, help="low|medium|high|xhigh|max")
    s.add_argument("--sample", type=int, default=None,
                   help="stratified N-role sample — validate a change before a full run")
    s.add_argument("--model", default=None, help="override JOBOPS_MODEL for this run")
    # --reachable-only is now the DEFAULT and this flag is kept only so an old
    # command line does not break. --include-experienced is the override.
    s.add_argument("--reachable-only", dest="reachable_only", action="store_true",
                   help="(default; kept for compatibility) program/entry only")
    s.add_argument("--include-experienced", dest="include_experienced",
                   action="store_true",
                   help="ALSO score 'experienced' roles — far more roles and "
                        "far more money; prints the count and cost first")
    s.add_argument("--dry-run", dest="dry_run", action="store_true",
                   help="print the model, the exact role count and the cost "
                        "using the real selection, then stop")
    s.add_argument("--remodel", action="store_true",
                   help="re-score rows currently on a DIFFERENT model, onto this one")
    sub.add_parser("collect")
    r = sub.add_parser("rank")
    r.add_argument("--min", type=int, default=60)
    r.add_argument("--n", type=int, default=25)
    r.add_argument("--cap", type=int, default=3,
                   help="max roles per company; --cap 0 for the raw ranking")
    w = sub.add_parser("show"); w.add_argument("key")

    g = sub.add_parser("gate")
    g.add_argument("--reset", action="store_true",
                   help="clear existing verdicts and re-run the gate from scratch")

    k = sub.add_parser("kills", help="every gated row with the phrase that killed it")
    k.add_argument("--gate", choices=GATES)
    k.add_argument("--field", choices=("location", "title", "description"))
    k.add_argument("--limit", type=int, default=0, help="0 = show all")
    k.add_argument("--group", action="store_true",
                   help="one line per distinct matched phrase")

    sub.add_parser("cost")
    v = sub.add_parser("verify-models")
    v.add_argument("ids", nargs="*", default=["claude-haiku-4-5", "claude-haiku-4-5-20251001",
                                              "claude-sonnet-5"])
    a = ap.parse_args()
    if a.cmd == "score":
        if a.samples:
            globals()["SCORE_SAMPLES"] = a.samples
        if a.effort:
            globals()["SCORE_EFFORT"] = a.effort
        if a.model:
            globals()["MODEL"] = a.model
        return cmd_score(a.limit, a.all, a.sync, a.no_wait, a.sample,
                         a.remodel, a.include_experienced, a.dry_run,
                         wait=a.wait)
    elif a.cmd == "collect":
        # `collect` on its own is a person asking for the results NOW, so it
        # waits. The workflow never calls it: `score` collects first and never
        # blocks.
        if cmd_collect(wait=True):
            sys.exit(1)
    elif a.cmd == "rank":
        cmd_rank(a.min, a.n, a.cap)
    elif a.cmd == "show":
        cmd_show(a.key)
    elif a.cmd == "cost":
        cmd_cost()
    elif a.cmd == "verify-models":
        cmd_verify_models(a.ids)
    elif a.cmd == "gate":
        cmd_gate(a.reset)
    elif a.cmd == "kills":
        cmd_kills(a.gate, a.field, a.limit, a.group)


if __name__ == "__main__":
    sys.exit(main())
