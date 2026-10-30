#!/usr/bin/env python3
"""Draft an application pack for every eligible role. Sonnet, Batch API, cached.

  python apply_packs.py --dry-run     # what it would send, and what it costs
  python apply_packs.py submit        # send the batch
  python apply_packs.py collect       # store what came back
  python apply_packs.py status        # packs, used and untouched

WHAT A PACK IS. The resume variant to use and why, a 150-word cover note, and
drafted answers to the four prompts every application asks. It removes the blank
page. The owner reads, edits and sends -- there is no send path here and there
must not be.

GROUNDED IN WHAT IS TRUE AND NOTHING ELSE. The system prompt carries
projects.md, both resume variants and profile.json, and the rules say plainly
that anything not in them may not be written. This is the same constraint as
"never invent resume content", on a surface where the output goes to a
recruiter: a fabricated number in a cover note is worse than no cover note.

THE VARIANT IS CHOSEN IN CODE. web/lib/variant.js maps company category to tech
or finance; that lookup is not a judgement and is not the model's. The model
writes the one-line reason for a decision already made, and when no rule matches
the pack says so instead of guessing.

CACHING IS THE WHOLE COST STORY. The shared prefix -- profile, both resumes, the
rules -- is about 12,000 tokens and is identical for every role; only the posting
varies. With cache_control it is written once and read at a tenth of the price
for the rest of the batch. Without it, 141 roles would each pay full price for
the same 12,000 tokens.
"""
import argparse
import io
import json
import os
import re
import sys

import fetch_jobs
from console import utf8_stdout
from owner import OWNER
from paths import repo

# Batch API, always. Synchronous is double the price for the same result.
MODEL = os.environ.get("JOBOPS_PACK_MODEL", "claude-sonnet-5")
BATCH_DISCOUNT = 0.5

# Per-run abort. Set by the owner for this job specifically; the scoring job's is $1.
PER_RUN_ABORT = 8.00

# Output tokens the estimator assumes per role. Checked against measured
# usage after every collect, so a wrong assumption is visible rather than
# quietly repriced. The first batch assumed 1,200 and measured 2,810.
OUT_PER_ROLE_HINT = 1800

# ADAPTIVE THINKING COUNTS AGAINST THIS, AND 3000 WAS NOT ENOUGH.
#
# The first batch came back with stop_reason=max_tokens on all 124 responses,
# output_tokens pinned at exactly 3000, and 92 of them unparseable -- 12 with no
# text block at all, because thinking had eaten the entire budget before a single
# character of the answer.
#
# CLAUDE.md predicted this in as many words: "Budget generously (3000+ for
# structured output) ... This will bite again in tailor.py, which generates far
# longer output than a score object." A pack is six fields of prose. 3000 was the
# floor quoted for a score OBJECT and was read as if it were a ceiling for
# anything.
#
# 8000 with effort held low: the real answers ran 1,500 to 2,500 characters of
# JSON, so this is roughly three times the largest one and leaves room for
# thinking without the thinking being the point.
MAX_TOKENS = 8000

# Thinking depth. Low, because the judgement here is small -- select true things
# and write them plainly -- and the budget is better spent on the answer. Sonnet
# accepts this; Haiku rejects output_config.effort outright and errors the whole
# batch, which is why the model default here is Sonnet and not shared with the
# scorer.
EFFORT = "low"

# PROMPT CACHING, OFF.
#
# It was on, and the first batch measured it costing about 11% MORE than not
# caching. The model in the head of this file said "written once and read at a
# tenth of the price for the rest of the batch"; the run recorded 813,888
# cache-creation tokens against 587,808 read -- roughly 104 writes and 75 reads
# across 124 requests. Batch requests run in parallel, so every worker starting
# before the cache is warm writes the prefix itself, and an ephemeral cache
# expires inside a batch that takes forty minutes.
#
# The dry-run still prints both figures. If the batch shape changes -- smaller
# batches, submitted closer together, finishing inside the cache TTL -- the
# comparison will say so, and this goes back on.
CACHE = os.environ.get("JOBOPS_PACK_CACHE", "0") == "1"
POSTING_CHARS = 6000    # of the posting, trimmed

# The four prompts every application asks, in the order they are rendered.
PROMPTS = [
    ("why_company", "Why this company"),
    ("why_role", "Why this role"),
    ("project_story", "Describe a project you built"),
    ("biggest_challenge", "Biggest challenge"),
]

# Blockers that do NOT disqualify a role from being packed. A clearance the
# owner can obtain is not a wall, and US citizenship is not a constraint for a
# US citizen.
OK_BLOCKERS = {"clearance_obtainable", "citizenship_only"}

def _plain(s):
    """profile.json prose made safe for a prompt that forbids em dashes and
    brackets. The rules below are checked against themselves by
    test_apply_packs.py, so a value copied in from profile.json must obey them
    too."""
    s = str(s or "").replace("—", ", ").replace("–", "-")
    return s.replace("[", "").replace("]", "").replace("  ", " ").strip()


# WHO THE CANDIDATE IS comes from profile.json through owner.py, never from a
# literal here. The template was written for one person and had their name,
# school and class year typed into this prompt, which is exactly the kind of
# thing that survives a copy and then quietly produces someone else's cover
# letter. Every other rule is verbatim.
_RULE_6 = (
    f"6. They are a {OWNER['school_short']} {OWNER['class_label']}, class of "
    f"{OWNER['grad_year']}, graduating {OWNER['graduation']}, looking for\n"
    f"   full-time work starting summer {OWNER['grad_year']}. They are not "
    f"available before then. Do not\n"
    f"   write as though they could start now. Their stated target: "
    f"{_plain(OWNER['target_start'])}"
)

RULES = f"""You are drafting application material for {OWNER['name']}. You write in
their voice: direct, concrete, numbers first, no buzzwords.

HARD RULES, in order of importance.

1. INVENT NOTHING. Every fact, number, employer, date and claim must appear in
   the material above. If you want a number that is not there, cut the clause.
   Do not estimate, round up, or infer a metric. Do not describe work they have
   not done. A fabricated detail in a cover note is worse than a shorter cover note.

2. NEVER CLAIM A CLEARANCE. You may write that they are a US citizen requiring no
   sponsorship, that they hold no clearance, that they know of no disqualifying
   factors, and that they are willing to undergo the process. You may NEVER write
   or imply that they are cleared, hold an active clearance, or are
   "clearance-eligible" as though that were decided. Eligibility is determined
   by a government adjudicator, not by the candidate.

3. NO EM DASHES. Not anywhere, in any field. Use a full stop or a comma.

4. NO SQUARE BRACKETS. No placeholders, no "[insert X]", no "[ASK THE CANDIDATE]". If a
   detail is missing, write the sentence without it.

5. NO MANUFACTURED WARMTH. Do not write that they have followed the company's
   work, admired anything, or been inspired. They may state a fact about the
   company taken from the posting, or something they have genuinely built or used.

{_RULE_6}

WHAT TO PRODUCE. Reply with ONE JSON object and nothing else:

{{
  "variant_reason": "one sentence, under 25 words, on why this resume variant
                     suits this role. The choice is already made; explain it.",
  "cover_note": "150 words maximum. Specific to this posting. Opens with why
                 them for this role, not with pleasantries.",
  "why_company": "120 words maximum.",
  "why_role": "120 words maximum.",
  "project_story": "150 words maximum. One project, what it did, what it cost
                    or earned, what they learned.",
  "biggest_challenge": "150 words maximum. A real difficulty and what they did."
}}
"""


def _read(path):
    with io.open(repo(path), encoding="utf-8") as fh:
        return fh.read()


VOICE_SAMPLE = "cover_letter_example.md"


def voice_sample():
    """The owner's own cover letter, if they supplied one. Optional.

    A VOICE SAMPLE, NOT A FACT SOURCE, and the prompt says so: the model
    imitates the register and sentence shape, and never reuses a claim from
    it -- the letter was written for one posting and its claims belong to that
    posting. Absent, the packs are written in the profile's voice_notes alone,
    which is what the original did.
    """
    path = repo(VOICE_SAMPLE)
    if not os.path.exists(path):
        return ""
    text = _read(path).strip()
    if len(text) < 300:
        return ""
    return ("=== VOICE SAMPLE: A COVER LETTER THE OWNER WROTE (cover_letter_example.md) ===\n"
            "Imitate its voice, sentence length and directness. NEVER reuse a claim, "
            "number, employer or story from it unless the same fact appears in "
            "profile.json or a resume above; it was written for a different posting.\n\n"
            + text)


def system_text():
    """The cached prefix: identical for every role in the batch.

    ORDER MATTERS FOR CACHING. The prefix must be byte-identical across
    requests or every one of them pays the write price. Nothing role-specific
    goes in here, and nothing here is formatted with a value that varies.
    """
    return "\n\n".join([
        f"=== WHO {OWNER['first_name'].upper()} IS (profile.json) ===",
        _read("profile.json"),
        "=== THEIR PROJECTS AND THE GAPS IN THEM (projects.md) ===",
        _read("projects.md"),
        "=== RESUME, TECH VARIANT (resume_tech.md) ===",
        _read("resume_tech.md"),
        "=== RESUME, FINANCE VARIANT (resume_finance.md) ===",
        _read("resume_finance.md"),
        voice_sample(),
        "=== RULES ===",
        RULES,
    ])


def variant_for(category):
    """tech or finance, from the company category. NULL when no rule matches.

    The map is web/lib/variant.js's, kept in step by test_apply_packs.py rather
    than by memory -- two spellings of one lookup is how they drift.
    """
    return {"defense": "tech", "product": "tech",
            "consulting": "finance", "vc": "finance"}.get(category)


def eligible(con, limit=None):
    """Open, scored 60+, no hard blocker, no pack yet.

    THE BLOCKER TEST IS THE INTERESTING ONE. A role is eligible when its tags
    contain no HARD blocker -- clearance_obtainable and citizenship_only do not
    disqualify, because neither is a wall for the owner. A role whose text was
    truncated has unknown blockers and is NOT packed: spending money drafting
    for a role that may demand a CS degree is exactly the waste this avoids.
    """
    rows = con.execute(
        "SELECT j.key, j.company, COALESCE(j.display_name, j.company) AS name, "
        "       j.title, j.location, j.url, j.description, j.category, "
        "       j.blockers, j.blockers_full_text, s.score "
        "  FROM jobs j JOIN scores s ON s.key = j.key "
        " WHERE j.closed_at IS NULL AND s.score >= 60 "
        # A pack whose response did not parse counts as MISSING, not done. The
        # raw is kept so nothing is lost, but a row with no cover note is not a
        # pack and must be regenerated rather than sitting there looking packed.
        "   AND j.key NOT IN (SELECT key FROM apply_packs "
        "                      WHERE cover_note IS NOT NULL)"
    ).fetchall()

    out = []
    for r in rows:
        try:
            tags = json.loads(r["blockers"] or "[]")
        except (TypeError, ValueError):
            # UNPARSEABLE IS NOT CLEAN. Skip rather than pack blind.
            continue
        hard = [t for t in tags if t not in OK_BLOCKERS]
        if hard:
            continue
        if r["blockers_full_text"] != 1:
            continue        # unknown blockers: not eligible, not an error
        out.append(r)

    out.sort(key=lambda r: (-(r["score"] or 0), r["key"]))
    return out[:limit] if limit else out


def user_text(r):
    desc = (r["description"] or "")[:POSTING_CHARS]
    v = variant_for(r["category"])
    return (
        f"COMPANY: {r['name']}\n"
        f"TITLE: {r['title']}\n"
        f"LOCATION: {r['location']}\n"
        f"RESUME VARIANT ALREADY CHOSEN FOR THIS ROLE: "
        f"{v or 'none (no rule for this category; say so plainly)'}\n\n"
        f"POSTING:\n{desc}\n"
    )


def build_requests(rows):
    """One batch request per role. The system block carries cache_control."""
    sys_text = system_text()
    reqs, keymap = [], {}
    for i, r in enumerate(rows):
        cid = f"pack-{i}"
        keymap[cid] = r["key"]
        reqs.append({
            "custom_id": cid,
            "params": {
                "model": MODEL,
                "max_tokens": MAX_TOKENS,
                # THE CACHE BREAKPOINT. Everything before it is identical across
                # every request in the batch, so it is written once and read at
                # a tenth of the price for the other 140.
                "system": ([{"type": "text", "text": sys_text,
                             "cache_control": {"type": "ephemeral"}}]
                           if CACHE else sys_text),
                "output_config": {"effort": EFFORT},
                "messages": [{"role": "user", "content": user_text(r)}],
            },
        })
    return reqs, keymap


# Sonnet pricing, dollars per million tokens: (input, output). Cache writes cost
# 1.25x input, cache reads 0.1x. Batch halves everything.
PRICE = {"claude-sonnet-5": (3.00, 15.00), "claude-opus-5": (15.00, 75.00),
         "claude-haiku-4-5-20251001": (1.00, 5.00)}


def estimate(reqs):
    """What this batch costs, from the requests that would actually be sent.

    Measured off the real request objects rather than a hand-written query
    describing them: "an estimate that can disagree with the run is decoration",
    and the last hand-written one under-reported by 3x because it priced roles
    where the code sent samples.
    """
    if not reqs:
        return {"n": 0, "cost": 0.0, "cached": 0, "per_role": 0, "out": 0}
    approx = lambda s: max(1, len(s) // 4)          # ~4 chars per token
    sysblk = reqs[0]["params"]["system"]
    cached = approx(sysblk[0]["text"] if isinstance(sysblk, list) else sysblk)
    per_role = sum(approx(m["content"]) for m in reqs[0]["params"]["messages"])

    # THE RATE COMES FROM THE REQUESTS, not from the module global. They are
    # the same value today -- build_requests sets "model": MODEL -- and reading
    # it from the object that will actually be sent is what keeps them the same
    # tomorrow. "An estimate that can disagree with the run is decoration"
    # applies to the model as much as to the request count.
    #
    # AN UNPRICED MODEL RAISES. It used to fall back to Sonnet's rate, which
    # silently mispriced anything else -- and this number is what gets checked
    # against the $5 cap, so a wrong one does not just misinform, it decides.
    # There is no safe direction to guess in: too low spends money the cap was
    # meant to stop, too high blocks a run that was affordable.
    est_model = reqs[0]["params"]["model"]
    if est_model not in PRICE:
        raise SystemExit(
            f"No price for {est_model}. Add it to PRICE in apply_packs.py "
            f"before submitting -- an unpriced model cannot be checked against "
            f"the monthly cap.")
    inp, outp = PRICE[est_model]
    n = len(reqs)

    # THESE TWO NUMBERS ARE MEASURED, NOT ASSUMED, and the first version of this
    # function assumed both and was wrong by 3.1x -- it said $1.45 and the run
    # cost $4.52. "An estimate that can disagree with the run is decoration."
    #
    # OUT_PER_ROLE. The first batch hit stop_reason=max_tokens on all 124
    # responses at exactly 3,000 output tokens; the guess had been 1,200. With
    # MAX_TOKENS raised and effort held low the answers should land near 1,800,
    # but that is the number to CHECK against the next run's measured usage
    # rather than to trust.
    #
    # CACHE_WRITES_PER_ROLE is the one that is genuinely counter-intuitive. The
    # model was "one write, then n-1 reads at 10%". The batch actually recorded
    # 813,888 cache-creation tokens against 587,808 cache-read -- about 104
    # writes and 75 reads across 124 requests, not 1 and 123. Batch requests run
    # in parallel, so every worker that starts before the cache is warm writes
    # it, and the ephemeral cache expires while a batch of this length is still
    # running. Caching still helped, but nothing like tenfold.
    OUT_PER_ROLE = OUT_PER_ROLE_HINT
    CACHE_WRITES_PER_ROLE = 0.84
    CACHE_READS_PER_ROLE = 0.61

    role_in = per_role * n * inp / 1e6
    out_cost = OUT_PER_ROLE * n * outp / 1e6
    uncached = ((cached + per_role) * n * inp / 1e6 + out_cost) * BATCH_DISCOUNT

    if CACHE:
        cache_write = cached * CACHE_WRITES_PER_ROLE * n * 1.25 * inp / 1e6
        cache_read = cached * CACHE_READS_PER_ROLE * n * 0.10 * inp / 1e6
        cost = (cache_write + cache_read + role_in + out_cost) * BATCH_DISCOUNT
    else:
        cost = uncached
    # The COUNTERFACTUAL, always computed, so the dry-run can print the
    # comparison whichever way CACHE is set. Turning caching off without keeping
    # the number would mean never noticing if the batch shape changed back.
    if CACHE:
        cached_cost = cost
    else:
        cw = cached * CACHE_WRITES_PER_ROLE * n * 1.25 * inp / 1e6
        cr = cached * CACHE_READS_PER_ROLE * n * 0.10 * inp / 1e6
        cached_cost = (cw + cr + role_in + out_cost) * BATCH_DISCOUNT
    return {"n": n, "cost": cost, "cached": cached, "per_role": per_role,
            "out": OUT_PER_ROLE, "uncached_cost": uncached,
            "cached_cost": cached_cost}


def print_plan(rows, reqs, est):
    print(f"  model        {MODEL}")
    print(f"  roles        {len(rows)}  (open, 60+, no hard blocker, no pack)")
    print(f"  requests     {est['n']}  (one per role)")
    print(f"  shared prefix{est['cached']:>8,} tokens per request, "
          f"caching {'ON' if CACHE else 'OFF'}")
    print(f"  per role     {est['per_role']:,} in + ~{est['out']:,} out")
    print(f"  mode         batch (50% off)"
          + (" + prompt caching" if CACHE else ", no caching"))
    # BOTH FIGURES, EVERY RUN. Caching is off because it measured 11% WORSE at
    # this batch shape; keeping the comparison is how we would notice that
    # changing rather than assuming it never will.
    d = est["cached_cost"] - est["uncached_cost"]
    verdict = (f"caching would cost {abs(d) / est['uncached_cost'] * 100:.0f}% "
               + ("MORE" if d > 0 else "LESS"))
    print(f"  estimate     ${est['cost']:.2f}"
          f"   (uncached ${est['uncached_cost']:.2f}, "
          f"cached ${est['cached_cost']:.2f} -- {verdict})")
    print(f"  per-run abort ${PER_RUN_ABORT:.2f}")


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="dry-run",
                    choices=["dry-run", "submit", "collect", "status"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    cmd = "dry-run" if a.dry_run else a.cmd

    con = fetch_jobs.db()

    if cmd == "status":
        n = con.execute("SELECT COUNT(*) c FROM apply_packs").fetchone()["c"]
        used = con.execute(
            "SELECT COUNT(*) c FROM apply_packs WHERE used_at IS NOT NULL"
        ).fetchone()["c"]
        print(f"{n} packs, {used} opened, {n - used} untouched")
        return 0

    rows = eligible(con, a.limit)
    reqs, keymap = build_requests(rows)
    est = estimate(reqs)

    print()
    print_plan(rows, reqs, est)

    if not rows:
        # A RUN THAT PACKED NOTHING WHEN THERE IS NOTHING TO PACK IS FINE, and a
        # run that packed nothing when there IS is a failure. The digest tells
        # those apart; here it is enough to say which happened.
        print("\nNothing eligible: every 60+ role with clear blockers already "
              "has a pack.")
        return 0

    if est["cost"] > PER_RUN_ABORT:
        print(f"\nREFUSING: ${est['cost']:.2f} is over the ${PER_RUN_ABORT:.2f} "
              f"per-run abort for this job. Narrow it with --limit.")
        return 1

    if cmd == "dry-run":
        print("\n--dry-run: nothing sent.")
        print("\nFirst request, exactly as it would go (posting trimmed):")
        first = reqs[0]
        print(f"  custom_id: {first['custom_id']}  ->  {keymap[first['custom_id']]}")
        print("  " + first["params"]["messages"][0]["content"][:400].replace("\n", "\n  "))
        return 0

    if cmd == "submit":
        return do_submit(con, reqs, keymap, est)
    if cmd == "collect":
        return do_collect(con)
    return 1


def do_submit(con, reqs, keymap, est):
    import anthropic
    # THE PIPELINE'S KEY, not the app's. web/lib/ask.js reads
    # JOBOPS_ANTHROPIC_KEY and nothing else; the CLI side uses
    # ANTHROPIC_API_KEY. Keeping them apart is what makes the Ask box's cap
    # meaningful, and this is the CLI side.
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("REFUSING: ANTHROPIC_API_KEY is not set.")
        return 1

    client = anthropic.Anthropic()
    batch = client.messages.batches.create(requests=reqs)
    con.execute(
        "INSERT INTO batches (batch_id, stage, model, n, submitted_at, keymap) "
        "VALUES (?,?,?,?,?,?)",
        (batch.id, "pack", MODEL, len(reqs), fetch_jobs.now(),
         json.dumps(keymap)))
    con.commit()
    print(f"\nSubmitted {batch.id} ({batch.processing_status}).")
    print("Collect with: python apply_packs.py collect")
    return 0


def _parse(text):
    """Pull the JSON object out of a response that may carry prose around it.

    The first balanced {...} block, not a bare json.loads. Models honour
    "respond with ONLY JSON" about half the time, and this exact parser took
    scoring from 27/50 to 50/50 -- there is no reason to relearn that here.
    """
    depth = start = 0
    for i, ch in enumerate(text or ""):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except ValueError:
                    return None
    return None


_EM_DASH = re.compile("[—–]")


def _clean(s):
    """Enforce the two rules a model reliably breaks, in code.

    "If code can decide it, code decides it." Asking for no em dashes gets them
    most of the time; removing them gets it every time. Same for brackets: a
    square-bracket placeholder must never reach a human, so any field still
    carrying one is REJECTED rather than silently shipped with a hole in it.
    """
    if s is None:
        return None
    s = _EM_DASH.sub(", ", str(s)).replace("  ", " ").strip()
    return s


def _measured():
    return {"n": 0, "in": 0, "out": 0, "cw": 0, "cr": 0, "capped": 0}


# ---------------------------------------------------------------------------
# THE CLEARANCE RULE, ON THE WAY INTO THE TABLE.
#
# CLAUDE.md calls this "the highest-stakes place in this pipeline to get wrong":
# a pack is the only model-generated text in the tool that goes to an EMPLOYER,
# and asserting an adjudication nobody has made is a false claim on a defense
# application. The predicate already guarded the resume, the profile card, the
# SF-86 page and Why -- every surface except this one.
#
# ONE DEFINITION, READ FROM THE JS. The patterns are parsed out of
# web/lib/clearance.js rather than retyped, the same way test_apply_packs.py
# reads the variant map: a rule spelled twice is a rule with two chances to rot,
# and this one has already gone inert once when a heredoc turned its escapes
# into control bytes.
_CLEARANCE_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "web", "lib", "clearance.js")


def _clearance_patterns():
    """(assertions, possession) source lists, from the JS. Never a copy."""
    src = io.open(_CLEARANCE_JS, encoding="utf-8").read()
    out = {}
    for name in ("ASSERTION_SOURCES", "POSSESSION_SOURCES"):
        m = re.search(name + r"\s*=\s*\[(.*?)\n\];", src, re.S)
        if not m:
            raise SystemExit(
                f"apply_packs: cannot find {name} in web/lib/clearance.js. "
                f"The clearance rule is the one thing here that must not be "
                f"skipped when it cannot be read.")
        out[name] = re.findall(r"String\.raw`([^`]+)`", m.group(1))
        if not out[name]:
            raise SystemExit(f"apply_packs: {name} parsed to zero patterns.")
    return out["ASSERTION_SOURCES"], out["POSSESSION_SOURCES"]


_ASSERT_SRC, _POSSESS_SRC = _clearance_patterns()
# JS writes `ts\/sci`; the escaped slash is redundant in Python and, in a
# character-class-free pattern, simply noise. Strip it rather than leaving a
# construct whose meaning differs between the two engines.
_py = lambda p: p.replace(r"\/", "/")
_FORBIDDEN = re.compile("|".join(_py(p) for p in _ASSERT_SRC + _POSSESS_SRC), re.I)
_POSSESSION = re.compile("|".join(_py(p) for p in _POSSESS_SRC), re.I)
# Mirrors NEGATOR in clearance.js: a denial attached to the phrase, at most two
# words away. "I have no active clearance" is the sentence the owner is REQUIRED
# to be able to write; only possession phrases are negatable, so a stray "no" cannot
# excuse "is cleared".
_NEGATOR = re.compile(r"\b(?:no|not|never|without|lacks?|lacking|nor)\b"
                      r"(?:\s+\w+){0,2}\s*$", re.I)


def clearance_claim(text):
    """The offending phrase, or None. A denial is not a claim."""
    s = str(text or "")
    for m in _FORBIDDEN.finditer(s):
        if _POSSESSION.fullmatch(m.group(0)) and _NEGATOR.search(s[:m.start()]):
            continue
        return m.group(0)
    return None


def pack_violation(obj):
    """Why this pack must not be stored, or None.

    REJECTED, NOT CLEANED. _clean strips em dashes and is right to, because a
    dash is formatting. A clearance claim is a false statement of fact and a
    bracket is a hole where a number should be -- neither can be fixed by
    editing the string, so the pack goes back in the queue instead. The raw is
    kept, as with a parse failure: it is paid for, and the next run re-packs
    the role because cover_note stays NULL.
    """
    for field, _ in [("variant_reason", None), ("cover_note", None)] + list(PROMPTS):
        v = obj.get(field)
        if not v:
            continue
        hit = clearance_claim(v)
        if hit:
            return f"{field} claims {hit!r}"
        # NEVER EMIT A BRACKET. CLAUDE.md: no square-bracket placeholder reaches
        # any output -- not a missing number, not an "ask the owner" marker. A pack
        # rendered with "[X%]" in it is worse than one that is missing.
        # `+`, not `{2,}`: the single-character placeholder is the COMMON one
        # -- "[X]%", "[N] users" -- and a two-character floor let every
        # one of them through.
        b = re.search(r"\[[^\]]+\]", str(v))
        if b:
            return f"{field} contains the placeholder {b.group(0)!r}"
    return None


def do_collect(con, client=None):
    """Collect finished pack batches.

    `client` is injectable so the two branches that are painful to reach
    against the real API -- a batch still running, and a batch whose results
    span more than one model -- can be exercised by a fake. It defaults to the
    real client, so every caller in the tool is unchanged. See
    test_apply_packs.py.
    """
    if client is None:
        import anthropic
        client = anthropic.Anthropic()
    rows = con.execute(
        "SELECT batch_id, model, keymap FROM batches "
        "WHERE stage = ? AND collected_at IS NULL", ("pack",)).fetchall()
    if not rows:
        print("No uncollected pack batches.")
        return 0

    total = bad = refused = 0
    # USAGE IS ACCUMULATED PER MODEL, never in one pile. Two batches collected
    # in the same run can carry different models -- that is the whole reason
    # `model` is a column on `batches` -- and pricing a mixed pile at one rate
    # is the cost-side twin of the bug that put 500 Haiku responses in the
    # table as Sonnet. Haiku and Opus differ 15x on input; a single total would
    # be wrong by whatever the mix happened to be.
    measured = {}
    waiting = 0
    for b in rows:
        keymap = json.loads(b["keymap"])
        # THE MODEL COMES FROM THE BATCH ROW, never from the process default.
        # collect runs in its own process where MODEL reverts, and that silently
        # stored 500 Haiku responses as Sonnet once.
        model = b["model"]

        # A BATCH STILL RUNNING IS SKIPPED, NOT AN ERROR. Two batches can be
        # outstanding at once -- a sample and the rest -- and asking for the
        # results of an unfinished one raises, which used to abort the whole
        # command and take the finished batches down with it.
        # Snapshot this model's totals BEFORE the batch, so the row can be
        # written with what THIS batch used rather than the run's running sum.
        before = dict(measured.get(model, _measured()))
        state = client.messages.batches.retrieve(b["batch_id"])
        if state.processing_status != "ended":
            print(f"  {b['batch_id']}: still {state.processing_status}, skipping.")
            waiting += 1
            continue

        for res in client.messages.batches.results(b["batch_id"]):
            key = keymap.get(res.custom_id)
            if not key:
                continue
            text = ""
            if getattr(res.result, "type", "") == "succeeded":
                m = res.result.message
                for blk in m.content:
                    if getattr(blk, "type", "") == "text":
                        text += blk.text
                u = m.usage
                mm = measured.setdefault(model, _measured())
                mm["n"] += 1
                mm["in"] += u.input_tokens
                mm["out"] += u.output_tokens
                mm["cw"] += getattr(u, "cache_creation_input_tokens", 0) or 0
                mm["cr"] += getattr(u, "cache_read_input_tokens", 0) or 0
                if getattr(m, "stop_reason", "") == "max_tokens":
                    mm["capped"] += 1
            obj = _parse(text)
            # A pack that breaks a hard rule is treated exactly like one
            # that would not parse: raw kept, structured fields left NULL,
            # role re-queued. Storing it with the bad clause removed would
            # be worse -- the rest of the answer was written around it.
            why = pack_violation(obj) if obj else None
            if why:
                print(f"  REFUSED {key}: {why}")
                refused += 1
                obj = None
            if not obj:
                # FAIL OPEN: keep the raw text. It is already paid for, and a
                # pack that failed to parse is still evidence of what came back.
                con.execute(
                    "INSERT INTO apply_packs (key, model, batch_id, created_at, raw) "
                    "VALUES (?,?,?,?,?) ON CONFLICT (key) DO UPDATE SET raw=excluded.raw",
                    (key, model, b["batch_id"], fetch_jobs.now(), text[:8000]))
                bad += 1
                continue
            cat = con.execute(
                "SELECT category FROM jobs WHERE key = ?", (key,)).fetchone()
            vals = {f: _clean(obj.get(f)) for f, _ in PROMPTS}
            con.execute(
                "INSERT INTO apply_packs (key, variant, variant_reason, cover_note,"
                " why_company, why_role, project_story, biggest_challenge,"
                " model, batch_id, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT (key) DO UPDATE SET"
                "   variant=excluded.variant, variant_reason=excluded.variant_reason,"
                "   cover_note=excluded.cover_note, why_company=excluded.why_company,"
                "   why_role=excluded.why_role, project_story=excluded.project_story,"
                "   biggest_challenge=excluded.biggest_challenge,"
                "   model=excluded.model, batch_id=excluded.batch_id,"
                "   created_at=excluded.created_at, raw=NULL",
                (key, variant_for(cat["category"] if cat else None),
                 _clean(obj.get("variant_reason")), _clean(obj.get("cover_note")),
                 vals["why_company"], vals["why_role"], vals["project_story"],
                 vals["biggest_challenge"], model, b["batch_id"], fetch_jobs.now()))
            total += 1
        # THE MEASURED USAGE GOES BACK ON THE ROW.
        #
        # Without it the cost meter prices this batch from mean token shapes
        # and reads LOW: $1.60 against $3.53 actually spent, a 2x under-report
        # on the number the owner checks before deciding what they can afford. That
        # is the "$29.88 / $5.00" shape -- a figure that looks authoritative
        # and is not -- pointing the other way, which is worse, because an
        # under-report never prompts anyone to look.
        # THE DELTA FOR THIS BATCH, not the running total. `measured` accumulates
        # across every batch in the run keyed by model, so writing it straight
        # would give the second batch of a model the first one's tokens as well.
        now_mm = measured.get(model, _measured())
        d = {k: now_mm[k] - before.get(k, 0) for k in now_mm}
        con.execute(
            "UPDATE batches SET collected_at = ?, in_tok = ?, out_tok = ?, "
            " cache_w_tok = ?, cache_r_tok = ? WHERE batch_id = ?",
            (fetch_jobs.now(), d["in"], d["out"], d["cw"], d["cr"],
             b["batch_id"]))
        con.commit()

    print(f"{total} packs stored, {bad} unparseable (raw kept)."
          + (f" {refused} REFUSED on a hard rule." if refused else "")
          + (f" {waiting} batch(es) still running." if waiting else ""))

    # WHAT IT ACTUALLY COST, FROM USAGE, printed beside what was estimated.
    #
    # The first batch was estimated at $1.45 and cost $4.52, and nothing in this
    # tool said so -- the number had to be dug out by hand afterwards. An
    # estimate nobody checks against the run is how the same 3x happens twice.
    # EVERY RATE COMES FROM THE BATCH'S OWN MODEL. There is no process default
    # in this path: `MODEL` is what the NEXT submission would use, which has
    # nothing to do with what these responses were produced by.
    #
    # AN UNPRICED MODEL IS REPORTED, NOT GUESSED. The old line ended
    # `PRICE.get(MODEL, PRICE["claude-sonnet-5"])`, so a model absent from
    # PRICE was silently billed at Sonnet's rate -- a wrong number wearing the
    # authority of a measurement, on the meter that decides whether the owner can
    # afford to run anything. "A default that changes what a number MEANS is
    # worse than a crash." The tokens are still printed; only the dollar figure
    # is withheld, because that is the part nobody can check by eye.
    if measured:
        grand, unpriced = 0.0, []
        print(f"\nMEASURED from usage, per model:")
        for model_name in sorted(measured):
            mm = measured[model_name]
            rate = PRICE.get(model_name)
            print(f"  {model_name}  ({mm['n']} responses)")
            print(f"    input {mm['in']:,}  output {mm['out']:,}"
                  f"  cache-write {mm['cw']:,}  cache-read {mm['cr']:,}")
            if rate is None:
                unpriced.append(model_name)
                print(f"    actual cost  UNPRICED, no rate for this model in "
                      f"PRICE. Tokens above are real; add the rate to price it.")
            else:
                inp, outp = rate
                real = ((mm["in"] * inp + mm["out"] * outp
                         + mm["cw"] * inp * 1.25 + mm["cr"] * inp * 0.10)
                        / 1e6 * BATCH_DISCOUNT)
                grand += real
                print(f"    actual cost  ${real:.2f}")
            print(f"    out/role     {mm['out'] // max(mm['n'], 1):,}"
                  f"   (the estimator assumes {OUT_PER_ROLE_HINT:,})")
            if mm["capped"]:
                print(f"    WARNING: {mm['capped']} of {mm['n']} responses hit "
                      f"max_tokens. Raise MAX_TOKENS or lower EFFORT; a capped "
                      f"response is where the 92 unparseable ones came from.")
        # The total says out loud when it is not the whole bill, so a partial
        # figure can never be read as a complete one.
        if len(measured) > 1 or unpriced:
            note = (f"  (EXCLUDES {', '.join(unpriced)} -- unpriced)"
                    if unpriced else "")
            print(f"  TOTAL across {len(measured)} models  ${grand:.2f}{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
