#!/usr/bin/env python3
"""Fetch pages with JavaScript, via web/render_page.mjs.

WHY THIS EXISTS. A plain GET cannot tell "this company has no job board" from
"the board link does not exist until React runs", and those are completely
different facts. Item 2 recorded six companies as unresolved on exactly that
ambiguity, and a16z's portfolio page returns 2,124 characters to requests and
6,422,131 to a browser -- a 3,000x difference that decides whether the whole
startup-discovery item is possible.

ONE BROWSER FOR MANY URLS. Chrome takes a second or two to launch; paying that
per page would make a 170-company sweep unbearable. The node side takes a list
and streams NDJSON back.

IT ABORTS RATHER THAN FALLING BACK. If Chrome is missing, this raises. A silent
fallback to requests would report every JavaScript page as having no board,
which is precisely the wrong answer dressed as a measurement -- the same shape
as a snapshot tool that measures nothing and diffs clean.
"""
import json
import os
import subprocess
import sys

from paths import repo

NODE_SCRIPT = repo("web/render_page.mjs")
# Generous: a browser launch plus a slow portfolio page plus two settles.
TIMEOUT_PER_URL = 75


def render(urls, timeout=None):
    """{url: html} for every url that rendered. Raises if Chrome is missing.

    A url that failed is simply absent from the result, and the reason is
    printed to stderr rather than swallowed -- a caller that sees fewer pages
    than it asked for should be able to find out why without re-running.
    """
    urls = [u for u in urls if u]
    if not urls:
        return {}
    if not os.path.exists(NODE_SCRIPT):
        raise SystemExit(f"render: {NODE_SCRIPT} is missing.")

    limit = timeout or (TIMEOUT_PER_URL * len(urls) + 30)
    try:
        p = subprocess.run(
            ["node", NODE_SCRIPT, *urls],
            cwd=repo("web"), capture_output=True, timeout=limit,
            # EXPLICIT utf-8, NOT text=True alone. text=True decodes with the
            # LOCALE codec, which on this machine is cp1252, and rendered HTML
            # is full of bytes cp1252 cannot represent -- it died on 0x9d at
            # position 160,478 of a16z's page. errors="replace" because a
            # mangled character in an href is still a usable href, and dying
            # on one byte in six megabytes would lose the whole page.
            #
            # This is the fifth time Windows text handling has broken something
            # here; see CLAUDE.md.
            encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        print(f"render: timed out after {limit}s over {len(urls)} url(s)",
              file=sys.stderr)
        return {}

    if p.returncode != 0 and not p.stdout.strip():
        raise SystemExit(
            f"render: the browser could not start.\n{p.stderr[:400]}\n"
            f"This ABORTS rather than falling back to a plain fetch, which "
            f"would report every JavaScript page as having no board.")

    out = {}
    for line in p.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("ok") and d.get("html"):
            out[d["url"]] = d["html"]
        else:
            print(f"render: {d.get('url')} -> {d.get('error')}", file=sys.stderr)
    return out


def render_one(url):
    return render([url]).get(url)
