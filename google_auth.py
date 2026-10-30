#!/usr/bin/env python3
"""One-time Google authorization. Prints ONLY the refresh token, to stdout.

  JOBOPS_GOOGLE_CLIENT_ID=... JOBOPS_GOOGLE_CLIENT_SECRET=... python google_auth.py

Everything else -- the URL to open, progress, errors -- goes to STDERR, so
`python google_auth.py > /dev/null` shows you the flow and nothing secret, and
`python google_auth.py | clip` puts exactly the token on the clipboard and
nothing else.

NOTHING IS WRITTEN TO DISK. No .env, no token cache, no log. The credentials
arrive as environment variables for one invocation and leave with the process.
The refresh token is printed once; if it scrolls away, run this again.

NO NEW DEPENDENCIES. Google's own client libraries would add three, and this is
a loopback OAuth flow: an HTTP redirect, a form POST, and the stdlib's own
server. `requests` is already in requirements.txt.

WHY LOOPBACK AND NOT A PASTED CODE. The out-of-band "copy this code" flow was
shut off by Google in 2022. A Desktop-app client is allowed to redirect to
127.0.0.1 on any port, which is what this listens on.
"""
import http.server
import os
import secrets
import socket
import sys
import threading
import urllib.parse
import webbrowser

import requests

from owner import OWNER

AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"

# Exactly the four the engine needs, and no more. gmail.readonly is the broad
# one: it is the whole mailbox, and Phase 4 matches replies by thread id from
# outreach_log so nothing else is ever parsed. The owner was told that before
# granting it.
SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
]


def say(msg):
    """Everything that is not the token goes to stderr."""
    print(msg, file=sys.stderr)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Catch(http.server.BaseHTTPRequestHandler):
    code = None
    state = None
    error = None

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        Catch.code = (q.get("code") or [None])[0]
        Catch.state = (q.get("state") or [None])[0]
        Catch.error = (q.get("error") or [None])[0]
        body = (b"<html><body style='font:16px system-ui;padding:3em'>"
                b"<h2>JobOps is authorized.</h2>"
                b"<p>Close this tab and go back to the terminal.</p>"
                b"</body></html>")
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_a):
        # The default handler logs the full request line, which contains the
        # authorization CODE. Silenced deliberately.
        pass


def main():
    cid = os.environ.get("JOBOPS_GOOGLE_CLIENT_ID")
    secret = os.environ.get("JOBOPS_GOOGLE_CLIENT_SECRET")
    if not cid or not secret:
        say("Set both, on this one command line:\n"
            "  JOBOPS_GOOGLE_CLIENT_ID=... JOBOPS_GOOGLE_CLIENT_SECRET=... "
            "python google_auth.py")
        return 1

    port = free_port()
    redirect = f"http://127.0.0.1:{port}"
    state = secrets.token_urlsafe(24)

    params = {
        "client_id": cid,
        "redirect_uri": redirect,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        # OFFLINE plus CONSENT, together. Without access_type=offline there is
        # no refresh token at all; without prompt=consent Google returns one
        # only on the FIRST authorization ever for this client, so a re-run
        # after a mistake silently yields nothing to store.
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    url = AUTH + "?" + urllib.parse.urlencode(params)

    server = http.server.HTTPServer(("127.0.0.1", port), Catch)
    threading.Thread(target=server.handle_request, daemon=True).start()

    # The address comes from profile.json (owner.email); JOBOPS_GOOGLE_ADDRESS
    # overrides it, the same way google_check.py reads its expected address.
    addr = os.environ.get("JOBOPS_GOOGLE_ADDRESS") or OWNER["email"] or "the account JobOps should send from"
    say(f"Opening the consent screen. Sign in as {addr} and approve.")
    say("If the browser does not open, paste this into it:\n")
    say(url + "\n")
    try:
        webbrowser.open(url)
    except Exception:
        pass

    say("waiting for the redirect...")
    for _ in range(600):
        if Catch.code or Catch.error:
            break
        threading.Event().wait(0.5)

    if Catch.error:
        say(f"\nGoogle refused: {Catch.error}")
        if "access_denied" in str(Catch.error) or "admin" in str(Catch.error):
            say("If that is an admin-policy error, STOP. The account's Google "
                "Workspace (a school or employer domain) is blocking "
                "third-party OAuth. Switch to a personal Gmail account; do not "
                "try to work around Workspace policy.")
        return 1
    if not Catch.code:
        say("\nNo code came back within five minutes.")
        return 1
    # STATE IS CHECKED. Without it a link from anywhere could drive this
    # listener; it is a local server, but a one-line check is cheaper than
    # reasoning about who can reach 127.0.0.1.
    if Catch.state != state:
        say("\nState mismatch. Refusing the response.")
        return 1

    say("exchanging the code...")
    r = requests.post(TOKEN, timeout=30, data={
        "code": Catch.code,
        "client_id": cid,
        "client_secret": secret,
        "redirect_uri": redirect,
        "grant_type": "authorization_code",
    })
    if r.status_code != 200:
        # The body can echo the request. Print the error field only.
        try:
            e = r.json()
            say(f"\nToken exchange failed: {e.get('error')} "
                f"{e.get('error_description', '')}")
        except Exception:
            say(f"\nToken exchange failed: HTTP {r.status_code}")
        return 1

    tok = r.json()
    refresh = tok.get("refresh_token")
    if not refresh:
        say("\nGoogle returned no refresh_token. That happens when this client "
            "was already authorized and prompt=consent was not honoured. "
            "Revoke JobOps at myaccount.google.com/permissions and run again.")
        return 1

    say("\nThe line below is the refresh token, and it is the only thing on "
        "stdout. Copy it into the GitHub secret, then clear your terminal.\n")
    # THE ONLY print() TO STDOUT IN THIS FILE.
    print(refresh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
