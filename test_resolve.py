#!/usr/bin/env python3
"""The careers-page link extractor. Pure -- no network, no database.

Run: python test_resolve.py

`discover` GUESSES slugs. That is how EON got in -- `ashby/eon` answers with
seven roles belonging to an unrelated stealth space company -- how a public
Greenhouse DEMO board on the slug `shield` hid Shield AI's real Lever one, and
why Mistral stayed unresolved for weeks: its board is `ashby/mistral.ai`, and no
variant generator produces a slug with a dot in it.

`resolve` reads the company's OWN careers page instead. The link is the claim; a
posting's own text is the proof.
"""
import sys

import fetch_jobs
from console import utf8_stdout

utf8_stdout()
FAILS, PASSED = [], 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


CAREERS = """<!doctype html><html><body>
  <h1>Open roles</h1>
  <a href="https://jobs.ashbyhq.com/mistral.ai">See all roles</a>
  <a href="https://boards.greenhouse.io/anduril?gh_src=abc">Greenhouse</a>
  <a href="https://job-boards.greenhouse.io/scaleai">New Greenhouse</a>
  <a href="https://jobs.lever.co/palantir/">Lever</a>
  <a href="https://www.linkedin.com/company/x">LinkedIn</a>
  <a href="https://example.com/careers">Not an ATS</a>
</body></html>"""


def extract(html):
    out = []
    for m in fetch_jobs._BOARD_LINK.finditer(html):
        whole = m.group(1)
        if "ashbyhq" in whole:
            out.append(("ashby", m.group(2)))
        elif "lever" in whole:
            out.append(("lever", m.group(5)))
        else:
            out.append(("greenhouse", m.group(3) or m.group(4)))
    return out


hits = extract(CAREERS)
ok(("ashby", "mistral.ai") in hits,
   f"the DOTTED ashby slug is extracted, the one guessing never finds: {hits}")
ok(("greenhouse", "anduril") in hits, "boards.greenhouse.io")
ok(("greenhouse", "scaleai") in hits, "and job-boards.greenhouse.io, the newer host")
ok(("lever", "palantir") in hits, "jobs.lever.co")
ok(not any(h[1] == "company" for h in hits), "a LinkedIn link is not an ATS")
ok(len(hits) == 4, f"and nothing else matched ({len(hits)} hits)")

# A POSITIVE ASSERTION ABOUT THE PATTERN ITSELF. A regex matching nothing would
# satisfy every "not present" check above while proving nothing -- the same
# shape as a snapshot tool that measures zero pages and diffs clean.
ok(len(hits) > 0, "the extractor matched something, so its misses mean something")

# A page with NO ATS link yields nothing, which is exactly what all six
# unresolved companies return: they render their boards client-side.
NOBOARD = '<html><body><a href="/careers/apply">Apply here</a></body></html>'
ok(not extract(NOBOARD),
   "a client-side careers page yields no link, and that is reported as "
   "unresolved rather than guessed at")

# The tracking parameter must not become part of the slug.
ok(("greenhouse", "anduril") in hits,
   "?gh_src= is not swallowed into the slug")

print(f"test_resolve: {PASSED} passed" if not FAILS
      else f"test_resolve: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
