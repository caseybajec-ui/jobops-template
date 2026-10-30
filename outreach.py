#!/usr/bin/env python3
"""
outreach.py — draft, approve, send. Nothing sends without approved=true.

  python outreach.py draft <contact_id> [cold|follow_up|thank_you]
  python outreach.py approve <contact_id> [kind]
  python outreach.py send <contact_id> [kind]     # refuses unless approved
  python outreach.py list

Hard rules, enforced here in code rather than left to a prompt:

  1. Nothing sends without approved=true. `send` currently only prints; Gmail
     wiring comes later and does not change this gate.
  2. Never manufacture a connection. A draft may state a shared institution
     plainly, a fact from the public posting, or something the owner has
     genuinely used. It may NOT imply familiarity with someone's work, reference
     anything they have not read, or invent warmth. See CLAUDE.md.
  3. The ask is small, specific, and answerable. A 15-minute question about what
     the work is actually like gets replies; "love to connect and learn more"
     does not.
  4. Cadence stops at two. Day 5, day 12, then done. `draft` refuses a third.
  5. Length: cold under 120 words, follow-up under 60. Checked, not hoped for.

The voice is a PLACEHOLDER until the owner supplies real samples in voice/.
Drafts written from profile.json alone read like a resume, which is exactly the
failure mode to avoid — treat current output as structurally right and tonally
generic.

WHO IS WRITING comes from profile.json through owner.py: the school, the class
label, the graduation and the sign-off. None of it is a literal here, because a
template with one person's name in its sign-off sends the next owner's outreach
signed by a stranger.
"""
import argparse
import datetime as dt
import io
import json
import os
import re
import sys

import contacts as C
from console import utf8_stdout
from fetch_jobs import db, now
from owner import OWNER
from paths import repo

# Drafts live in the DATABASE now, same as contacts. They were markdown files
# in outreach/, which is gitignored because a draft names a real person — so
# like contacts.csv it could never exist on Vercel. The `outreach` table was
# created by the migration in phase B and sat unused; this is a swap, not a
# schema change.
#
# The whole draft, frontmatter and all, goes in `body` — except approval,
# which is a COLUMN. One place decides whether something may be sent; a flag
# duplicated in prose and in a column is a flag that will disagree with itself.
OUT_DIR = "outreach"   # legacy; nothing writes here any more
KINDS = ("cold", "follow_up", "thank_you")
LIMITS = {"cold": 120, "follow_up": 60, "thank_you": 80}
# The one-line evidence clause in a cold draft. The rest of the cold template
# is ~75 words, so this keeps the whole thing under the 120-word limit.
ANGLE_WORDS = 30
TODAY = dt.date.today()

# Phrases that manufacture warmth or make an unanswerable ask. Checked against
# every draft before it is written; a hit is a bug in the generator, not a style note.
BANNED = [
    "hope this finds you well", "hope you're doing well", "i've been following",
    "big fan of", "love what you", "huge admirer", "your inspiring",
    "reaching out to connect", "love to connect", "learn more about opportunities",
    "pick your brain", "touch base", "circle back", "synergy", "passionate about",
    "as you may know", "i came across your profile",
]


def load_profile():
    with io.open(repo("profile.json"), encoding="utf-8") as f:
        return json.load(f)


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")


def draft_id(cid, kind):
    return f"{cid}-{kind}"


def get_draft(cid, kind):
    r = db().execute(
        "SELECT id, contact_id, kind, body, approved, created_at, sent_at"
        " FROM outreach WHERE id = ?", (draft_id(cid, kind),)).fetchone()
    if not r:
        return None
    keys = ("id", "contact_id", "kind", "body", "approved", "created_at", "sent_at")
    return dict(zip(keys, r))


def word_count(text):
    return len(re.findall(r"\b[\w'-]+\b", text))


def find_contact(cid):
    for r in C.load():
        if r["id"] == cid:
            return r
    return None


# Slugs are ATS identifiers, not names. A draft addressed to a real person must
# not say "looking hard at andurilindustries".
PRETTY = {
    "andurilindustries": "Anduril", "scaleai": "Scale AI", "shieldai": "Shield AI",
    "applied": "Applied Intuition", "hadrian-automation": "Hadrian",
    "mach": "Mach Industries", "vannevarlabs": "Vannevar Labs",
    "nerostechnologies": "Neros", "trueanomalyinc": "True Anomaly",
    "overland-ai": "Overland AI", "chaosindustries": "Chaos Industries",
    "openai": "OpenAI", "bvpanalyst": "Bessemer", "ey-parthenon": "EY-Parthenon",
}


def pretty_company(slug_name):
    if slug_name in PRETTY:
        return PRETTY[slug_name]
    return " ".join(w.capitalize() for w in re.split(r"[-_]", slug_name or ""))


def company_angle(company, profile):
    """One concrete, true thing about the owner aimed at this company.

    Drawn only from profile.json evidence. Never asserts anything about the
    recipient or their work.
    """
    evidence = list(profile.get("evidence") or [])
    defense = ("palantir", "andurilindustries", "saronic", "shieldai", "applied",
               "hadrian-automation", "skydio", "mach", "vannevarlabs", "epirus",
               "chaosindustries", "nerostechnologies", "trueanomalyinc",
               "overland-ai", "forterra", "scaleai", "hermeus")
    # The evidence item whose `emphasis` fits the company; the first one listed
    # wins, because profile.json orders them strongest first. This used to be
    # three hand-written sentences about the original owner's own projects --
    # a personal fact typed into a template, so the next owner's drafts would
    # have claimed work they never did.
    want = "defense" if company in defense else "product"
    pick = next((e for e in evidence if want in (e.get("emphasis") or [])),
                evidence[0] if evidence else None)
    if not pick:
        return "Happy to say more about my background if useful"
    # The first sentence only, capped, so the angle stays one line and the
    # cold draft stays under its word limit. Evidence text is written
    # resume-style ("Founded and ran ..."), which is the placeholder voice the
    # module docstring already admits to.
    sentence = re.split(r"\.\s", str(pick.get("text") or ""))[0].strip(" .")
    words = sentence.split()
    if len(words) > ANGLE_WORDS:
        sentence = " ".join(words[:ANGLE_WORDS]).rstrip(",;:")
    return sentence


def build(kind, contact, profile):
    """Assemble a draft. Placeholder voice; structure is the real deliverable."""
    name = (contact["name"] or "there").split()[0]
    role = contact["role"] or "your team"
    company = pretty_company(contact["company"])
    slug_co = contact["company"]
    target = contact["target_role"] or "the deployment and product side"
    angle = company_angle(slug_co, profile)
    source = (contact["source"] or "").lower()

    # Who is writing, from profile.json: the school, the class label, the
    # graduation and the first name -- never a literal, so a copied template
    # cannot sign the next owner's mail with someone else's name.
    school = OWNER["school_short"]
    who = f"I'm a {school} {OWNER['class_label']}"
    grad = OWNER["graduation"]
    signoff = OWNER["first_name"]
    school_words = [t.lower() for t in OWNER["school_search_terms"]] + [school.lower()]

    # The ONLY relationship claim permitted is the literal one from `source`.
    if "alumni" in source or any(w and w in source for w in school_words):
        link = f"{who} and found you in the alumni directory"
    elif source.startswith("club:"):
        # `club:<name>` as the contact's source names a shared organisation the
        # owner belongs to; the draft states it and nothing more.
        link = f"{who} and a member of {contact['source'][5:].strip()}"
    elif "intro" in source or "referred" in source:
        link = f"{contact['source']} suggested I get in touch"
    else:
        link = f"{who} graduating in {grad}"

    if kind == "cold":
        body = (
            f"{link}. I'm graduating in {grad} and looking hard at {company}.\n\n"
            f"{angle}.\n\n"
            f"Would you have 15 minutes in the next couple of weeks to tell me what "
            f"{role} work at {company} is actually like day to day? I'm trying to "
            f"understand whether {target} is the right fit before I apply, and I'd "
            f"rather hear it from someone doing it.\n\n"
            f"Happy to work around your schedule.\n\n{signoff}"
        )
        subject = f"{school} {OWNER['class_label']} — 15 minutes on {role} at {company}?"
    elif kind == "follow_up":
        n = int(contact["touch_count"] or 0)
        tail = ("No worries at all if the timing is bad — I won't keep pinging you."
                if n >= 2 else "Happy to make it easier by sending questions over email instead.")
        body = (f"Following up on my note about {role} work at {company}. "
                f"Still very interested, and 15 minutes would help a lot.\n\n"
                f"{tail}\n\n{signoff}")
        subject = f"Re: 15 minutes on {role} at {company}?"
    else:
        body = (f"Thanks for the time — genuinely useful. The part about {role} work "
                f"at {company} that I hadn't understood was how much of it is "
                f"customer-side rather than internal.\n\n"
                f"I'll follow up when {OWNER['grad_year']} roles open. If there's "
                f"anyone else you'd suggest I talk to, I'd appreciate the pointer."
                f"\n\n{signoff}")
        subject = f"Thank you — {company}"
    return subject, body


def cmd_draft(cid, kind):
    contact = find_contact(cid)
    if not contact:
        print(f"No contact {cid}. Add them with contacts.py add.")
        return 1

    n = int(contact["touch_count"] or 0)
    if kind == "follow_up" and n >= len(C.CADENCE) + 1:
        print(f"REFUSED. {cid} has had {n} touches. The cadence is day 5 and day 12, "
              f"then stop.\nTwo unanswered messages is an answer — leave it, and keep "
              f"the relationship intact for a warm intro later.")
        return 1
    if contact["replied"] == "yes" and kind == "follow_up":
        print(f"REFUSED. {cid} already replied. Write to them directly rather than "
              f"continuing a cadence.")
        return 1

    profile = load_profile()
    subject, body = build(kind, contact, profile)

    wc = word_count(body)
    limit = LIMITS[kind]
    lower = body.lower()
    hits = [b for b in BANNED if b in lower]
    if hits:
        print(f"BUG: draft contains banned phrasing {hits}. Not written.")
        return 1
    if wc > limit:
        print(f"BUG: {wc} words exceeds the {limit}-word limit for {kind}. Not written.")
        return 1

    text = (
        f"---\ncontact_id: {cid}\nname: {contact['name']}\n"
        f"company: {contact['company']}\nkind: {kind}\nchannel: {contact['channel']}\n"
        f"subject: {subject}\nwords: {wc}\nlimit: {limit}\ndrafted: {TODAY}\n"
        f"voice: placeholder — awaiting real samples in voice/\n---\n\n{body}\n"
    )
    con = db()
    # Re-drafting resets approval, deliberately: approving one wording must
    # never carry over to different words.
    con.execute(
        "INSERT INTO outreach (id, contact_id, kind, body, approved, created_at)"
        " VALUES (?,?,?,?,0,?)"
        " ON CONFLICT (id) DO UPDATE SET body = excluded.body, approved = 0,"
        " created_at = excluded.created_at, sent_at = NULL",
        (draft_id(cid, kind), cid, kind, text, now()))
    con.commit()
    print(f"wrote draft {draft_id(cid, kind)}  ({wc}/{limit} words)")
    print(f"  review with:  python outreach.py show {cid} {kind}")
    print(f"  then:         python outreach.py approve {cid} {kind}")
    print("  nothing sends until approved.")
    return 0


def cmd_show(cid, kind):
    d = get_draft(cid, kind)
    if not d:
        print(f"No draft {draft_id(cid, kind)}.")
        return 1
    print(d["body"])
    print(f"[approved: {'yes' if d['approved'] else 'no'}]")
    return 0


def cmd_approve(cid, kind):
    if not get_draft(cid, kind):
        print(f"No draft {draft_id(cid, kind)}.")
        return 1
    con = db()
    con.execute("UPDATE outreach SET approved = 1 WHERE id = ?",
                (draft_id(cid, kind),))
    con.commit()
    print(f"approved {draft_id(cid, kind)}")
    print(f"  then:  python outreach.py send {cid} {kind}")
    return 0


def cmd_send(cid, kind):
    d = get_draft(cid, kind)
    if not d:
        print(f"No draft {draft_id(cid, kind)}.")
        return 1
    # The COLUMN decides. Hard rule 3: nothing sends unless approved.
    if not d["approved"]:
        print(f"REFUSED: {draft_id(cid, kind)} is not approved.")
        print(f"Approve it with: python outreach.py approve {cid} {kind}")
        return 1
    text = d["body"]

    head, _, body = text.partition("---\n\n")
    meta = dict(re.findall(r"^(\w+): (.*)$", head, flags=re.M))
    print("=" * 72)
    print("WOULD SEND (Gmail is not wired up yet — nothing left this machine)")
    print("=" * 72)
    print(f"To:      {meta.get('name')} <{meta.get('channel')}>")
    print(f"Subject: {meta.get('subject')}")
    print("-" * 72)
    print(body.strip())
    print("=" * 72)
    print(f"\nAfter you actually send it:  python contacts.py touch {cid}")
    return 0


def cmd_list():
    rows = db().execute(
        "SELECT id, body, approved, sent_at FROM outreach ORDER BY id").fetchall()
    if not rows:
        print("No drafts yet.")
        return
    print("%-26s %-9s %-6s %-20s %s"
          % ("DRAFT", "APPROVED", "WORDS", "NAME", "COMPANY"))
    for did, body, approved, sent in rows:
        meta = dict(re.findall(r"^(\w+): (.*)$", (body or "")[:600], flags=re.M))
        state = "sent" if sent else ("yes" if approved else "no")
        print("%-26s %-9s %-6s %-20s %s" % (
            did, state, meta.get("words", "?"),
            meta.get("name", "?"), meta.get("company", "?")))


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("draft"); p.add_argument("id"); p.add_argument("kind", nargs="?", default="cold", choices=KINDS)
    p = sub.add_parser("approve"); p.add_argument("id"); p.add_argument("kind", nargs="?", default="cold", choices=KINDS)
    p = sub.add_parser("send"); p.add_argument("id"); p.add_argument("kind", nargs="?", default="cold", choices=KINDS)
    p = sub.add_parser("show"); p.add_argument("id"); p.add_argument("kind", nargs="?", default="cold", choices=KINDS)
    sub.add_parser("list")
    a = ap.parse_args()
    if a.cmd == "draft":
        return cmd_draft(a.id, a.kind)
    if a.cmd == "approve":
        return cmd_approve(a.id, a.kind)
    if a.cmd == "send":
        return cmd_send(a.id, a.kind)
    if a.cmd == "show":
        return cmd_show(a.id, a.kind)
    return cmd_list()


if __name__ == "__main__":
    sys.exit(main())
