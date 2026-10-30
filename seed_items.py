#!/usr/bin/env python3
"""Move the four seeded on-you items out of daily.yaml and into the database.

Run: python seed_items.py [--status]

The DB is the single source for on-you items after this. daily.yaml stays in the
repo as the record of where they came from, and is never read again by the app.

IDEMPOTENT, and that is the whole point of the file. A second run must not
resurrect an item the owner has already ticked off, so:

  * each seeded item gets a STABLE id derived from its text — `seed:<sha1[:12]>` —
    so the same line always maps to the same row, however many times this runs;
  * insertion is ON CONFLICT DO NOTHING, so an existing row is left as it is;
  * completion is an `actions` row, not a column on `items`, so re-inserting the
    item cannot clear it. The done-ness lives somewhere the migration never
    touches.

Editing an item's text in daily.yaml changes its id and would re-add it. That is
correct: after this migration daily.yaml is not the source any more, and editing
it is not how you change an item.
"""
import argparse
import hashlib
import json
import sys

import yaml

from console import utf8_stdout
from fetch_jobs import db, now

YAML_PATH = "daily.yaml"


def seed_id(text):
    return "seed:" + hashlib.sha1(text.strip().encode("utf-8")).hexdigest()[:12]


# An id is derived from the item's TEXT, so rewording a line here would normally
# insert a second row and leave the first one sitting there. RENAMED maps a new
# wording back to the id the old wording produced, so the row keeps its identity
# and everything recorded against it — done, stuck, deferred — survives.
#
# Empty in the template. The original instance had one entry, because a firm
# list was written three different ways in three places; add a mapping here the
# first time you reword a line in daily.yaml that already has rows against it,
# with the NEW wording as the key and seed_id(<old wording>) as the value.
# companies.yaml's `firm:` values are the canonical spelling of a firm.
RENAMED = {}


def load_yaml_items(path=YAML_PATH):
    try:
        with open(path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    except FileNotFoundError:
        return []
    out = []
    for it in cfg.get("items") or []:
        text = (it.get("text") or "").strip()
        if not text:
            continue
        try:
            minutes = int(it["minutes"]) if it.get("minutes") is not None else None
        except (TypeError, ValueError):
            minutes = None
        out.append({
            "id": RENAMED.get(text, seed_id(text)),
            "title": text,
            "note": (it.get("why") or "").strip() or None,
            "due_at": str(it["due"]) if it.get("due") else None,
            "minutes": minutes,
            "steps": normalise_steps(it.get("steps")),
            "done": str(it.get("done", "")).lower() == "true",
        })
    return out


def normalise_steps(raw):
    """The hand-written `steps:` list, as JSON, or None.

    Accepts a bare string or a {text, minutes} mapping per step, because a step
    that takes a stated 15 minutes is worth saying and one that does not should
    not be padded with a guess. Anything unparseable is DROPPED rather than
    coerced: a wrong step is worse than a missing one, and the item still records
    that it is stuck.
    """
    if not raw:
        return None
    steps = []
    for s in raw:
        if isinstance(s, str):
            text, mins = s.strip(), None
        elif isinstance(s, dict):
            text = (s.get("text") or "").strip()
            try:
                mins = int(s["minutes"]) if s.get("minutes") is not None else None
            except (TypeError, ValueError):
                mins = None
        else:
            continue
        if text:
            steps.append({"text": text, "minutes": mins})
    return json.dumps(steps, ensure_ascii=False) if steps else None


def completed_ids(con):
    """Item ids whose most recent action is a non-undone 'done'."""
    rows = con.execute(
        """SELECT a.key, a.meta FROM actions a
           JOIN (SELECT key, MAX(id) mx FROM actions
                 WHERE kind='done' GROUP BY key) t
             ON t.key = a.key AND t.mx = a.id"""
    ).fetchall()
    return {k for k, meta in rows if "\"undo\": true" not in (meta or "")
            and "\"undo\":true" not in (meta or "")}


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true",
                    help="show what is in the DB; change nothing")
    a = ap.parse_args()

    con = db()
    items = load_yaml_items()
    done = completed_ids(con)

    if a.status:
        rows = con.execute(
            "SELECT id, title, due_at, source, minutes FROM items"
            " ORDER BY due_at, title, id"
        ).fetchall()
        print("items in the database: %d" % len(rows))
        for i, title, due, source, minutes in rows:
            mark = "done" if i in done else "open"
            print("  %-6s %-8s %-10s %-6s %s"
                  % (mark, source, due or "-",
                     ("%dm" % minutes) if minutes else "-", title[:60]))
        return 0

    added = skipped = filled = renamed = 0
    ts = now()
    for it in items:
        cur = con.execute(
            # ON CONFLICT DO NOTHING, not INSERT OR IGNORE — the latter is
            # SQLite-only and Postgres rejects it. Both honour this spelling,
            # and the idempotence guarantee is unchanged.
            "INSERT INTO items"
            " (id, title, note, due_at, created_at, source, minutes, steps)"
            " VALUES (?,?,?,?,?,'seed',?,?) ON CONFLICT (id) DO NOTHING",
            (it["id"], it["title"], it["note"], it["due_at"], ts,
             it["minutes"], it["steps"]))
        if cur.rowcount:
            added += 1
            # An item already marked done:true in the yaml arrives already ticked,
            # rather than reappearing as work the owner has finished.
            if it["done"]:
                con.execute(
                    "INSERT INTO actions (key, kind, at, note) VALUES (?,'done',?,?)",
                    (it["id"], ts, "carried over from daily.yaml"))
        else:
            skipped += 1
            # A renamed item keeps its id; carry the new wording onto the row.
            renamed += con.execute(
                "UPDATE items SET title = ? WHERE id = ? AND title <> ?",
                (it["title"], it["id"], it["title"])).rowcount
            # `minutes` and `steps` arrived after these four rows existed, so the
            # insert above can never deliver them. Fill them in ONLY where the
            # database has nothing — an estimate the owner has since changed in
            # the app is theirs, and re-seeding must not overwrite it.
            for col in ("minutes", "steps"):
                if it[col] is not None:
                    filled += con.execute(
                        "UPDATE items SET %s = ? WHERE id = ? AND %s IS NULL"
                        % (col, col),
                        (it[col], it["id"])).rowcount
    con.commit()

    total = con.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    open_n = total - len(completed_ids(con) & {
        r[0] for r in con.execute("SELECT id FROM items")})
    print("seeded %d, already present %d, blank fields filled in %d, reworded %d"
          % (added, skipped, filled, renamed))
    print("items now: %d (%d open, %d done)" % (total, open_n, total - open_n))
    if skipped and not added and not filled and not renamed:
        print("nothing changed — safe to run as often as you like")
    return 0


if __name__ == "__main__":
    sys.exit(main())
