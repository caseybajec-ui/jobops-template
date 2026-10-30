#!/usr/bin/env python3
"""Rebuild pack text from the batches that produced it, without re-paying.

  python restore_packs.py --dry-run
  python restore_packs.py

WHY THIS EXISTS. On 2026-09-07 the first run of pack_critic.py refused 71 of
121 packs and NULLed their text. The critic was right and the input was wrong:
it was given projects.md and the two resumes but NOT profile.json, so
"I am a US citizen", "hold no clearance" and "targeting a summer start" --
all true, all in profile.json -- came back with no supporting line, exactly as
the prompt instructs.

The refusal path did not keep the raw, so the text was gone from the database.
It was NOT gone from Anthropic: batch results are retained, and the three pack
batches are still readable. This re-reads them and rewrites any pack whose
cover_note is now NULL.

THE LESSON IS THE RULE THAT WAS ALREADY WRITTEN DOWN. "Never delete before the
replacement is confirmed" -- and a critic that has never been run on a sample
is not a confirmed replacement. It should have run on 20 packs and had its
refusals READ before it was allowed near 121. That is the same rule as
"never ship a prompt change without eyeballing a held-out sample", applied to a
stage that deletes rather than scores.
"""
import argparse
import json
import sys

import fetch_jobs
from apply_packs import PROMPTS, _clean, _parse, pack_violation, variant_for
from console import utf8_stdout


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    con = fetch_jobs.db()
    broken = {r["key"] for r in con.execute(
        "SELECT key FROM apply_packs WHERE cover_note IS NULL").fetchall()}
    if not broken:
        print("Nothing to restore: every pack has its text.")
        return 0
    print(f"{len(broken)} packs with no text.")

    import anthropic
    client = anthropic.Anthropic()
    batches = con.execute(
        "SELECT batch_id, model, keymap FROM batches WHERE stage = ? "
        "ORDER BY submitted_at", ("pack",)).fetchall()

    restored = still_bad = 0
    for b in batches:
        keymap = json.loads(b["keymap"])
        wanted = {cid: k for cid, k in keymap.items() if k in broken}
        if not wanted:
            continue
        state = client.messages.batches.retrieve(b["batch_id"])
        if state.processing_status != "ended":
            print(f"  {b['batch_id']}: still {state.processing_status}, skipping.")
            continue
        print(f"  {b['batch_id']}: {len(wanted)} of its packs need restoring")
        for res in client.messages.batches.results(b["batch_id"]):
            key = wanted.get(res.custom_id)
            if not key:
                continue
            text = ""
            if getattr(res.result, "type", "") == "succeeded":
                for blk in res.result.message.content:
                    if getattr(blk, "type", "") == "text":
                        text += blk.text
            obj = _parse(text)
            if not obj:
                still_bad += 1
                continue
            # THE ORIGINAL GUARDS STILL APPLY. This restores text; it does not
            # smuggle past the clearance or bracket rules that were already
            # passing before the critic ran.
            if pack_violation(obj):
                still_bad += 1
                continue
            if args.dry_run:
                restored += 1
                continue
            cat = con.execute(
                "SELECT category FROM jobs WHERE key = ?", (key,)).fetchone()
            vals = {f: _clean(obj.get(f)) for f, _ in PROMPTS}
            con.execute(
                "UPDATE apply_packs SET variant = ?, variant_reason = ?, "
                " cover_note = ?, why_company = ?, why_role = ?, "
                " project_story = ?, biggest_challenge = ?, "
                # The critic verdict is cleared too: it was reached on the wrong
                # input, so leaving it would leave a refusal nobody can act on
                # attached to a pack that is fine.
                " critic_at = NULL, critic_note = NULL "
                " WHERE key = ?",
                (variant_for(cat["category"] if cat else None),
                 _clean(obj.get("variant_reason")), _clean(obj.get("cover_note")),
                 vals["why_company"], vals["why_role"], vals["project_story"],
                 vals["biggest_challenge"], key))
            restored += 1
        if not args.dry_run:
            con.commit()

    print(f"\n{restored} packs restored"
          + (" (dry run, nothing written)" if args.dry_run else "")
          + f", {still_bad} could not be rebuilt.")
    if not args.dry_run:
        n = con.execute(
            "SELECT count(*) FROM apply_packs WHERE cover_note IS NOT NULL"
        ).fetchone()[0]
        print(f"{n} packs now have text.")
        # A RESTORE THAT RESTORED NOTHING IS A FAILURE, not a quiet success.
        if restored == 0:
            print("RESTORED NOTHING. The batch results may have aged out.")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
