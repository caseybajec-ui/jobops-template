#!/usr/bin/env python3
"""Second pass over every apply pack: is each factual claim supported?

  python pack_critic.py check --dry-run     # what it would cost, and stop
  python pack_critic.py check               # submit the batch
  python pack_critic.py collect             # ingest verdicts, refuse the bad

WHY. A pack is the only model-generated text in this tool that reaches an
EMPLOYER. One invented number costs more than the whole tool has saved -- it is
a false statement on an application, and unlike a bad score there is nobody
downstream to catch it. CLAUDE.md rule 4 says tailoring "does not create claims,
numbers, or skills"; nothing was checking.

WHAT IT IS NOT. It does not rewrite, improve, or soften anything. It answers one
question per claim -- is there a line in the source material that supports this
-- and an unsupported claim REFUSES the whole pack, exactly as a clearance claim
does -- EXCEPT that it flags rather than deleting. See do_collect.

HAIKU, because this is classification rather than prose. Sonnet is for text that
reaches a human; deciding whether a sentence is supported by another sentence is
the cheaper job, and the model policy says so.

FAIL OPEN ON THE VERDICT, NOT ON THE CLAIM. A response that will not parse is
recorded and the pack is LEFT ALONE rather than refused -- a critic that cannot
be read must not delete work it never assessed. That is the same asymmetry as
triage: the cost of passing a junk verdict through is a fraction of a cent, and
the cost of discarding a good pack is a role the owner never applies to.
"""
import argparse
import io
import json
import os
import re
import sys

import fetch_jobs
from console import utf8_stdout
from paths import repo

MODEL = os.environ.get("JOBOPS_CRITIC_MODEL", "claude-haiku-4-5-20251001")
MAX_TOKENS = 4000
BATCH_DISCOUNT = 0.5
PRICE = {"claude-haiku-4-5-20251001": (1.00, 5.00),
         "claude-haiku-4-5": (1.00, 5.00),
         "claude-sonnet-5": (3.00, 15.00)}

# Ask before anything over this. The whole point of a cheap critic is that it
# stays cheap; if it does not, that is a number the owner should see first.
ABORT_OVER = 3.00

NEWLINE = chr(10)

FIELDS = ("cover_note", "why_company", "why_role", "project_story",
          "biggest_challenge")

RULES = """You are checking a draft job application for invented facts.

You are given SOURCE MATERIAL about one candidate, and DRAFT TEXT written about
them. Your only job is to decide, for each factual claim in the draft, whether
the source material supports it.

A factual claim is anything checkable: a number, a percentage, a company name, a
job title, a date or duration, a technology, a named product, a measurable
outcome, a role they held.

NOT a factual claim, and you must ignore these entirely:
  - statements about what they WANT, are CURIOUS about, or are TRYING to understand
  - questions they are asking the reader
  - descriptions of the EMPLOYER or the role they are applying to
  - opinions, motivation, and reasoning about fit

For each claim output:
  text      the claim, quoted from the draft
  supported true only if a line in the source material states it or directly
            implies it. Paraphrase is fine. A number must match.
  source    the supporting line from the source material, quoted, or null

Be strict about numbers and generous about phrasing. "cut report prep roughly
in half" is supported by "cut report prep from 6 hours to 3". "1,200 registered
users" is NOT supported by "a few hundred users". A claim that is TRUE but
absent from the source material is UNSUPPORTED -- the source is the whole world
here.

Respond with ONLY a JSON object:
{"claims": [{"text": "...", "supported": true, "source": "..."}]}"""


def flatten_json(obj, prefix=""):
    """profile.json as plain lines, never as raw JSON.

    WHY. The critic answers IN JSON, and when the source is itself JSON the
    model quotes JSON SYNTAX back inside a JSON string value:

        "source": "graduation": "<month year>"

    Those inner quotes are unescaped, so its own reply is invalid and the
    whole verdict is unreadable. 39 of 198 responses failed exactly that
    way -- 20% -- every one otherwise complete, and NONE truncated: max
    output was 1,696 tokens against a 4,000 cap and zero hit max_tokens.

    Same shape as the two pack bugs before it, and the same lesson: the
    model was fine and the INPUT was wrong. Give it prose and it answers in
    JSON; give it JSON and it answers in broken JSON.
    """
    if isinstance(obj, dict):
        out = []
        for k, v in obj.items():
            out.append(flatten_json(v, f"{prefix}{k}: "))
        return NEWLINE.join(x for x in out if x)
    if isinstance(obj, list):
        out = [flatten_json(v, prefix) for v in obj]
        return NEWLINE.join(x for x in out if x)
    return f"{prefix}{obj}" if str(obj).strip() else ""


def source_material():
    """Everything the critic is allowed to treat as true."""
    parts = []
    # profile.json IS IN THE LIST, and leaving it out cost 71 packs.
    #
    # The first run gave the critic projects.md and the two resumes only,
    # following the brief literally. citizenship and clearance live in
    # profile.json -- CLAUDE.md names it the source of truth and says its
    # `citizenship` and `clearance` fields carry the canonical strings -- so
    # "I am a US citizen", "hold no clearance" and "targeting a summer start
    # after graduation" all came back with no supporting line. The critic was RIGHT: the
    # prompt says a claim absent from the source is unsupported, and they were
    # absent. 71 of 121 packs were refused and their text NULLed.
    #
    # profile.json also legitimately holds evidence the resumes do not -- that
    # is stated in CLAUDE.md as a deliberate property of the file -- so a critic
    # reading only the resumes would refuse true claims forever, not just once.
    for name in ("profile.json", "projects.md", "resume_tech.md",
                 "resume_finance.md"):
        p = repo(name)
        if not os.path.exists(p):
            raise SystemExit(
                f"pack_critic: {name} is missing. The critic would then find "
                f"NOTHING supported and refuse every pack in the corpus, which "
                f"is far worse than not running it.")
        body = io.open(p, encoding="utf-8").read()
        if name.endswith(".json"):
            # A MALFORMED profile.json REFUSES rather than degrading. Falling
            # back to the raw text would reintroduce the quote bug it is
            # flattened to avoid, and silently: the run would look fine and
            # 20% of verdicts would come back unreadable again.
            try:
                body = flatten_json(json.loads(body))
            except json.JSONDecodeError as e:
                raise SystemExit(
                    f"pack_critic: {name} is not valid JSON ({e}). Refusing "
                    f"-- passing it raw makes the model quote JSON syntax "
                    f"inside its own JSON and 20% of verdicts come back "
                    f"unreadable.")
        parts.append(f"===== {name} =====\n" + body)
    text = "\n\n".join(parts)
    # A ZERO-INPUT GUARD. An empty source is the one input that makes this tool
    # destructive rather than useless: every claim unsupported, every pack
    # refused, the whole corpus re-queued at full price.
    if len(text) < 8000:
        raise SystemExit(
            f"pack_critic: source material is only {len(text)} characters. "
            f"Refusing to run -- with too little source, everything reads as "
            f"unsupported and every pack in the corpus gets refused.")
    return text


def pack_text(row):
    out = []
    for f in FIELDS:
        v = row[f]
        if v:
            out.append(f"--- {f} ---\n{v}")
    return "\n\n".join(out)


def eligible(con, limit=None):
    """Complete packs that have not been checked, or were checked before an edit."""
    rows = con.execute(
        "SELECT p.key, j.title, j.company, p.cover_note, p.why_company, "
        "       p.why_role, p.project_story, p.biggest_challenge "
        "  FROM apply_packs p JOIN jobs j ON j.key = p.key "
        " WHERE p.cover_note IS NOT NULL AND p.critic_at IS NULL "
        " ORDER BY p.key").fetchall()
    return rows[:limit] if limit else rows


def build_requests(rows, src):
    reqs, keymap = [], {}
    for i, r in enumerate(rows):
        cid = f"critic-{i}"
        keymap[cid] = r["key"]
        reqs.append({
            "custom_id": cid,
            "params": {
                "model": MODEL,
                "max_tokens": MAX_TOKENS,
                "system": RULES,
                "messages": [{
                    "role": "user",
                    "content": (f"SOURCE MATERIAL:\n{src}\n\n"
                                f"DRAFT TEXT (for {r['company']}, "
                                f"{r['title']}):\n{pack_text(r)}"),
                }],
            },
        })
    return reqs, keymap


def estimate(reqs):
    if not reqs:
        return {"n": 0, "cost": 0.0}
    approx = lambda s: max(1, len(s) // 4)
    p = reqs[0]["params"]
    per = approx(p["system"]) + approx(p["messages"][0]["content"])
    # MEASURED FROM THE REQUESTS THAT WOULD BE SENT, never from a hand-written
    # query describing them -- "an estimate that can disagree with the run is
    # decoration", and the last hand-written one under-reported by 3x.
    if MODEL not in PRICE:
        raise SystemExit(f"No price for {MODEL}. Add it to PRICE first.")
    inp, outp = PRICE[MODEL]
    n = len(reqs)
    out_per = 700          # the claim list, not prose
    cost = ((per * n * inp + out_per * n * outp) / 1e6) * BATCH_DISCOUNT
    return {"n": n, "cost": cost, "per": per, "out": out_per}


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


def unsupported(obj):
    """The claims with no support, or None when the verdict is unreadable.

    None and [] are DIFFERENT and the caller must treat them differently: an
    empty list means the critic read the pack and found nothing wrong; None
    means the critic could not be read at all, and a pack must never be refused
    on a verdict nobody could parse.
    """
    if not obj or not isinstance(obj.get("claims"), list):
        return None
    bad = []
    for c in obj["claims"]:
        if isinstance(c, dict) and c.get("supported") is False:
            bad.append({"text": str(c.get("text") or "")[:300],
                        "source": c.get("source")})
    return bad


# A full run is not allowed until a SAMPLE has been collected and read.
#
# The first run refused 71 of 121 packs and destroyed their text, because the
# critic was given the wrong source material. Nothing stopped it. CLAUDE.md
# already says "never ship a prompt change without eyeballing a held-out
# sample" and "never delete before the replacement is confirmed"; both were
# written for stages that SCORE, and this one DELETES, which makes the rule
# more binding rather than less.
#
# So: a run over more than SAMPLE_MAX packs refuses unless a previous critic
# batch has been collected. --sample submits a small one; its refusals get read
# by a human; only then does the full run become possible.
SAMPLE_MAX = 20


def _has_collected_sample(con):
    # AN INVALIDATED BATCH IS NOT A SAMPLE. The first critic run is marked
    # `...-INVALIDATED-wrong-source` precisely so nothing treats it as evidence
    # that a human has read a refusal list -- and the first version of this
    # gate counted it, which would have waved through the full run again.
    r = con.execute(
        "SELECT count(*) AS n FROM batches "
        " WHERE stage = ? AND collected_at IS NOT NULL "
        "   AND collected_at NOT LIKE ?", ("critic", "%INVALIDATED%")).fetchone()
    return bool(r and int(r["n"]) > 0)


def do_check(con, dry_run=False, limit=None, sample=False):
    if sample:
        limit = min(limit or SAMPLE_MAX, SAMPLE_MAX)
    rows = eligible(con, limit)
    if not rows:
        print("No unchecked packs. Every complete pack has a critic verdict.")
        return 0
    src = source_material()
    reqs, keymap = build_requests(rows, src)
    est = estimate(reqs)

    print(f"  model        {MODEL}")
    print(f"  packs        {len(rows)}  (complete, not yet checked)")
    print(f"  requests     {est['n']}")
    print(f"  per request  {est['per']:,} in + ~{est['out']:,} out")
    print(f"  source       {len(src):,} characters of profile.json, projects.md "
          f"and both resumes")
    print(f"  estimate     ${est['cost']:.2f}   (batch, 50% off)")
    print(f"  abort over   ${ABORT_OVER:.2f}")

    # THE SAMPLE GATE, before the cost gate: this one is not about money.
    if (not sample and len(rows) > SAMPLE_MAX
            and not _has_collected_sample(con)):
        print(f"\nREFUSING: {len(rows)} packs and no critic sample has ever "
              f"been collected.")
        print("  A refusal DELETES a pack's text. The first run of this tool "
              "refused 71 of 121")
        print("  because it was given the wrong source material, and nothing "
              "stopped it.")
        print(f"  Run `python pack_critic.py check --sample` (at most "
              f"{SAMPLE_MAX} packs), collect it,")
        print("  READ the refusals, then run this again.")
        return 1

    if est["cost"] > ABORT_OVER:
        print(f"\nREFUSING: ${est['cost']:.2f} is over the ${ABORT_OVER:.2f} "
              f"per-run limit. Nothing was sent.")
        return 1
    if dry_run:
        print("\n--dry-run: nothing sent.")
        return 0

    import anthropic
    client = anthropic.Anthropic()
    batch = client.messages.batches.create(requests=reqs)
    con.execute(
        "INSERT INTO batches (batch_id, stage, model, n, submitted_at, keymap) "
        "VALUES (?,?,?,?,?,?)",
        (batch.id, "critic", MODEL, len(reqs), fetch_jobs.now(),
         json.dumps(keymap)))
    con.commit()
    print(f"\nsubmitted {batch.id} ({len(reqs)} requests)")
    return 0


def do_collect(con, client=None):
    if client is None:
        import anthropic
        client = anthropic.Anthropic()
    rows = con.execute(
        "SELECT batch_id, model, keymap FROM batches "
        "WHERE stage = ? AND collected_at IS NULL", ("critic",)).fetchall()
    if not rows:
        print("No uncollected critic batches.")
        return 0

    checked = refused = unreadable = waiting = 0
    findings = []
    for b in rows:
        keymap = json.loads(b["keymap"])
        used = {"in": 0, "out": 0}
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
                for blk in res.result.message.content:
                    if getattr(blk, "type", "") == "text":
                        text += blk.text
                u = res.result.message.usage
                used["in"] += u.input_tokens
                used["out"] += u.output_tokens
            bad = unsupported(_parse(text))

            if bad is None:
                # UNREADABLE VERDICT: record that it was checked and leave the
                # pack alone. Refusing on a verdict nobody could parse would
                # delete work that was never assessed.
                con.execute(
                    "UPDATE apply_packs SET critic_at = ?, "
                    "critic_note = ? WHERE key = ?",
                    (fetch_jobs.now(),
                     "verdict unreadable; pack left as it was", key))
                unreadable += 1
            elif bad:
                # IT FLAGS. IT DOES NOT DELETE.
                #
                # The first design refused the pack -- cover_note NULL, role
                # re-queued -- on the reasoning that an unsupported claim on an
                # application is unrecoverable. Two runs disagreed with that in
                # different ways and both were expensive:
                #
                #   the first run had the wrong source material and refused 71
                #   of 121 true packs, destroying their text;
                #
                #   the sample run, with the source FIXED, refused 6 of 20 and
                #   2 of those 6 were false positives -- a statement of what
                #   the owner WANTS and a description of the EMPLOYER, both of
                #   which the prompt explicitly tells the model to ignore.
                #
                # A third of refusals being wrong is fine for a flag and
                # completely unacceptable for a delete. The owner reads the
                # note and decides; the pack stays where they can see what was
                # objected to, which is also the only way to judge whether the
                # objection is any good.
                claims = "; ".join(c["text"] for c in bad)[:1500]
                con.execute(
                    "UPDATE apply_packs SET critic_at = ?, critic_note = ? "
                    "WHERE key = ?",
                    (fetch_jobs.now(), f"UNSUPPORTED (check these): {claims}",
                     key))
                refused += 1
                findings.append((key, bad))
            else:
                con.execute(
                    "UPDATE apply_packs SET critic_at = ?, critic_note = NULL "
                    "WHERE key = ?", (fetch_jobs.now(), key))
                checked += 1
        # MEASURED USAGE ON THE ROW, so the cost meter prices this from what
        # it actually used rather than from mean token shapes. Unmeasured, the
        # meter read $1.60 against $3.53 spent.
        con.execute(
            "UPDATE batches SET collected_at = ?, in_tok = ?, out_tok = ? "
            " WHERE batch_id = ?",
            (fetch_jobs.now(), used["in"], used["out"], b["batch_id"]))
        con.commit()

    print(f"{checked} packs clean, {refused} FLAGGED, "
          f"{unreadable} verdicts unreadable (packs left alone)."
          + (f" {waiting} batch(es) still running." if waiting else ""))
    for key, bad in findings:
        print(f"\n  REFUSED {key}")
        for c in bad:
            print(f"    claim : {c['text'][:150]}")
            print(f"    source: {c['source'] or 'NONE FOUND'}")
    return 0


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("--dry-run", action="store_true")
    c.add_argument("--limit", type=int)
    c.add_argument("--sample", action="store_true",
                   help=f"at most {SAMPLE_MAX} packs, to be read before a full run")
    sub.add_parser("collect")
    a = ap.parse_args()

    con = fetch_jobs.db()
    if a.cmd == "check":
        return do_check(con, dry_run=a.dry_run, limit=a.limit, sample=a.sample)
    return do_collect(con)


if __name__ == "__main__":
    sys.exit(main())
