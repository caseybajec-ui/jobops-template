#!/usr/bin/env python3
"""
contacts.py — the people side. Manual by design.

  python contacts.py add --name "..." --company palantir --role "Deployment Strategist" \
                         --source "alumni directory" [--job-key ...] [--channel email]
  python contacts.py list [--company X] [--status Y]
  python contacts.py due                      # who needs a touch today
  python contacts.py touch <id> [--replied]   # log a send; advances the cadence
  python contacts.py note <id> "text"

NOTHING here looks anyone up. No scraping, no search, no directory access, no
inference of email addresses. The owner brings names from their school's alumni
directory, student organisations, and warm intros; this file only holds and
works them.

Storage is the DATABASE, same as everything else. It was a CSV, and that was
defensible while the app ran on this laptop — but contacts.csv is gitignored
because it holds other people's details, so it can never exist on Vercel, and the
deployed app could therefore never show a single contact. The highest-leverage
feature in the tool was structurally unable to work: the ladder's networking tier
read an always-empty source, and the whole "Start here" queue on Companies exists
to feed it.

`python contacts.py import-csv` moves an existing contacts.csv in, once. After
that the CSV is history and the database is the store.

Cadence: send -> +5 days -> follow-up 1 -> +7 days -> follow-up 2 -> STOP.
Never a third. Two unanswered messages is an answer, and the relationship is
worth more intact for a future warm intro than spent on persistence.
"""
import argparse
import csv
import datetime as dt
import io
import os
import sys
from console import utf8_stdout
from fetch_jobs import db
from owner import OWNER

PATH = "contacts.csv"   # only for the one-time import
FIELDS = [
    "id", "name", "company", "role", "channel", "source", "job_key",
    "target_role", "status", "first_touch", "last_touch", "touch_count",
    "next_touch", "replied", "notes", "created_at",
]
STATUSES = ["to_contact", "drafted", "sent", "replied", "meeting", "met",
            "no_reply", "closed"]
# day 5, then day 12 (7 more). A third gap does not exist.
CADENCE = [5, 7]
TODAY = dt.date.today()


def load():
    """Every contact, as the plain dicts the rest of this file already expects."""
    con = db()
    rows = con.execute(
        "SELECT %s FROM contacts" % ", ".join(FIELDS)).fetchall()
    out = []
    for r in rows:
        d_ = dict(zip(FIELDS, r))
        # The CSV era stored everything as text and the commands below compare
        # and concatenate strings. Keep that shape rather than teaching six call
        # sites about types.
        out.append({k: ("" if v is None else str(v)) for k, v in d_.items()})
    return out


def save(rows):
    """Upsert every row. NEVER a delete-then-insert.

    A full replace would empty the table for as long as the insert takes, and if
    the insert failed the contacts would be gone — the same shape as the 204
    score rows deleted to queue a re-score that then failed on an out-of-credits
    error. Nothing here removes a contact, so upsert is also complete.
    """
    con = db()
    cols = ", ".join(FIELDS)
    marks = ", ".join(["?"] * len(FIELDS))
    sets = ", ".join("%s = excluded.%s" % (f, f) for f in FIELDS if f != "id")
    for r in rows:
        con.execute(
            "INSERT INTO contacts (%s) VALUES (%s) "
            "ON CONFLICT (id) DO UPDATE SET %s" % (cols, marks, sets),
            tuple(r.get(f, "") or "" for f in FIELDS))
    con.commit()


def next_id(rows):
    n = 0
    for r in rows:
        try:
            n = max(n, int(r["id"].lstrip("c")))
        except (ValueError, KeyError):
            pass
    return f"c{n + 1:03d}"


def d(s):
    try:
        return dt.date.fromisoformat(s) if s else None
    except ValueError:
        return None


def cmd_import_csv(a):
    """One-time move of an existing contacts.csv into the database.

    Skips loudly when the file is absent or holds no rows, rather than reporting
    a successful import of nothing. Contacts already in the database are left
    alone: this is additive, and running it twice changes nothing the second
    time.
    """
    if not os.path.exists(PATH):
        print("No %s to import. Nothing to do." % PATH)
        return 0
    with io.open(PATH, encoding="utf-8", newline="") as f:
        rows = [dict(r) for r in csv.DictReader(f)]
    rows = [r for r in rows if (r.get("name") or "").strip()]
    if not rows:
        print("%s has no rows. Nothing imported — the database is the store now."
              % PATH)
        return 0

    have = {r["id"] for r in load()}
    fresh = [r for r in rows if r.get("id") and r["id"] not in have]
    if not fresh:
        print("All %d rows in %s are already in the database." % (len(rows), PATH))
        return 0
    save(fresh)
    print("imported %d contact(s) from %s" % (len(fresh), PATH))
    print("The CSV is history now; you can delete it. Nothing reads it again.")
    return 0


def cmd_add(a):
    rows = load()
    cid = next_id(rows)
    rows.append({
        "id": cid, "name": a.name, "company": a.company, "role": a.role or "",
        "channel": a.channel, "source": a.source, "job_key": a.job_key or "",
        "target_role": a.target_role or "", "status": "to_contact",
        "first_touch": "", "last_touch": "", "touch_count": "0",
        "next_touch": str(TODAY), "replied": "no", "notes": a.notes or "",
        # NOT first_touch, which is when the first message goes out. The weekly
        # cadence counts names ADDED, and a name entered today has not been
        # written to yet — reading first_touch made the count permanently zero.
        "created_at": str(TODAY),
    })
    save(rows)
    print(f"added {cid}  {a.name} @ {a.company}")
    print(f"  draft with:  python outreach.py draft {cid} cold")


def cmd_list(a):
    rows = load()
    if a.company:
        rows = [r for r in rows if r["company"] == a.company]
    if a.status:
        rows = [r for r in rows if r["status"] == a.status]
    if not rows:
        print("No contacts. Add one with `contacts.py add`.")
        return
    print("%-6s %-22s %-18s %-26s %-12s %-6s %s" %
          ("ID", "NAME", "COMPANY", "ROLE", "STATUS", "TOUCH", "NEXT"))
    for r in sorted(rows, key=lambda r: (r["company"], r["name"], r["id"])):
        print("%-6s %-22s %-18s %-26s %-12s %-6s %s" % (
            r["id"], r["name"][:22], r["company"][:18], (r["role"] or "")[:26],
            r["status"], r["touch_count"], r["next_touch"] or "-"))


def cmd_due(a):
    rows = [r for r in load()
            if r["next_touch"] and d(r["next_touch"]) and d(r["next_touch"]) <= TODAY
            and r["status"] not in ("replied", "met", "no_reply", "closed")]
    if not rows:
        print("Nothing due today.")
        return
    print(f"DUE — {TODAY}  ({len(rows)})\n")
    for r in sorted(rows, key=lambda r: (r["next_touch"], r["name"], r["id"])):
        late = (TODAY - d(r["next_touch"])).days
        n = int(r["touch_count"] or 0)
        kind = "cold" if n == 0 else ("follow_up" if n <= 2 else "STOP")
        print("  %-6s %-22s %-16s %-11s %s" % (
            r["id"], r["name"][:22], r["company"][:16],
            f"{late}d late" if late else "today",
            f"-> python outreach.py draft {r['id']} {kind}"))


def cmd_touch(a):
    rows = load()
    for r in rows:
        if r["id"] != a.id:
            continue
        n = int(r["touch_count"] or 0) + 1
        r["touch_count"] = str(n)
        r["last_touch"] = str(TODAY)
        r["first_touch"] = r["first_touch"] or str(TODAY)
        if a.replied:
            r["replied"], r["status"], r["next_touch"] = "yes", "replied", ""
            print(f"{a.id}: replied. Cadence stopped — take it from here.")
        elif n >= len(CADENCE) + 1:
            r["status"], r["next_touch"] = "no_reply", ""
            print(f"{a.id}: touch {n}. CADENCE COMPLETE — no third message. "
                  f"Leave it; the relationship is worth more intact.")
        else:
            r["status"] = "sent"
            r["next_touch"] = str(TODAY + dt.timedelta(days=CADENCE[n - 1]))
            print(f"{a.id}: touch {n} logged. Next on {r['next_touch']} "
                  f"(day {sum(CADENCE[:n])}).")
        save(rows)
        return
    print(f"No contact {a.id}.")


def cmd_note(a):
    rows = load()
    for r in rows:
        if r["id"] == a.id:
            stamp = f"[{TODAY}] {a.text}"
            r["notes"] = (r["notes"] + " | " + stamp) if r["notes"] else stamp
            save(rows)
            print(f"{a.id}: noted.")
            return
    print(f"No contact {a.id}.")


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("add")
    p.add_argument("--name", required=True)
    p.add_argument("--company", required=True)
    p.add_argument("--role")
    p.add_argument("--channel", default="email")
    p.add_argument("--source", required=True,
                   help=f"how you found them — {OWNER['school_short']} alumni "
                        f"directory, a student organisation, warm intro")
    p.add_argument("--job-key", dest="job_key")
    p.add_argument("--target-role", dest="target_role")
    p.add_argument("--notes")
    p = sub.add_parser("list"); p.add_argument("--company"); p.add_argument("--status")
    sub.add_parser("due")
    p = sub.add_parser("touch"); p.add_argument("id"); p.add_argument("--replied", action="store_true")
    p = sub.add_parser("note"); p.add_argument("id"); p.add_argument("text")
    sub.add_parser("import-csv", help="one-time move of contacts.csv into the database")
    a = ap.parse_args()
    # No ensure_file() any more: the table is created by the migration, and a
    # missing contacts.csv is now the normal state rather than something to fix.
    {"add": cmd_add, "list": cmd_list, "due": cmd_due, "touch": cmd_touch,
     "note": cmd_note, "import-csv": cmd_import_csv}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
