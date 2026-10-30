#!/usr/bin/env python3
"""Read the owner's school alumni from LinkedIn search results. Local, read-only.

  python read_alumni.py --dry-run    # every gate, no browser
  python read_alumni.py              # the real run

THIS IS THE ONE NARROW EXCEPTION TO CLAUDE.md RULE 2, and it exists only
inside the limits below. Anything outside them stays forbidden.

  Real Chrome, the owner's Default profile, over the remote debugging port.
  Never headless. Never a fresh profile. Never a second account.

  READ ONLY. It opens a search URL and reads the DOM. There is no code path
  that clicks a profile, connects, messages or follows, and test_reader.py
  fails if a selector or an action for any of those appears in this file.

  3 searches a day for the first 14 days, then 5. 20 results each, page 1.

  Only when the owner has touched the machine in the last 30 minutes, at a
  random time between 1pm and 6pm. Otherwise skipped, and the digest says so.

  5 to 30 seconds between every action, randomised.

  HALTS FOR THE DAY on any captcha, checkpoint, "unusual activity" or login
  page. Red in the digest. It does not retry.

  jobops-local/PAUSE stops every run while the file exists.

  Halted twice in 14 days and it DISABLES ITSELF until the owner re-enables it.

WHY THE LIMITS ARE IN CODE AND NOT IN A COMMENT. The asset at risk is the
owner's own alumni network, which is the highest-value input to the whole
search and the one thing this tool cannot replace. A limit that depends on
remembering is not a limit -- see CLAUDE.md, "a rule enforced by a document is
a rule waiting to be missed".

NOTHING HERE NAMES A SCHOOL. The search URLs arrive from the app
(/api/suggested/targets), which builds them from profile.json's
school_search_terms; this file only opens what it is handed.
"""
import argparse
import ctypes
import datetime as dt
import json
import os
import random
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from console import utf8_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
PAUSE_FILE = os.path.join(HERE, "PAUSE")
STATE_FILE = os.path.join(HERE, "state.json")

CDP_URL = os.environ.get("JOBOPS_CHROME_CDP", "http://127.0.0.1:9222")
API = os.environ.get("JOBOPS_API_URL", "https://YOUR-APP.vercel.app")
TOKEN = os.environ.get("JOBOPS_LOCAL_TOKEN")

# THE CAPS, and the ramp. Three a day while nobody has watched it run, five
# once it has behaved for a fortnight.
SEARCHES_FIRST_14_DAYS = 3
SEARCHES_AFTER = 5
RAMP_DAYS = 14
MAX_RESULTS = 20

# The window, and the idle rule. Both are about looking like a person using
# their own browser, because that is what this is.
WINDOW_START_HOUR = 13
WINDOW_END_HOUR = 18
IDLE_LIMIT_SECONDS = 30 * 60

DELAY_MIN = 5
DELAY_MAX = 30

# Two halts inside this many days and it turns itself off.
HALT_WINDOW_DAYS = 14
HALT_LIMIT = 2

# What a page looks like when LinkedIn has noticed. Any of these ends the day.
TROUBLE = (
    "captcha", "checkpoint", "unusual activity", "verify you", "security check",
    "let's do a quick security check", "sign in", "join now", "authwall",
    "we've restricted", "temporarily restricted", "please verify",
)


def say(m):
    print(m)


def now():
    return dt.datetime.now()


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"first_run": None, "halts": [], "runs": {}, "disabled": False}


def save_state(s):
    with open(STATE_FILE, "w", encoding="utf-8", newline="\n") as f:
        json.dump(s, f, indent=2)


def idle_seconds():
    """Seconds since the owner last touched keyboard or mouse. Windows only.

    The point is that the browser is only ever driven while they are AT the
    machine -- a session that acts on its own at 3am is the shape that gets
    noticed, and it is also not what the owner agreed to.
    """
    class LASTINPUTINFO(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(info)
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info)):
        # UNKNOWN IS NOT ZERO. If idle time cannot be read, the run is skipped
        # rather than assumed to be fine.
        return None
    ticks = ctypes.windll.kernel32.GetTickCount()
    return (ticks - info.dwTime) / 1000.0


def searches_allowed(state):
    first = state.get("first_run")
    if not first:
        return SEARCHES_FIRST_14_DAYS
    age = (now() - dt.datetime.fromisoformat(first)).days
    return SEARCHES_AFTER if age >= RAMP_DAYS else SEARCHES_FIRST_14_DAYS


def recent_halts(state):
    cutoff = now() - dt.timedelta(days=HALT_WINDOW_DAYS)
    return [h for h in state.get("halts", [])
            if dt.datetime.fromisoformat(h) > cutoff]


def gate(state, force_window=False, now_hour=None, idle=None):
    """Every reason not to run. `now_hour` and `idle` are injectable.

    NOT A CONVENIENCE. idle_seconds() reads real Windows input, so a test
    cannot make the machine idle -- and the mutation audit proved that: with
    the idle branch deleted outright, every assertion stayed green because
    none of them ever reached it. A limit no test can drive is a limit nobody
    knows works.
    """
    #
    # The reason is reported to the digest either way: "skipped because the
    # machine was idle" and "ran and found nothing" are different nights and
    # must not look alike.
    if os.path.exists(PAUSE_FILE):
        return False, "PAUSE file present. Delete jobops-local/PAUSE to resume."
    if state.get("disabled"):
        return False, ("the reader DISABLED ITSELF after two halts in "
                       f"{HALT_WINDOW_DAYS} days. Re-enable by setting "
                       "disabled=false in jobops-local/state.json.")
    halts = recent_halts(state)
    if len(halts) >= HALT_LIMIT:
        return False, (f"{len(halts)} halts in the last {HALT_WINDOW_DAYS} "
                       f"days. The paste box is the only path until re-enabled.")
    if state.get("runs", {}).get(now().date().isoformat()):
        return False, "already ran today."
    if not force_window:
        h = now().hour if now_hour is None else now_hour
        if not (WINDOW_START_HOUR <= h < WINDOW_END_HOUR):
            return False, (f"outside the {WINDOW_START_HOUR}:00-"
                           f"{WINDOW_END_HOUR}:00 window.")
        idle = idle_seconds() if idle is None else idle
        if idle is None:
            return False, "could not read idle time, so the run is skipped."
        if idle > IDLE_LIMIT_SECONDS:
            return False, (f"machine idle for {int(idle // 60)} minutes; the "
                           f"reader only runs while you are at it.")
    if not TOKEN:
        return False, "JOBOPS_LOCAL_TOKEN is not set, so nothing could be saved."
    return True, "ok"


def looks_wrong(text, url):
    """Is this a search page, or has LinkedIn noticed?

    JUDGED ON CONTENT, not on a status code. A checkpoint answers 200, and a
    login wall looks like a page that loaded fine -- the same lesson as board
    discovery and the parked domain.
    """
    low = (text or "").lower()[:6000]
    for marker in TROUBLE:
        if marker in low:
            return f"page looks like: {marker!r}"
    if "/checkpoint" in (url or "") or "/authwall" in (url or ""):
        return f"redirected to {url}"
    return None


def pause():
    d = random.uniform(DELAY_MIN, DELAY_MAX)
    time.sleep(d)
    return d


def post_suggestions(rows):
    """Send what was read to JobOps. Bearer token from the environment."""
    body = json.dumps({"people": rows}).encode("utf-8")
    req = urllib.request.Request(
        f"{API}/api/suggested", data=body, method="POST",
        headers={"content-type": "application/json",
                 "authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="check every gate and stop before opening a browser")
    ap.add_argument("--ignore-window", action="store_true",
                    help="for the supervised first run only")
    a = ap.parse_args()

    state = load_state()
    ok, why = gate(state, force_window=a.ignore_window)
    allowed = searches_allowed(state)
    say(f"searches allowed today: {allowed}")
    say(f"gate: {'OK' if ok else 'SKIP'} -- {why}")
    if not ok:
        # A SKIP IS REPORTED, NOT SILENT. The digest distinguishes "skipped,
        # machine was off" from "ran and found nothing".
        post_skip(why)
        return 0
    if a.dry_run:
        say("--dry-run: no browser was opened.")
        return 0

    from playwright.sync_api import sync_playwright

    targets = fetch_targets(allowed)
    if not targets:
        say("no target companies need contacts today.")
        return 0

    read = []
    halted = None
    with sync_playwright() as pw:
        # ATTACHES to the Chrome already running as the owner. It does not launch
        # one, and it cannot launch a headless one: connect_over_cdp has no
        # such mode. If Chrome is not running with the debugging port, this
        # raises and the run ends.
        browser = pw.chromium.connect_over_cdp(CDP_URL)
        ctx = browser.contexts[0]
        page = ctx.new_page()
        try:
            for t in targets:
                pause()
                page.goto(t["search_url"], wait_until="domcontentloaded",
                          timeout=45000)
                pause()
                trouble = looks_wrong(page.content(), page.url)
                if trouble:
                    halted = trouble
                    break
                rows = read_results(page, t)
                say(f"  {t['display_name']}: {len(rows)} results")
                read.extend(rows)
        finally:
            page.close()

    if halted:
        state.setdefault("halts", []).append(now().isoformat())
        if len(recent_halts(state)) >= HALT_LIMIT:
            state["disabled"] = True
        save_state(state)
        say(f"HALTED: {halted}")
        post_skip(f"HALTED: {halted}", red=True)
        return 1

    state.setdefault("runs", {})[now().date().isoformat()] = len(read)
    state["first_run"] = state.get("first_run") or now().isoformat()
    save_state(state)

    # ZERO ACROSS EVERY SEARCH IS RED, NOT "nothing new". A reader that
    # silently returns nothing for a fortnight occupies the slot while telling
    # you nothing -- the always-empty-source failure, three times over in this
    # project already.
    if not read:
        say("READ NOTHING across every search. That is this tool or a changed "
            "page, not five companies with no alumni.")
        post_skip("read 0 results across every search", red=True)
        return 1

    out = post_suggestions(read)
    say(f"sent {len(read)} people; server stored {out.get('stored', '?')}, "
        f"{out.get('duplicates', '?')} already known.")
    return 0


def post_skip(reason, red=False):
    try:
        body = json.dumps({"skipped": reason, "red": red}).encode("utf-8")
        req = urllib.request.Request(
            f"{API}/api/suggested", data=body, method="POST",
            headers={"content-type": "application/json",
                     "authorization": f"Bearer {TOKEN or ''}"})
        urllib.request.urlopen(req, timeout=20).read()
    except Exception:
        pass


def fetch_targets(limit):
    req = urllib.request.Request(
        f"{API}/api/suggested/targets?limit={limit}",
        headers={"authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8")).get("companies", [])


def read_results(page, target):
    """Name, headline, company, location, profile URL, from the result cards.

    PAGE ONE ONLY, and at most MAX_RESULTS. There is no pagination here and
    there is not going to be one.
    """
    cards = page.query_selector_all("li.reusable-search__result-container, "
                                    "div.entity-result, li.artdeco-list__item")
    out = []
    for c in cards[:MAX_RESULTS]:
        text = (c.inner_text() or "").strip()
        if not text:
            continue
        link = c.query_selector("a[href*='/in/']")
        url = (link.get_attribute("href") or "").split("?")[0] if link else ""
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        if not lines:
            continue
        out.append({
            "name": lines[0],
            "headline": " | ".join(lines[1:4]),
            "raw": " | ".join(lines[:8]),
            "profile_url": url,
            "company": target["display_name"],
            "company_slug": target["name"],
            "source": "linkedin_read",
        })
    return out


if __name__ == "__main__":
    sys.exit(main())
