#!/usr/bin/env python3
"""Interview prep for one role, generated once, when a status reaches interview.

  python prep_pack.py build <key> --dry-run    # cost, then stop
  python prep_pack.py build <key>              # one synchronous request
  python prep_pack.py due                      # roles at interview with no pack

ZERO COST UNTIL A STATUS FLIPS. Nothing here runs on a schedule and nothing runs
over the corpus. `due` reads the lifecycle table and prints what WOULD be built;
building is a deliberate command for one role. A generator that fires on every
scored role would cost more than the interviews are worth.

SYNCHRONOUS, WHICH BREAKS "Batch API always". A batch takes minutes to hours and
this is wanted the moment an interview is booked; a pack that arrives tomorrow
is a pack the owner prepared without. That doubles the per-request price to
about three cents. Priced, stated, accepted -- the same trade the Ask box makes,
for the same reason.

SONNET, because this is prose the owner will read and partly say out loud. The
model policy puts classification on Haiku and anything reaching a human on Sonnet.

WHAT IT MAY USE. profile.json, projects.md, both resumes, and the posting. That
is all. It does not research the company, because a model asked to recall facts
about an employer produces confident wrong ones -- the same failure as a model
reading a careers page for a date -- and being wrong about the interviewer's own
company in the interview is the worst place in this pipeline to be wrong.
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

MODEL = os.environ.get("JOBOPS_PREP_MODEL", "claude-sonnet-5")
MAX_TOKENS = 6000
PRICE = {"claude-sonnet-5": (3.00, 15.00),
         "claude-haiku-4-5-20251001": (1.00, 5.00)}
ABORT_OVER = 0.25          # per role. A prep pack is one request.
POSTING_CHARS = 6000

# The candidate is named from profile.json through owner.py, never as a literal
# here -- a name typed into a prompt survives a copy of the repo.
RULES = f"""You are preparing {OWNER['name']} for one interview. You write in their
voice: direct, concrete, numbers first, no buzzwords.

You are given their profile, their projects, both resumes, and the job posting.

Produce JSON with exactly these keys:

  summary        2-3 sentences: what this role actually does, in plain words,
                 drawn from the posting's own responsibilities. Not marketing.

  questions      The five most likely interview questions FOR THIS ROLE. Ground
                 each in a specific responsibility or requirement the posting
                 states. Not generic behavioural questions.

  answers        One per question, same order. A SKELETON, not a script: three
                 or four bullets naming which real experience to use and the
                 number that carries it. Every fact must come from the material
                 given. If nothing in the material supports a good answer, say
                 so in that skeleton rather than inventing one.

  ask_them       Three questions {OWNER['first_name']} should ask THEM, derived from the
                 posting -- something its wording leaves genuinely open.

  position       One short paragraph on citizenship, clearance and the CS
                 degree, worded EXACTLY as the rules below allow.

HARD RULES:

  Never invent a number, a company, a technology, a date or an outcome. Every
  factual claim traces to the material given. This is preparation for saying
  things out loud to a person who can check them.

  Clearance: you MAY write that they are a US citizen needing no sponsorship, that
  they hold no current or prior clearance, that they know of no disqualifying
  factors, and that they are willing to undergo the process. You may NEVER write
  that they are cleared, hold an active clearance, or are clearance-eligible.
  Eligibility is decided by a government adjudicator, not by the candidate.

  No square brackets. If a number is missing, cut the clause.

  No em dashes or en dashes anywhere.

Respond with ONLY the JSON object."""


def sources():
    parts = []
    for name in ("profile.json", "projects.md", "resume_tech.md",
                 "resume_finance.md"):
        p = repo(name)
        if not os.path.exists(p):
            raise SystemExit(f"prep_pack: {name} is missing.")
        parts.append(f"===== {name} =====\n"
                     + io.open(p, encoding="utf-8").read())
    # The owner's own cover letter as a voice sample, when they supplied one.
    # Shared with apply_packs.py so the two cannot disagree about what a sample
    # may and may not contribute (voice yes, facts never).
    from apply_packs import voice_sample
    vs = voice_sample()
    if vs:
        parts.append(vs)
    text = "\n\n".join(parts)
    # A ZERO-INPUT GUARD, the same shape as the critic's. With no material every
    # answer would be invented, which is the one outcome this must never
    # produce -- and it would look exactly like a good pack.
    if len(text) < 6000:
        raise SystemExit(
            f"prep_pack: source material is only {len(text)} characters. "
            f"Refusing -- with too little material every answer is invented.")
    return text


def build_request(job, src):
    posting = fetch_jobs.strip_html(job["description"] or "")[:POSTING_CHARS]
    return {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": RULES,
        "messages": [{
            "role": "user",
            "content": (f"MATERIAL:\n{src}\n\n"
                        f"POSTING: {job['company']} - {job['title']}\n"
                        f"Location: {job['location'] or 'not stated'}\n\n"
                        f"{posting}"),
        }],
    }


def estimate(req):
    if MODEL not in PRICE:
        raise SystemExit(f"No price for {MODEL}. Add it to PRICE first.")
    inp, outp = PRICE[MODEL]
    approx = lambda s: max(1, len(s) // 4)
    tin = approx(req["system"]) + approx(req["messages"][0]["content"])
    tout = 2200
    # SYNCHRONOUS, so NO batch discount. Saying so here rather than quietly
    # halving it is the difference between an estimate and a hope.
    return {"in": tin, "out": tout, "cost": (tin * inp + tout * outp) / 1e6}


def _parse(text):
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
                except json.JSONDecodeError:
                    return None
    return None


_DASHES = re.compile(r"[—–―]")
_BRACKET = re.compile(r"\[[^\]]+\]")


def violations(obj):
    """Why this pack must not be stored, or []. Reuses the pack rules.

    ONE DEFINITION OF THE CLEARANCE RULE, imported from apply_packs, which
    parses it out of web/lib/clearance.js. A third spelling of a rule that is
    already spelled twice is how it rots.
    """
    from apply_packs import clearance_claim
    out = []
    for key, val in obj.items():
        # JOINED, NOT json.dumps. Serialising a list wraps it in [ ... ], which
        # the bracket rule then reports as a placeholder -- so every questions,
        # answers and ask_them array was refused, and a clean pack could never
        # be stored. The test caught it on the first run.
        if isinstance(val, str):
            blob = val
        elif isinstance(val, (list, tuple)):
            blob = "\n".join(str(x) for x in val)
        else:
            blob = str(val)
        hit = clearance_claim(blob)
        if hit:
            out.append(f"{key} claims {hit!r}")
        b = _BRACKET.search(blob)
        if b:
            out.append(f"{key} contains the placeholder {b.group(0)!r}")
        d = _DASHES.search(blob)
        if d:
            out.append(f"{key} contains a dash")
    return out


def do_due(con):
    """Roles at interview with no prep pack. Prints; never builds.

    role_events is keyed by GROUP_KEY -- "company|normalised title" -- because
    one requisition can be several rows across cities and a status belongs to
    the whole group. `jobs` has no group_key column: it is computed in
    lib/display.js by groupKeyOf, with normalizeTitle inside it.

    THIS DOES NOT REIMPLEMENT normalizeTitle. A second spelling of a rule is how
    schema.sql drifted twenty columns and how the trigger list went stale. It
    matches on the COMPANY half, which is stored verbatim, and prints the group
    key so a human picks the exact role. `due` is a prompt, not an automation --
    building is one deliberate command per role regardless.
    """
    events = con.execute(
        "SELECT DISTINCT group_key FROM role_events WHERE status = ?",
        ("interview",)).fetchall()
    if not events:
        print("Nothing at interview. Zero cost, as designed: this generator "
              "only runs when a status flips.")
        return 0

    done = {r["key"] for r in
            con.execute("SELECT key FROM prep_packs").fetchall()}
    n = 0
    for e in events:
        gk = e["group_key"] or ""
        company = gk.split("|")[0]
        rows = con.execute(
            "SELECT key, title FROM jobs "
            " WHERE company = ? AND closed_at IS NULL ORDER BY key",
            (company,)).fetchall()
        print(f"  at interview: {gk}")
        for r in rows:
            if r["key"] in done:
                continue
            n += 1
            print(f"    {r['key']}  {r['title'][:60]}")
    if not n:
        print("\nEvery matching role already has a prep pack.")
        return 0
    print(f"\n{n} candidate role(s). "
          f"`python prep_pack.py build <key>` for the one you are "
          f"actually interviewing for.")
    return 0


def do_build(con, key, dry_run=False):
    job = con.execute(
        "SELECT key, company, title, location, description FROM jobs "
        " WHERE key = ?", (key,)).fetchone()
    if not job:
        print(f"No such role: {key}")
        return 1
    src = sources()
    req = build_request(job, src)
    est = estimate(req)

    print(f"  model     {MODEL}  (synchronous, no batch discount)")
    print(f"  role      {job['company']} - {job['title'][:56]}")
    print(f"  tokens    ~{est['in']:,} in + ~{est['out']:,} out")
    print(f"  estimate  ${est['cost']:.3f}")
    print(f"  abort at  ${ABORT_OVER:.2f}")
    if est["cost"] > ABORT_OVER:
        print(f"\nREFUSING: ${est['cost']:.3f} is over ${ABORT_OVER:.2f}.")
        return 1
    if dry_run:
        print("\n--dry-run: nothing sent.")
        return 0

    import anthropic
    m = anthropic.Anthropic().messages.create(**req)
    text = "".join(b.text for b in m.content if getattr(b, "type", "") == "text")
    obj = _parse(text)
    if not obj:
        print("The response did not parse. Storing the raw and stopping.")
        con.execute(
            "INSERT INTO prep_packs (key, model, created_at, raw) VALUES (?,?,?,?) "
            "ON CONFLICT (key) DO UPDATE SET raw = excluded.raw",
            (key, MODEL, fetch_jobs.now(), text[:12000]))
        con.commit()
        return 1

    bad = violations(obj)
    if bad:
        # REFUSED, NOT CLEANED, exactly as an apply pack is. A clearance claim
        # is a false statement of fact and a bracket is a hole where a number
        # should be; neither is fixable by editing the string.
        print("REFUSED on a hard rule:")
        for b in bad:
            print(f"  {b}")
        con.execute(
            "INSERT INTO prep_packs (key, model, created_at, raw, note) "
            "VALUES (?,?,?,?,?) ON CONFLICT (key) DO UPDATE SET "
            "raw = excluded.raw, note = excluded.note",
            (key, MODEL, fetch_jobs.now(), text[:12000], "; ".join(bad)[:1000]))
        con.commit()
        return 1

    con.execute(
        "INSERT INTO prep_packs (key, model, created_at, summary, questions, "
        " answers, ask_them, position) VALUES (?,?,?,?,?,?,?,?) "
        "ON CONFLICT (key) DO UPDATE SET model=excluded.model, "
        " created_at=excluded.created_at, summary=excluded.summary, "
        " questions=excluded.questions, answers=excluded.answers, "
        " ask_them=excluded.ask_them, position=excluded.position, "
        " raw=NULL, note=NULL",
        (key, MODEL, fetch_jobs.now(), obj.get("summary"),
         json.dumps(obj.get("questions")), json.dumps(obj.get("answers")),
         json.dumps(obj.get("ask_them")), obj.get("position")))
    con.commit()
    print(f"\nstored. /prep/{key}")
    return 0


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("key")
    b.add_argument("--dry-run", action="store_true")
    sub.add_parser("due")
    a = ap.parse_args()
    con = fetch_jobs.db()
    if a.cmd == "due":
        return do_due(con)
    return do_build(con, a.key, dry_run=a.dry_run)


if __name__ == "__main__":
    sys.exit(main())
