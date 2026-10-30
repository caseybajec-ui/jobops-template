#!/usr/bin/env python3
"""Prove the three Google secrets work. Reads only. Sends nothing.

  python google_check.py

Run in Actions by .github/workflows/google_check.yml (workflow_dispatch).

WHAT IT PROVES, and each is a different failure:
  the refresh token still mints an access token   -> the token has not expired
  Gmail answers with the profile                  -> gmail.readonly is granted
  the address is the one expected                 -> it is the owner's address
                                                     from profile.json and not
                                                     some other account
  free/busy answers for tomorrow                  -> calendar.freebusy is granted

IT SENDS NOTHING, AND CANNOT. There is no call to messages.send anywhere in
this file, and test_google.py asserts that by reading the source -- a
verification script that could send is one nobody can run casually.

NO SECRET IS EVER PRINTED. The refresh token, the client secret and the access
token are read and used; the only identifying thing printed is the email
address, which is the entire point of running this.
"""
import datetime as dt
import os
import sys

import requests

from console import utf8_stdout
from owner import OWNER

TOKEN = "https://oauth2.googleapis.com/token"
PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile"
FREEBUSY = "https://www.googleapis.com/calendar/v3/freeBusy"

# The address this must authenticate as: the owner's, from profile.json, with
# an env override for the case where the Google account is deliberately a
# different one. Never a literal -- a template carrying one person's address
# would pass the check for them and fail it for everyone else, or worse, be
# edited to pass and then stop meaning anything.
EXPECT = os.environ.get("JOBOPS_GOOGLE_ADDRESS") or OWNER["email"]


def fail(msg):
    print(f"\nFAILED: {msg}")
    sys.exit(1)


def main():
    utf8_stdout()
    cid = os.environ.get("JOBOPS_GOOGLE_CLIENT_ID")
    secret = os.environ.get("JOBOPS_GOOGLE_CLIENT_SECRET")
    refresh = os.environ.get("JOBOPS_GOOGLE_REFRESH_TOKEN")

    # WHICH ONE IS MISSING, BY NAME. "auth failed" sends you to the wrong
    # place; three secrets means three different mistakes.
    missing = [n for n, v in (
        ("JOBOPS_GOOGLE_CLIENT_ID", cid),
        ("JOBOPS_GOOGLE_CLIENT_SECRET", secret),
        ("JOBOPS_GOOGLE_REFRESH_TOKEN", refresh)) if not v]
    if missing:
        fail("these secrets are not set on the runner: " + ", ".join(missing)
             + "\n  A secret existing in the repo is NOT an environment "
               "variable on the runner; the step has to map it. That exact "
               "mistake kept NEON_API_KEY invisible for weeks.")
    # NO EXPECTED ADDRESS, NO CHECK. An empty EXPECT would make the final
    # comparison fail on every address, or -- if it were skipped -- pass on
    # any account at all, which is the one outcome this script exists to catch.
    if not EXPECT:
        fail("no expected address: set `owner.email` in profile.json or "
             "JOBOPS_GOOGLE_ADDRESS on the runner.")

    print("1. minting an access token from the refresh token...")
    r = requests.post(TOKEN, timeout=30, data={
        "client_id": cid, "client_secret": secret,
        "refresh_token": refresh, "grant_type": "refresh_token",
    })
    if r.status_code != 200:
        try:
            e = r.json()
            fail(f"the refresh token was refused: {e.get('error')} "
                 f"{e.get('error_description', '')}\n"
                 f"  invalid_grant usually means the app is still in Testing "
                 f"(tokens die after 7 days) or access was revoked.")
        except Exception:
            fail(f"token endpoint returned HTTP {r.status_code}")
    access = r.json().get("access_token")
    if not access:
        fail("the token endpoint answered 200 with no access_token")
    print("   ok, and its scopes are: " + r.json().get("scope", "(not stated)"))

    auth = {"authorization": f"Bearer {access}"}

    print("2. reading the Gmail profile...")
    g = requests.get(PROFILE, headers=auth, timeout=30)
    if g.status_code != 200:
        fail(f"Gmail refused: HTTP {g.status_code}. "
             f"{'gmail.readonly is probably not granted.' if g.status_code == 403 else ''}")
    prof = g.json()
    addr = prof.get("emailAddress", "")
    print(f"   AUTHENTICATED AS: {addr}")
    print(f"   {prof.get('messagesTotal', '?')} messages, "
          f"{prof.get('threadsTotal', '?')} threads in the mailbox")

    print("3. reading calendar free/busy for tomorrow...")
    now = dt.datetime.now(dt.timezone.utc)
    start = (now + dt.timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=1)
    f = requests.post(FREEBUSY, headers=auth, timeout=30, json={
        "timeMin": start.isoformat().replace("+00:00", "Z"),
        "timeMax": end.isoformat().replace("+00:00", "Z"),
        "items": [{"id": "primary"}],
    })
    if f.status_code != 200:
        fail(f"Calendar refused: HTTP {f.status_code}. "
             f"{'calendar.freebusy is probably not granted.' if f.status_code == 403 else ''}")
    cal = f.json().get("calendars", {}).get("primary", {})
    if "errors" in cal:
        fail(f"Calendar answered with errors: {cal['errors']}")
    busy = cal.get("busy", [])
    print(f"   ok, {len(busy)} busy block(s) tomorrow "
          f"({start.date()}), which is a real answer either way")

    print("\n4. nothing was sent. This script has no send path.")

    # THE ADDRESS CHECK IS LAST AND IS A FAILURE, not a note. Authenticating as
    # the wrong account is the one outcome that looks like success and would
    # send the owner's outreach from somewhere they did not intend.
    if addr.lower() != EXPECT.lower():
        fail(f"authenticated as {addr}, expected {EXPECT}.\n"
             f"  Re-run google_auth.py and sign in as {EXPECT}, or set "
             f"JOBOPS_GOOGLE_ADDRESS if the address is meant to be different.")

    print(f"\nAll three secrets work, as {addr}. Nothing was sent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
