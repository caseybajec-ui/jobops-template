"""Screen-out requirements stamped on a role at ingest. Pure — no I/O, no model.

WHAT THIS IS FOR. Mistral's AI Deployment Strategist scored 28 on a line the
owner could not have met, after they had already got attached to the title. The blocker
tags put that line on the row BEFORE the score, so the disqualifier arrives with
the posting instead of three days later.

IT GATES NOTHING. No role is deleted, hidden, or penalised. Scoring is untouched.
These are visible tags and nothing else — "fail open, always" applies here as
everywhere: the cost of showing a wrong tag is a second of reading, and the cost
of dropping a real opportunity is unrecoverable.

=============================================================================
THE UNIT IS A BULLET, NOT THE POSTING. This is the whole design, and it was
settled by measuring both against the corpus rather than by argument.

Document-level regex — literally what the spec asked for — tags 359 of 1,792
candidate roles as clearance-blocked. Per-bullet tags 114. The 245-role
difference is not noise; it is concentrated on the best company in the corpus:

    Palantir, Forward Deployed Software Engineer - US Government - Federal
    "Active U.S. security clearance at the Top Secret level, or willingness
     to obtain or upgrade to a Top Secret clearance"

Read as a document, "Active ... clearance" matches and the role goes red. Read
as a bullet, the same sentence carries "or willingness to obtain" and the role
is `clearance_obtainable` — green, and correct. Palantir has 158 candidate
roles: 16 genuinely hard, 96 obtainable. Document-level paints most of the 96
closed. That is the Applied Intuition near-miss in CLAUDE.md, repeating.

Degrees fail the same way. Stripe's "Software Engineer, New Grad" says
"degree in computer science ... or equivalent work experience", and Anduril has
a dozen "Bachelor's degree in engineering ... is preferred". A document-level
match cannot tell which bullet the qualifier belongs to. Per-bullet can.
=============================================================================

THE TITLE IS A UNIT TOO. Fifteen candidate roles state the requirement ONLY in
the title — "Forward Deployed Engineer - Oahu (TS/SCI Clearance Required)",
"Program Manager, Connected Warfare (Active Clearance)". Defense boards put it
there precisely so nobody wastes an application, and every sentence-shaped
pattern in this project has missed it at least once.

ABSENCE OF A TAG IS NOT ABSENCE OF A BLOCKER when the text was cut. 9,708 of
11,500 open roles are truncated at 2,000 characters by storage_policy, and
requirements sections almost always sit past that. A hit inside the first 2,000
characters is still a true hit, so the patterns run anyway — but "no tags" on a
truncated row means UNKNOWN, never "clear". `complete` carries that, and every
surface that renders a clean row has to check it.
"""
import re

# The tags. `clearance_obtainable` and `citizenship_only` are NOT blockers for
# the owner — a US citizen with no clearance and no known disqualifying
# factors, willing to undergo the process (profile.json `citizenship` and
# `clearance`). They are tagged so the row can say "this is fine" out loud
# rather than leaving a clearance mention unexplained, and they render green.
# See the clearance phrasing rules in CLAUDE.md: nothing here may imply the
# owner is cleared or has been adjudicated eligible.
HARD = ("cs_degree", "years_4plus", "clearance")
SOFT = ("clearance_obtainable", "citizenship_only")
ALL_TAGS = HARD + SOFT

# The years figure at or above which a role is out of reach for a new grad.
# From the spec. A stated 3 is not tagged: plenty of "3+ years" postings take
# strong new grads, and this tag is a warning, not a filter.
YEARS_BLOCK_AT = 4

# How long a unit can be before it is split further. Bullets are short; a
# paragraph that runs on is prose and needs sentence splitting.
LONG_UNIT = 240

# A SENTENCE BOUNDARY IS A PERIOD FOLLOWED BY WHITESPACE **NOT PRECEDED BY A
# CAPITAL LETTER**. "an active U.S. government security clearance is required"
# is one requirement; a naive `[^.]{0,40}` bound splits it into three fragments
# and none of them carries both the subject and the verb. This exact pattern
# has broken clearance detection in this project before.
_SENT = re.compile(r"(?<![A-Z])\.\s+")

# Bullets arrive as line breaks, and as "  - " / "  • " separators inside a line
# once the ATS HTML has been flattened.
_SPLIT = re.compile(r"[\r\n]+|(?:\s+[-•‣●·]\s+)")

_I = re.IGNORECASE


# A LINE THAT WRAPS IS STILL ONE CLAIM. This is the failure CLAUDE.md records
# against the first sentence-boundary fix, which "silently reclassified eleven
# Scale AI roles the wrong way because it stopped crossing newlines".
#
# It bit again here, on the single row this feature exists to get right:
#
#     Active U.S. security clearance at the Top Secret level, or
#     willingness to obtain or upgrade to a Top Secret clearance
#
# Split on the newline, unit one is "Active ... clearance ... or" — hard — and
# the escape hatch is stranded in unit two. Palantir's Forward Deployed Software
# Engineer goes red, which is the exact outcome per-bullet classification was
# chosen to prevent. A wrapped line is joined before anything is split.
_CONTINUES = re.compile(r"[,;:]$|\b(?:or|and|to|of|in|with|for|the|a|an)$", _I)
_ENDS = re.compile(r"[.!?:;]$")


def _joined(lines):
    """Re-join lines that the ATS wrapped mid-claim."""
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        prev = out[-1] if out else None
        starts_lower = line[:1].islower()
        if prev and not _ENDS.search(prev) and (starts_lower or _CONTINUES.search(prev)):
            out[-1] = prev + " " + line
        else:
            out.append(line)
    return out


def units(text):
    """The posting as the list of claims it actually makes."""
    out = []
    for chunk in _joined(_SPLIT.split(text or "")):
        if len(chunk) <= LONG_UNIT:
            out.append(chunk)
        else:
            out.extend(s.strip() for s in _SENT.split(chunk) if s.strip())
    return out


# A SECTION HEADING REACHES THE BULLETS UNDER IT. "PREFERRED QUALIFICATIONS" is
# its own line, and the "8+ years of experience" beneath it carries no qualifier
# of its own — so a strictly per-unit rule reads a wish as a requirement. Anduril
# and Saronic both write postings this way.
_PREFERRED_HEAD = re.compile(
    r"^\s*(?:preferred|nice[\s-]to[\s-]have|bonus|desired|plus(?:es)?)\b"
    r"[\w\s/&-]{0,30}:?\s*$", _I)
# Anything that ends a preferred section. A GENERIC heading also ends it: these
# blocks are short, and continuing to suppress past an unrelated heading would
# silently swallow real requirements further down.
_REQUIRED_HEAD = re.compile(
    r"^\s*(?:minimum|basic|required|requirements?|qualifications?|about\s+you"
    r"|what\s+you|who\s+you|responsibilities|you\s+(?:will|have)|skills"
    r"|experience|security\s+requirements?)\b[\w\s/&-]{0,30}:?\s*$", _I)


def _is_heading(unit):
    """('preferred'|'required'|None) for a line that is a section heading."""
    if len(unit) > 60:
        return None
    if _PREFERRED_HEAD.match(unit):
        return "preferred"
    if _REQUIRED_HEAD.match(unit):
        return "required"
    return None


# --------------------------------------------------------------- the patterns

# Any mention at all. Presence alone means nothing — what the unit SAYS about it
# is the classification.
_CLEARANCE_WORD = re.compile(
    r"\bclearance\b|\bts\s*/\s*sci\b|\bpolygraph\b|\bsci\s+eligib", _I)

# Held already, or demanded outright.
_CLEARANCE_HARD = re.compile(
    r"\bactive\b|\bcurrent(?:ly)?\b|\bexisting\b|\bin\s+hand\b"
    r"|\bmust\s+(?:hold|possess|have)\b"
    r"|\bclearance\s+(?:is\s+)?required\b", _I)

# Obtainable, and therefore NOT a blocker.
#
# `eligib(?:le|ility)` covers BOTH stems on purpose. CLAUDE.md records that
# `eligibilit[a-z]*` matches "eligibility for" but not "eligible for" — a
# different stem — and that one missing stem was a commit away from deleting
# Applied Intuition's entry-level "Software Engineer - Defense Physical AI",
# which says "Must hold or be eligible for a U.S. Secret security clearance".
_CLEARANCE_OK = re.compile(
    r"\bability\s+to\s+obtain\b|\bable\s+to\s+obtain\b|\bobtain\b"
    r"|\beligib(?:le|ility)\b|\bwilling(?:ness)?\b|\bqualify\b"
    r"|\bor\s+upgrade\b|\bwill\s+be\s+sponsored\b", _I)

# The unit is a wish, not a requirement.
_PREFERRED = re.compile(
    r"\bpreferred\b|\bnice[\s-]to[\s-]have\b|\bbonus\b|\ba\s+plus\b"
    r"|\bideally\b|\bdesirable\b", _I)

# A degree the owner does not hold. The template assumes a business degree
# (profile.json `owner.degree`), so a demand for CS / engineering / a
# scientific, quantitative or STEM field is a screen; a demand for "a
# bachelor's degree" is not, and is deliberately absent.
_DEGREE = re.compile(
    r"\bdegree\s+in\s+(?:a\s+|an\s+)?(?:relevant\s+)?"
    r"(?:computer\s+science|cs|engineering|scientific\s+field"
    r"|quantitative\s+field|stem)\b"
    r"|\b(?:b\.?s\.?|m\.?s\.?|b\.?a\.?|ph\.?\s?d\.?)"
    r"(?:\s*(?:,|/|\s+or)\s*(?:b\.?s\.?|m\.?s\.?|ph\.?\s?d\.?))*"
    r"\s+(?:degree\s+)?in\s+(?:computer\s+science|cs|stem)\b"
    r"|\bengineering\s+degree\b|\btechnical\s+degree\b|\bstem\s+degree\b", _I)

# The escape hatch that turns a degree line into a non-screen.
_EQUIVALENT = re.compile(
    r"\bor\s+equivalent\b|\bor\s+(?:a\s+)?related\s+(?:practical\s+)?experience\b"
    r"|\bor\s+comparable\b|\bin\s+lieu\s+of\b"
    r"|\bor\s+equivalent\s+practical\s+experience\b", _I)

# US citizenship. NOT a blocker — the owner is a citizen — but tagged so defense
# rows say so rather than leaving the reader to check.
_CITIZEN = re.compile(
    r"\bu\.?\s?s\.?\s+citizen(?:ship)?\b|\bu\.?\s?s\.?\s+person\b"
    r"|\bunited\s+states\s+citizen", _I)

# YEARS ARE EXTRACTED, THEN COMPARED IN CODE. "If code can decide it, code
# decides it" — triage once asked a model to compare a stated integer against a
# cutoff and it killed 2-year roles as "requires 3+ years" on ~5% of kills.
_YEARS = tuple(re.compile(p, _I) for p in (
    r"\b(\d{1,2})\s*\+\s*(?:years?|yrs?|yoe)\b",
    r"\b(?:minimum|at\s+least|min\.?)\s+(?:of\s+)?(\d{1,2})\s+(?:years?|yrs?)\b",
    r"\b(\d{1,2})\s*(?:-|–|to)\s*\d{1,2}\s+(?:years?|yrs?)\b",
    r"\b(\d{1,2})\s+or\s+more\s+(?:years?|yrs?)\b",
))


def years_in(unit):
    """Every year figure stated in one unit."""
    out = []
    for rx in _YEARS:
        for m in rx.finditer(unit):
            try:
                out.append(int(m.group(1)))
            except (TypeError, ValueError):
                pass
    return out


def classify(title, description, complete=True):
    """The tags for one role, and whether absence of a tag means anything.

    Returns {"tags": [...sorted...], "complete": bool}.

    `complete` in is whether the description is the full posting; `complete` out
    is the same value, carried so no caller can render a tagless row as clear
    without having been handed the reason it might not be.

    THE TITLE IS PREPENDED AS ITS OWN UNIT. Fifteen candidate roles state the
    requirement only there.
    """
    text = (title or "") + "\n" + (description or "")
    tags = set()
    clearance_hard = clearance_ok = False
    years = []

    in_preferred = False
    for u in units(text):
        head = _is_heading(u)
        if head:
            in_preferred = (head == "preferred")
            continue        # a heading states no requirement of its own

        # Either the bullet says so, or the section it sits under does.
        preferred = in_preferred or bool(_PREFERRED.search(u))

        # A degree demanded in this unit, unless this unit softens it.
        if _DEGREE.search(u) and not preferred and not _EQUIVALENT.search(u):
            tags.add("cs_degree")

        if _CLEARANCE_WORD.search(u):
            # OBTAINABLE WINS OVER HARD WITHIN A UNIT. "Active clearance, or
            # ability to obtain one" is obtainable — the sentence offers the
            # path, and reading only its first half is how the Palantir role
            # went red. Order matters here and the test asserts it.
            if _CLEARANCE_OK.search(u) or preferred:
                clearance_ok = True
            elif _CLEARANCE_HARD.search(u):
                clearance_hard = True

        if _CITIZEN.search(u):
            tags.add("citizenship_only")

        # Years stated in a PREFERRED bullet are not the bar to clear.
        if not preferred:
            years.extend(years_in(u))

    # ANY hard unit outranks every obtainable one: a posting that demands an
    # active clearance in one bullet is not made reachable by another bullet
    # elsewhere offering to sponsor a different one.
    if clearance_hard:
        tags.add("clearance")
    elif clearance_ok:
        tags.add("clearance_obtainable")

    # THE LOWEST FIGURE IS THE BAR. A posting saying "3+ years" in one bullet
    # and "8+ years" in another is asking for 3; taking the max would tag it an
    # eight-year role and be wrong.
    if years and min(years) >= YEARS_BLOCK_AT:
        tags.add("years_4plus")

    return {"tags": sorted(tags), "complete": bool(complete)}


def hard_tags(tags):
    """Only the ones that actually screen the owner out."""
    return [t for t in (tags or []) if t in HARD]


def is_clear(result):
    """True only when the text was COMPLETE and carried no hard blocker.

    A truncated row with no tags is `unknown`, never clear. This function is the
    one place that distinction is decided, so no surface can get it wrong by
    checking `not tags` and forgetting the other half.
    """
    if not result or not result.get("complete"):
        return False
    return not hard_tags(result.get("tags"))
