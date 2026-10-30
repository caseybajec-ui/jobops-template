#!/usr/bin/env python3
"""The page watcher. Pure -- no network, no database, no model.

Run: python test_watch.py

WHAT THIS GUARDS. Consulting, PM cohorts and the primes' LDPs have no
machine-readable board, so the only automatable signal is that the page moved.
Getting that wrong is expensive in both directions: a watcher that cries wolf
every night is ignored within a week, and one that silently reports "no change"
for a page it can no longer fetch occupies the slot while telling you nothing.
McKinsey's 2027 window closed on 11 August while companies.yaml said mid/late
September, and nothing in this repository noticed.
"""
import io
import sys

import watch_pages as W
from console import utf8_stdout

utf8_stdout()
FAILS, PASSED = [], 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


PAGE = """<!doctype html><html><head><title>Careers</title>
<script src="https://www.recaptcha.net/recaptcha/api.js?render=abc"></script>
<script>var cfg={apm:"rotations",tracking:"recaptcha-inline-body"};</script>
<style>.x{color:red}</style></head>
<body><nav>Home About Careers</nav>
<header>Big Marketing Banner</header>
<main>
  <h1>Associate Product Manager</h1>
  <p>Our APM programme runs for two years across three rotations.</p>
  <p>We look for graduates finishing in 2027.</p>
  <ul><li>Rotation one: growth</li><li>Rotation two: platform</li>
      <li>Rotation three: your pick</li></ul>
  <p>Applications are not yet open. Check back in the autumn.</p>
  <p>Questions: university-recruiting example</p>
  <p>Locations: New York, London, Sydney</p>
  <p>Compensation is competitive and reviewed annually.</p>
  <p>We hire across engineering, design and product.</p>
  <p>Our interview process has four stages.</p>
  <p>Mentorship is built into the programme.</p>
  <p>Alumni move into senior product roles.</p>
  <p>Read more about life here.</p>
  <p>Accessibility statement available.</p>
  <p>Ref 8f2a91c40b3e77d1aa generated 2026-09-07T02:11:04Z</p>
  <a href="/apply?v=abc123">Apply</a>
</main>
<footer>Copyright 2026. Build 8f2a91c40b3e77d1aa. Updated 2026-09-07T02:11:04Z</footer>
</body></html>"""


def variant(**kw):
    s = PAGE
    for old, new in kw.items():
        s = s.replace(old.replace("_", " "), new)
    return s


# The three shapes a watcher must never mistake for a page.
BOT = ("<html><head><title>Just a moment...</title></head><body>"
       "<h1>Checking your browser before accessing the site.</h1>"
       "<p>Please enable JavaScript and cookies to continue.</p></body></html>")
LOGIN = ('<html><body><form><input type="password" name="p">'
         '<p>Please log in to continue</p></form></body></html>')
SHELL = '<html><body><div id="root"></div></body></html>'


# ============ NORMALISATION: WHAT IS AND IS NOT A CHANGE ===================

base = W.normalize(PAGE)
ok(len(base) >= 15, f"a real page normalises to content lines ({len(base)})")
ok(any("Associate Product Manager" in ln for ln in base), "the heading survives")
# INLINE scripts are the case that matters. A one-line <script src> loses its
# attributes when tags are stripped whether or not the rule exists, so a fixture
# with only that kind could not tell a working rule from a deleted one.
ok(not any("recaptcha" in ln.lower() for ln in base), "scripts are stripped")
ok(not any("Big Marketing Banner" in ln for ln in base), "the header is stripped")
ok(not any("Home About Careers" in ln for ln in base), "the nav is stripped")

# UNCHANGED: the same page fetched twice must hash identically, or the section
# reports a change every night and becomes noise within a week.
ok(W.content_hash(W.normalize(PAGE)) == W.content_hash(base),
   "the same bytes hash the same")

# COSMETIC-ONLY: a new build id, a new timestamp, a new cache-buster. These
# change on EVERY request on a real careers page. If they moved the hash, every
# watched page would report a change nightly and the whole feature would be
# indistinguishable from a random number generator.
cosmetic = (PAGE.replace("8f2a91c40b3e77d1aa", "31de99b7710caa02ff")
                .replace("2026-09-07T02:11:04Z", "2026-09-08T03:47:19Z")
                .replace("?v=abc123", "?v=zzz999")
                .replace("render=abc", "render=xyz"))
ok(cosmetic != PAGE, "the cosmetic fixture really differs")
ok(W.content_hash(W.normalize(cosmetic)) == W.content_hash(base),
   "a new build id and timestamp do NOT count as a change")

# A REAL CHANGE: the sentence that matters.
real = PAGE.replace("Applications are not yet open. Check back in the autumn.",
                    "Applications are now open. Apply by 28 October 2026.")
ok(W.content_hash(W.normalize(real)) != W.content_hash(base),
   "a change to the visible text DOES move the hash")

# ============ THE DIFF SAYS WHAT MOVED =====================================

d = W.diff_summary(base, W.normalize(real))
ok("Applications are now open" in d, f"the diff shows the added line: {d[:70]}")
ok("not yet open" in d, "and the removed one")
ok("ADDED:" in d and "REMOVED:" in d, "labelled in both directions")

# CAPPED, AND IT SAYS SO. A page that redesigns produces a diff of its whole
# body; pasting that into an email is how a digest becomes unreadable.
big = W.diff_summary([], [f"line {i} of a complete redesign" for i in range(4000)])
ok(len(big) <= W.DIFF_CAP + 200, f"a huge diff is capped ({len(big)} chars)")
ok("TRUNCATED" in big, "and says that it truncated rather than trailing off")

# ============ THE STATUS REGEX =============================================

OPEN_RE = (r"(applications?\s+(?:are\s+)?(?:now\s+)?open"
           r"|now\s+accepting\s+applications|accepting\s+applications"
           r"|apply\s+by\s+\w+\s+\d|applications?\s+close)")
import re

closed_text = "\n".join(base)
open_text = "\n".join(W.normalize(real))
ok(not re.search(OPEN_RE, closed_text, re.I),
   "the regex does not match a page that says applications are NOT open")
ok(re.search(OPEN_RE, open_text, re.I),
   "and does match once the page says they are")

# THE FLIP IS THE EVENT, NOT THE STATE. A page that has said "apply now" for
# three months is not news every night.
# THE REAL FUNCTION, not a copy. A local reimplementation passed while the
# shipped code had the first-sight bug, because the two were never the same
# code -- the mutation audit is what surfaced it.
def flip(prev_hit, now_hit, first_sight=False):
    return W.window_opened(True, prev_hit, now_hit, first_sight)

ok(flip(0, 1), "absent -> present is a WINDOW OPENED")
ok(not W.window_opened(None, 0, 1, False),
   "a page with NO status_regex never reports one")
ok(not flip(1, 1), "present -> present is not")
ok(not flip(1, 0), "present -> absent is a closing, not an opening")
ok(not flip(0, 1, first_sight=True),
   "and a page already open on the night it is ADDED is not an opening -- "
   "four of the fifteen seeds reported one on the baseline run before this")

# ============ classify(): THE DECISION, NOT JUST THE PIECES ================
#
# These assertions run the real decision fetch() makes. The first version of
# this file checked normalize() and the marker regexes SEPARATELY, so the
# mutation audit could delete the JS-shell floor outright and every test stayed
# green -- the pieces were covered and the decision was not.

lines, err = W.classify(PAGE)
ok(err is None, f"a real page classifies clean, got {err!r}")
ok(lines and len(lines) >= 15, "and returns its content lines")

lines, err = W.classify(BOT)
ok(err is not None, "a bot interstitial is an ERROR, never 'no change'")
ok(lines is None, "and yields no lines to hash")

lines, err = W.classify(LOGIN)
ok(err is not None, f"a login wall is an error, got {err!r}")

lines, err = W.classify(SHELL)
ok(err is not None, "a JS shell is an error")
ok(err and "content lines" in err, f"naming the floor it failed, got {err!r}")

lines, err = W.classify("")
ok(err == "empty body", f"an empty body says so, got {err!r}")

lines, err = W.classify("   \n  \n ")
ok(err == "empty body", "and so does whitespace")

# THE REGRESSION THAT MATTERS, end to end: a page that merely loads reCAPTCHA
# must classify CLEAN. Checking the raw body here rejected Atlassian's and
# Adobe's real careers pages, both HTTP 200 with real content.
ok(W.classify(PAGE)[1] is None,
   "a page referencing recaptcha in a <script> still classifies clean")

# ============ FAILURE IS NEVER "NO CHANGE" =================================

# A bot interstitial: almost no content, and it says what it is.
lines = W.normalize(BOT)
ok(W._BOT_MARKERS.search("\n".join(lines)),
   "a bot-check page is recognised from its visible text")
ok(len(lines) < 15, "and would fail the content floor even if it were not")

# THE FALSE POSITIVE THAT BROKE TWO REAL PAGES. Atlassian and Adobe both load
# reCAPTCHA for their apply form, so the RAW html contains "captcha" -- and the
# first version of fetch() checked the raw body and rejected both healthy
# HTTP 200 pages with 85 and 75 lines of real content. A watcher that reports
# every good page as blocked is worse than no watcher.
ok(not W._BOT_MARKERS.search("\n".join(W.normalize(PAGE))),
   "a real page that merely LOADS recaptcha is not a bot check")
ok("recaptcha" in PAGE, "and the fixture really does reference it")

# A login wall.
ok(W._LOGIN_MARKERS.search(LOGIN), "a login wall is recognised")

# A JS shell: HTTP 200, no content. Ashby does this for ANY slug, which is
# already written into board discovery -- a 200 proves nothing.
ok(len(W.normalize(SHELL)) < 15, "a JS shell has no content to hash")

# A PARKED DOMAIN IS NOT THE COMPANY, and it is the hardest of these to see.
#
# chaosindustries.com returns "ChaosIndustries.com is for sale | HugeDomains".
# It loads, it has content, and it contains the company's own name -- so a
# name-match identity check CONFIRMS it. That is how it passed verification and
# would have become the site JobOps scraped for Chaos Industries' team page.
#
# The lesson is the board-discovery one again: a page that loads is not a page
# that is theirs, and the check has to look at what the page SAYS.
PARKED = ("<html><body><h1>ChaosIndustries.com is for sale</h1>"
          "<p>Buy this domain. HugeDomains.com</p>"
          + "<p>filler line to clear the content floor</p>" * 20
          + "</body></html>")
lines, err = W.classify(PARKED)
ok(err is not None, "a for-sale domain is an ERROR, not a company site")
ok(err and "parked" in err, f"and says why, got {err!r}")
ok(len(W.normalize(PARKED)) >= 15,
   "and it is caught on its WORDS, not on being short -- the fixture clears "
   "the content floor deliberately")

# The control: a real page that merely mentions selling something is fine.
SELLS = PAGE.replace("Locations: New York, London, Sydney",
                     "We sell software to enterprise customers.")
ok(W.classify(SELLS)[1] is None,
   "a company that sells things is not a parked domain")

# ============ THE ZERO-OUTPUT GUARD ========================================

src = io.open("watch_pages.py", encoding="utf-8").read()
ok("NOTHING WATCHED" in src,
   "an empty watch list reports that it checked nothing, rather than '0 changed'")
ok("EVERY page failed" in src,
   "and every page failing is reported as this tool, not as a quiet night")
ok("return 2" in src, "the empty case exits non-zero")

# NO MODEL IN THIS PATH, and it stays that way.
low = src.lower()
ok("anthropic" not in low and "claude" not in low,
   "the watcher calls no model -- a model reading a careers page produces a "
   "confident wrong date, which is the McKinsey failure in a new costume")

print(f"test_watch: {PASSED} passed" if not FAILS
      else f"test_watch: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
