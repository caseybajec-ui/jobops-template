#!/usr/bin/env python3
"""Apply flows that cannot be completed. Record one, lift one, list them.

  python apply_blocks.py list
  python apply_blocks.py list --all          # lifted ones too, with their history
  python apply_blocks.py block <key> --reason http_error --note "HTTP 406 since ..."
  python apply_blocks.py unblock <key>

NOT blockers.py, WHICH IS A DIFFERENT THING WITH A SIMILAR NAME. blockers.py
reads a POSTING and tags what would screen the owner out of it -- a clearance
they do not hold, five years they do not have. It is a classifier over text, it
runs at ingest, and it gates nothing.

This is the opposite end: nothing is wrong with the ROLE, and the form will not
submit. An hCaptcha that loops on Lever, a careers site answering 406 to
everything. Nothing here reads a posting, and no pattern or model is involved --
every row is something a human or the apply bot's log observed.

  python blockers.py     -> "you are not eligible for this"
  python apply_blocks.py -> "you cannot apply to this"

SCOPE IS INFERRED FROM THE KEY and that is the only clever thing in this file:
a key beginning `window:` is a window, anything else is one posting's jobs.key.
Typing `--scope role` beside a key that plainly starts with `window:` is a way
to create a row nothing will ever read.

A POSTING IS ONE REQUISITION, not the role group. Palantir lists Deployment
Strategist in a dozen cities and the hCaptcha loops on exactly one of them; a
group-level block would hide eleven good postings to record one broken form.

IT NEVER DELETES. `unblock` writes a new row with on_ = 0. How long a company's
apply flow stayed broken is the only evidence this system will ever hold about
whether that company is worth the evening, and a DELETE throws it away.
"""
import argparse
import sys
import time
import uuid

import fetch_jobs
from console import utf8_stdout

# The same list as web/lib/blocked.js. An unrecognised value is ACCEPTED and
# renders as a plain "Blocked": fail open, because a row dropped for a spelling
# is an application silently un-blocked and an evening wasted on the same form.
# The list is offered as help text, not enforced as a constraint.
REASONS = {
    "captcha_hcaptcha": "hCaptcha loop",
    "captcha": "captcha",
    "http_error": "HTTP error",
    "login_required": "account required",
    "form_rejected": "the form rejected it",
    "closed": "posting closed",
}

COLS = "id, scope, key, reason, note, label, url, on_, at"


def new_id() -> str:
    """Millisecond-prefixed and base-36, so ids sort the way the clock ran.

    foldBlocked() takes the LATEST row per (scope, key) by id and never by `at`
    -- two writes inside one second carry identical timestamps and the pair
    settles at random. That only works if the id is monotonic, so it is built
    here the same way web/lib/db.js builds it rather than being a bare uuid.
    """
    return "bk:%s-%s" % (format(int(time.time() * 1000), "x"), uuid.uuid4().hex[:6])


def scope_of(key: str) -> str:
    return "window" if str(key).startswith("window:") else "role"


def fold(rows):
    """Latest row per (scope, key), by id. The Python half of foldBlocked()."""
    latest = {}
    for r in rows:
        k = (r["scope"], r["key"])
        if k not in latest or str(r["id"]) > str(latest[k]["id"]):
            latest[k] = r
    return latest


def read_all(con):
    cur = con.execute(
        "SELECT %s FROM blocked_applies ORDER BY id" % COLS)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def write(con, key, reason=None, note=None, label=None, url=None, on=True):
    con.execute(
        "INSERT INTO blocked_applies (%s) VALUES (?,?,?,?,?,?,?,?,?)" % COLS,
        (new_id(), scope_of(key), key, reason, note, label, url,
         1 if on else 0, fetch_jobs.now()))
    con.commit()


def role_snapshot(con, key):
    """The label and url to freeze onto the row, from the job it names.

    SNAPSHOTTED, NOT JOINED. Lever re-ids requisitions constantly; a row that
    joined to `jobs` would VANISH the moment the board re-posted the same job,
    which on screen reads as "it got fixed". A blocked flow at Palantir is true
    whether or not that particular requisition still exists.

    Returns (label, url, found). `found` false is not an error: the bot can meet
    a broken form on a board this tool does not track at all.
    """
    cur = con.execute(
        "SELECT COALESCE(display_name, company) AS company, title, location, url "
        "FROM jobs WHERE key = ?", (key,))
    row = cur.fetchone()
    if not row:
        return None, None, False
    company, title, location, url = row[0], row[1], row[2], row[3]
    label = "%s — %s" % (company, title)
    if location:
        label += " (%s)" % location
    return label, url, True


def cmd_list(con, args):
    rows = read_all(con)
    if not rows:
        # AN EMPTY TABLE IS NOT A CLEAN RESULT, and it is not silence either.
        # Nothing blocked and the migration never having run look identical
        # here, so both are named.
        print("No blocked apply flows recorded.")
        print("If that is a surprise, check migration 023 has been applied.")
        return 0
    latest = fold(rows)
    history = {}
    for r in rows:
        history.setdefault((r["scope"], r["key"]), []).append(r)

    active = [r for r in latest.values() if int(r["on_"] or 0)]
    lifted = [r for r in latest.values() if not int(r["on_"] or 0)]
    shown = active + (lifted if args.all else [])
    shown.sort(key=lambda r: (r["scope"] != "window", r["key"]))

    for r in shown:
        state = "BLOCKED" if int(r["on_"] or 0) else "lifted "
        print("%s  %s" % (state, r["label"] or r["key"]))
        print("         %s%s" % (REASONS.get(r["reason"], r["reason"] or "Blocked"),
                                 (": " + r["note"]) if r["note"] else ""))
        print("         key %s" % r["key"])
        if r["url"]:
            print("         %s" % r["url"])
        if args.all:
            for h in history[(r["scope"], r["key"])]:
                print("           %s  %s  %s" % (
                    h["at"], "blocked" if int(h["on_"] or 0) else "lifted ", h["id"]))
        print()
    print("%d blocked, %d lifted." % (len(active), len(lifted)))
    return 0


def cmd_block(con, args):
    key = args.key
    latest = fold(read_all(con)).get((scope_of(key), key))
    if latest and int(latest["on_"] or 0) and not args.force:
        print("Already blocked: %s" % (latest["label"] or key))
        print("Nothing written. --force to record it again with a new reason.")
        return 0

    label, url, found = (None, None, False)
    if scope_of(key) == "role":
        label, url, found = role_snapshot(con, key)
        if not found:
            # LOUD, BUT NOT A REFUSAL. A key this tool has never fetched is
            # exactly the case the label/url snapshot exists for, and refusing
            # would mean the only rows it can record are the ones it could have
            # looked up anyway.
            print("No job row for %s — recording it with no label or url." % key)
    write(con, key, reason=args.reason, note=args.note,
          label=args.label or label, url=args.url or url, on=True)
    print("blocked  %s" % (args.label or label or key))
    return 0


def cmd_unblock(con, args):
    key = args.key
    latest = fold(read_all(con)).get((scope_of(key), key))
    if not latest:
        print("Nothing recorded for %s. Nothing to lift." % key)
        return 1
    if not int(latest["on_"] or 0):
        print("Already lifted: %s" % (latest["label"] or key))
        return 0
    # The label and url ride along onto the lifting row so `list --all` reads as
    # a history of one thing rather than as a row that lost its name halfway.
    write(con, key, reason=latest["reason"], note=args.note or latest["note"],
          label=latest["label"], url=latest["url"], on=False)
    print("lifted   %s" % (latest["label"] or key))
    print("The history stays in the table; nothing was deleted.")
    return 0


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="what is blocked right now")
    p.add_argument("--all", action="store_true",
                   help="include lifted blocks and the full history of each")

    p = sub.add_parser("block", help="record that an apply flow is broken")
    p.add_argument("key", help="a jobs.key, or window:<firm>|<program>")
    p.add_argument("--reason", default=None,
                   help="one of: %s (anything else is kept and renders as "
                        "'Blocked')" % ", ".join(REASONS))
    p.add_argument("--note", default=None, help="what actually happens")
    p.add_argument("--label", default=None,
                   help="override the label; defaults to the job row's")
    p.add_argument("--url", default=None,
                   help="override the url; defaults to the job row's")
    p.add_argument("--force", action="store_true",
                   help="write another row even though it is already blocked")

    p = sub.add_parser("unblock", help="lift a block (writes a row, deletes nothing)")
    p.add_argument("key")
    p.add_argument("--note", default=None, help="what changed")

    args = ap.parse_args()
    con = fetch_jobs.db()
    return {"list": cmd_list, "block": cmd_block, "unblock": cmd_unblock}[args.cmd](con, args)


if __name__ == "__main__":
    sys.exit(main())
