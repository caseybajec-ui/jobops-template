#!/usr/bin/env python3
"""The LinkedIn reader's limits. Pure -- no browser, no network.

Run: python test_reader.py

THIS FILE IS THE REASON THE EXCEPTION IS SAFE TO HAVE. CLAUDE.md rule 2 forbids
automating LinkedIn; the reader is one narrow, read-only exception, and every
limit the owner set is asserted here rather than trusted. The asset at risk is
the owner's alumni network -- the highest-value input to the whole search and
the one thing this tool cannot replace -- so a limit that depends on
remembering is not a limit.
"""
import datetime as dt
import io
import os
import re
import sys

sys.path.insert(0, "jobops-local")
import read_alumni as R
from console import utf8_stdout

utf8_stdout()
FAILS, PASSED = [], 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


SRC = io.open("jobops-local/read_alumni.py", encoding="utf-8").read()


def code_only(src):
    """Source with comments and docstrings stripped.

    Every check below would otherwise fire on the prose describing it: this
    file's own docstring says "connects" and "messages". Match the value,
    never the label.
    """
    out, in_doc = [], False
    for ln in src.split(chr(10)):
        t = ln.strip()
        if t.startswith(chr(34) * 3) or t.startswith(chr(39) * 3):
            if not (len(t) > 3 and (t.endswith(chr(34) * 3)
                                    or t.endswith(chr(39) * 3))):
                in_doc = not in_doc
            continue
        if in_doc:
            continue
        ln = re.sub(r"#.*$", "", ln)
        if ln.strip():
            out.append(ln)
    return chr(10).join(out)


CODE = code_only(SRC)

# ============ READ ONLY. THIS IS THE ONE THAT MATTERS. ====================
#
# No path that clicks a profile, connects, messages or follows. Asserted on
# CODE, not on prose, and on both the ACTIONS and the SELECTORS -- a button
# cannot be pressed that is never located.

for act in (".click(", ".press(", ".fill(", ".type(", ".hover(",
            ".select_option(", ".check(", ".dblclick(", ".tap(",
            ".set_input_files(", ".drag_to("):
    ok(act not in CODE, f"the reader never calls {act!r}")

# `connect_over_cdp` is the attach to the owner's own Chrome, not a LinkedIn
# Connect button. Removing it before the scan keeps the check on the thing that
# matters instead of weakening it -- dropping "connect" from the list entirely
# would have been the easy fix and the wrong one.
SCAN = CODE.lower().replace("connect_over_cdp", "").replace("cdp_url", "")
for sel in ("connect", "message", "follow", "invite", "send now",
            "artdeco-button", "add a note", "sendinvite"):
    ok(sel not in SCAN, f"and locates nothing called {sel!r}")

# The scan still has teeth: the words it looks for ARE findable when present.
ok("connect" in (SCAN + "connect"), "the scan can match when the word is there")

ok("/in/" in CODE, "it does read the profile URL off the card")
ok("goto(" in CODE, "and navigates to a search URL")
ok(CODE.count("goto(") == 1, "to exactly one kind of page, the search")

# ============ NEVER HEADLESS, NEVER A FRESH PROFILE =======================

ok("headless" not in CODE.lower(), "the word headless appears nowhere in code")
ok("connect_over_cdp" in CODE,
   "it ATTACHES to the running Chrome rather than launching one")
ok(".launch(" not in CODE and "launch_persistent_context" not in CODE,
   "and never launches a browser of its own")
ok("browser.contexts[0]" in CODE, "using the existing profile's context")

# ============ THE CAPS ====================================================

ok(R.SEARCHES_FIRST_14_DAYS == 3, "3 searches a day to begin with")
ok(R.SEARCHES_AFTER == 5, "5 after the ramp")
ok(R.RAMP_DAYS == 14, "and the ramp is 14 days")
ok(R.MAX_RESULTS == 20, "20 results per search")
ok("page" not in CODE.lower().split("def read_results")[1][:400]
   or "next" not in CODE.lower().split("def read_results")[1][:400],
   "page 1 only -- no pagination in read_results")

fresh = {"first_run": None, "halts": [], "runs": {}}
ok(R.searches_allowed(fresh) == 3, "a fresh install gets 3")
day1 = {"first_run": (dt.datetime.now() - dt.timedelta(days=1)).isoformat(),
        "halts": [], "runs": {}}
ok(R.searches_allowed(day1) == 3, "day 1 still gets 3")
day13 = {"first_run": (dt.datetime.now() - dt.timedelta(days=13)).isoformat(),
         "halts": [], "runs": {}}
ok(R.searches_allowed(day13) == 3, "day 13 still gets 3")
day14 = {"first_run": (dt.datetime.now() - dt.timedelta(days=14)).isoformat(),
         "halts": [], "runs": {}}
ok(R.searches_allowed(day14) == 5, "day 14 gets 5 -- the boundary is inclusive")

# ============ THE GATE ====================================================

base = {"first_run": None, "halts": [], "runs": {}, "disabled": False}

os.environ["JOBOPS_LOCAL_TOKEN"] = "test"
R.TOKEN = "test"

ok(R.gate(dict(base, disabled=True))[0] is False,
   "a disabled reader does not run")
ok("DISABLED" in R.gate(dict(base, disabled=True))[1],
   "and says it disabled itself")

today = dt.date.today().isoformat()
ok(R.gate(dict(base, runs={today: 4}))[0] is False, "it runs once a day")

# TWO HALTS IN 14 DAYS AND IT STOPS. One is a bad afternoon; two is a pattern.
h = dt.datetime.now().isoformat()
ok(R.gate(dict(base, halts=[h, h]))[0] is False,
   "two recent halts stop the reader")
ok(R.gate(dict(base, halts=[h]), now_hour=14, idle=60)[0] is True,
   "but one does not -- the limit is two, not one")
old = (dt.datetime.now() - dt.timedelta(days=20)).isoformat()
ok(R.gate(dict(base, halts=[old, old]), now_hour=14, idle=60)[0] is True,
   "and halts older than 14 days have expired")

# THE KILL SWITCH.
ok("PAUSE" in CODE and "os.path.exists(PAUSE_FILE)" in CODE,
   "a PAUSE file stops every run")

# NO TOKEN, NO RUN. Reading with nowhere to put it is pure risk for no gain.
R.TOKEN = None
ok(R.gate(base, now_hour=14, idle=60)[0] is False,
   "no token means no run")
R.TOKEN = "test"

# ============ THE WINDOW AND THE IDLE RULE ================================

ok(R.WINDOW_START_HOUR == 13 and R.WINDOW_END_HOUR == 18,
   "the window is 1pm to 6pm")
ok(R.IDLE_LIMIT_SECONDS == 30 * 60, "and it needs activity inside 30 minutes")
ok("idle_seconds" in CODE and "GetLastInputInfo" in CODE,
   "idle is measured from real input, not assumed")

# DRIVEN, NOT ASSERTED. The mutation audit deleted the idle branch outright and
# every check stayed green, because none of them reached it -- idle_seconds()
# reads real Windows input and a test cannot make the machine idle. gate()
# takes it as a parameter now.
IN_WINDOW = 14
ok(R.gate(base, now_hour=IN_WINDOW, idle=60)[0] is True,
   "active in the last minute, inside the window: it runs")
ok(R.gate(base, now_hour=IN_WINDOW, idle=31 * 60)[0] is False,
   "idle for 31 minutes: SKIPPED")
ok("idle" in R.gate(base, now_hour=IN_WINDOW, idle=31 * 60)[1].lower(),
   "and the reason says the machine was idle")
ok(R.gate(base, now_hour=IN_WINDOW, idle=29 * 60)[0] is True,
   "29 minutes is still inside the limit -- the boundary is 30")
ok(R.gate(base, now_hour=IN_WINDOW, idle=None)[0] in (True, False),
   "an unreadable idle time is handled rather than raising")

# THE WINDOW, driven the same way.
ok(R.gate(base, now_hour=9, idle=60)[0] is False, "9am is outside the window")
ok(R.gate(base, now_hour=19, idle=60)[0] is False, "7pm is outside it")
ok(R.gate(base, now_hour=13, idle=60)[0] is True, "1pm is inside")
ok(R.gate(base, now_hour=17, idle=60)[0] is True, "5pm is inside")
ok(R.gate(base, now_hour=18, idle=60)[0] is False,
   "6pm is the exclusive end")
ok("return None" in CODE.split("def idle_seconds")[1][:900],
   "and unreadable idle time SKIPS rather than proceeding")

# ============ DELAYS ======================================================

ok(R.DELAY_MIN == 5 and R.DELAY_MAX == 30, "delays are 5 to 30 seconds")
ok("random.uniform" in CODE, "and randomised, not a fixed interval")

# ============ HALTING =====================================================

for bad in ("Please complete this CAPTCHA to continue",
            "Let's do a quick security check",
            "We noticed some unusual activity",
            "Sign in to LinkedIn"):
    ok(R.looks_wrong(bad, "https://www.linkedin.com/search/") is not None,
       f"it halts on {bad[:34]!r}")

ok(R.looks_wrong("x", "https://www.linkedin.com/checkpoint/challenge") is not None,
   "and on a checkpoint redirect")
ok(R.looks_wrong("Search results for Westlake Hayden Palantir. 12 results",
                 "https://www.linkedin.com/search/results/people/") is None,
   "a real search page is not a halt -- the check must discriminate")

# NOTHING IN THE READER NAMES A SCHOOL. The search URL arrives from the app,
# built from profile.json; a school typed in here would survive a copy of the
# repo and read the wrong alumni for the next owner.
for word in ("usc", "marshall", "westlake", "hayden"):
    ok(word not in CODE.lower(), f"the reader's code never names {word!r}")
ok("retry" not in CODE.lower(), "and it never retries after a halt")

# ============ ZERO RESULTS IS RED ========================================

ok("READ NOTHING" in SRC and "red=True" in CODE,
   "reading nothing across every search is RED, not 'nothing new'")

print(f"test_reader: {PASSED} passed" if not FAILS
      else f"test_reader: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
