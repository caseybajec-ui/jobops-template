#!/usr/bin/env python3
"""Record MEASURED token usage for batches collected before it was stored.

    python backfill_usage.py --dry-run
    python backfill_usage.py

The cost meter used to price every batch from mean token shapes, which ignored
cache traffic entirely and read about 35% low — $0.78 against a measured $0.80
on one batch, and worse on runs where the cached profile dominates the input.
`collect` now stores the real counts as the results stream past. This fills in
the batches that finished before it did.

Reads only. The Anthropic Batches API keeps results for 29 days, so anything
older than that cannot be recovered and stays an estimate — the meter labels
those with a leading `~` rather than pretending.

Writes nothing but the four usage columns, one batch at a time, committed per
batch, so an interruption leaves the batches it already measured.
"""
import argparse
import sys

from console import utf8_stdout
from fetch_jobs import db
from score_jobs import _add_usage, price


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    import anthropic
    from dotenv import load_dotenv
    load_dotenv()

    con = db()
    rows = con.execute(
        "SELECT batch_id, stage, model, n, submitted_at FROM batches"
        " WHERE in_tok IS NULL ORDER BY submitted_at, batch_id").fetchall()
    if not rows:
        print("Every batch already has measured usage.")
        return 0

    print("%d batch(es) without measured usage\n" % len(rows))
    client = anthropic.Anthropic()
    done = gone = 0
    for b in rows:
        usage = {"in": 0, "out": 0, "cw": 0, "cr": 0}
        n = 0
        try:
            for res in client.messages.batches.results(b["batch_id"]):
                if res.result.type != "succeeded":
                    continue
                _add_usage(usage, res.result.message.usage)
                n += 1
        except Exception as e:                      # noqa: BLE001
            # Expired (>29 days) or otherwise unavailable. Leave it estimated.
            print("  %-34s unavailable (%s)"
                  % (b["batch_id"][:34], type(e).__name__))
            gone += 1
            continue
        if not n:
            print("  %-34s no successful results" % b["batch_id"][:34])
            gone += 1
            continue
        cost = price(b["model"], usage["in"], usage["out"],
                     usage["cw"], usage["cr"], batch=True)
        print("  %-34s %4d results  $%.2f" % (b["batch_id"][:34], n, cost))
        if a.dry_run:
            continue
        con.execute(
            "UPDATE batches SET in_tok=?, out_tok=?, cache_w_tok=?,"
            " cache_r_tok=? WHERE batch_id=?",
            (usage["in"], usage["out"], usage["cw"], usage["cr"],
             b["batch_id"]))
        con.commit()
        done += 1

    print()
    if a.dry_run:
        print("--dry-run: nothing written")
    else:
        print("measured %d batch(es); %d could not be recovered" % (done, gone))
    return 0


if __name__ == "__main__":
    sys.exit(main())
