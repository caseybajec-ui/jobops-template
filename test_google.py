#!/usr/bin/env python3
"""The Google auth path. Pure -- no network, no browser, no secrets needed.

Run: python test_google.py

Two files handle credentials here, and each has one property that matters more
than anything it does: google_auth.py must print ONLY the refresh token, and
google_check.py must be incapable of sending mail. Both are asserted by reading
the source, because neither can be exercised without real credentials -- and a
check nobody can run is a check nobody runs.
"""
import io
import os
import re
import sys

from console import utf8_stdout

utf8_stdout()
FAILS, PASSED = [], 0

TRIPLE_D = chr(34) * 3
TRIPLE_S = chr(39) * 3


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


AUTH_RAW = io.open("google_auth.py", encoding="utf-8").read()
CHECK_RAW = io.open("google_check.py", encoding="utf-8").read()
WF_RAW = io.open(".github/workflows/google_check.yml", encoding="utf-8").read()


def code_only(src):
    """The source with comments and docstrings removed.

    EVERY ONE OF THESE CHECKS FAILED ON ITS OWN DOCUMENTATION FIRST. The
    file that says "there is no call to messages.send anywhere in this
    file" contains that string; the workflow comment "No schedule"
    contains `schedule`. A check that fires on the prose explaining it is
    a check you learn to skip -- CLAUDE.md names this exact failure, from
    the secret scanner that flagged its own README.

    Match the VALUE, never the label.
    """
    out = []
    in_doc = False
    for ln in src.split(chr(10)):
        t = ln.strip()
        opener = t.startswith(TRIPLE_D) or t.startswith(TRIPLE_S)
        if opener:
            closes = len(t) > 3 and (t.endswith(TRIPLE_D)
                                     or t.endswith(TRIPLE_S))
            if not closes:
                in_doc = not in_doc
            continue
        if in_doc:
            continue
        ln = re.sub(r"#.*$", "", ln)
        if ln.strip():
            out.append(ln)
    return chr(10).join(out)


AUTH = code_only(AUTH_RAW)
CHECK = code_only(CHECK_RAW)
WF = code_only(WF_RAW)

# ============ THE VERIFIER CANNOT SEND ====================================
#
# It is run to confirm access works, which is exactly the moment somebody is
# least suspicious of it. If it could send, a routine check would put mail in
# a stranger's inbox.

for bad in ("messages/send", "messages.send", "gmail/v1/users/me/messages",
            "smtplib", "sendgrid", "resend"):
    ok(bad not in CHECK, f"google_check.py has no {bad!r} -- it cannot send")

ok("sends nothing" in CHECK_RAW.lower(),
   "and says so in its own docstring")
# The only Gmail endpoint it touches.
gmail_urls = re.findall('https://gmail[.]googleapis[.]com/[A-Za-z0-9/_-]+', CHECK)
ok(gmail_urls == ["https://gmail.googleapis.com/gmail/v1/users/me/profile"],
   f"the only Gmail endpoint is the profile read, got {gmail_urls}")

# ============ THE AUTHORIZER PRINTS ONLY THE TOKEN ========================
#
# `python google_auth.py | clip` must put the token on the clipboard and
# nothing else, so every other line goes to stderr.

# A print routed to stderr is not a print to STDOUT. What matters is that
# exactly one line can reach the clipboard.
stdout_prints = [ln.strip() for ln in AUTH.split(chr(10))
                 if re.match(r"\s*print\(", ln)
                 and "sys.stderr" not in ln]
ok(len(stdout_prints) == 1,
   f"exactly one print() to stdout in google_auth.py, found "
   f"{len(stdout_prints)}: {stdout_prints}")
ok("print(refresh)" in AUTH, "and it prints the refresh token")
ok("file=sys.stderr" in AUTH, "everything else goes to stderr")

# NOTHING IS WRITTEN TO DISK. No token cache, no .env, no log.
# `.env` as a substring matches os.environ.get, which is how the secrets are
# READ and is exactly right. The thing being forbidden is persisting to a
# dotenv FILE, so the check names dotenv and the quoted filename.
for w in ("open(", "write(", "dotenv", '".env"', "'.env'"):
    hits = [ln for ln in AUTH.split(chr(10))
            if w in ln and not ln.strip().startswith("#")
            and "webbrowser.open" not in ln and "self.wfile.write" not in ln]
    ok(not hits, f"google_auth.py never uses {w!r} to persist anything: {hits[:1]}")

# THE HTTP LOG IS SILENCED. The default handler logs the request line, which
# carries the authorization CODE.
ok("def log_message" in AUTH, "the loopback server's request log is silenced")

# offline AND consent, together. Without offline there is no refresh token at
# all; without consent Google returns one only on the first authorization ever,
# so a re-run after a mistake silently yields nothing.
ok('"access_type": "offline"' in AUTH, "access_type=offline is requested")
ok('"prompt": "consent"' in AUTH, "and prompt=consent, so a re-run works")
ok("state" in AUTH and "State mismatch" in AUTH,
   "the OAuth state is generated and CHECKED")

# ============ THE SCOPES ARE THE FOUR AGREED ==============================

scopes = re.findall(r"auth/([a-z.]+)", AUTH)
want = {"gmail.send", "gmail.readonly", "calendar.events", "calendar.freebusy"}
ok(set(scopes) == want, f"exactly the four agreed scopes, got {sorted(set(scopes))}")

# ============ THE WORKFLOW MAPS EVERY SECRET ==============================
#
# A secret in the repository is not an environment variable on the runner.
# NEON_API_KEY sat in settings for weeks while the digest reported it missing.

for name in ("JOBOPS_GOOGLE_CLIENT_ID", "JOBOPS_GOOGLE_CLIENT_SECRET",
             "JOBOPS_GOOGLE_REFRESH_TOKEN"):
    ok(f"{name}: ${{{{ secrets.{name} }}}}" in WF,
       f"the workflow maps {name} into the step's env")
    ok(name in CHECK, f"and google_check.py reads {name}")

ok("workflow_dispatch" in WF, "it runs on demand")
ok("schedule" not in WF, "and never on a schedule -- nobody reads an automatic check")

# ============ IT REFUSES THE WRONG ACCOUNT ================================
#
# Authenticating as the wrong address is the one outcome that looks like
# success and would send outreach from an account the owner did not intend.
#
# THE ADDRESS COMES FROM profile.json, NEVER FROM THE SOURCE. A literal address
# in a template passes the check for one person and fails it for everyone
# else -- or gets edited to pass and then means nothing.
import google_check as GC
from owner import OWNER
ok('OWNER["email"]' in CHECK, "the expected address is read from owner.py")
ok(not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", CHECK),
   "and no email address is written into google_check.py's code")
ok(not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", AUTH),
   "nor into google_auth.py's code")
ok(GC.EXPECT == (os.environ.get("JOBOPS_GOOGLE_ADDRESS") or OWNER["email"]),
   f"EXPECT resolves to the owner's address ({GC.EXPECT!r}), env override first")
ok("JOBOPS_GOOGLE_ADDRESS" in CHECK, "with an env override for a different account")
ok("expected" in CHECK and "fail(" in CHECK,
   "and a mismatch FAILS rather than printing a note")
ok("if not EXPECT" in CHECK, "and an EMPTY expected address fails too, "
   "rather than matching nothing or everything")

print(f"test_google: {PASSED} passed" if not FAILS
      else f"test_google: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
