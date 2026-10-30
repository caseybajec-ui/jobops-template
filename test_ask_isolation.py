#!/usr/bin/env python3
r"""The Ask box is fenced in, and the fence is checked rather than described.

    python test_ask_isolation.py

SIX RULES, ALL STRUCTURAL. Each protects something a future session could undo
in one line without noticing, which is the whole reason they are a test and not
a paragraph in CLAUDE.md.

  1. Exactly ONE file reads JOBOPS_ANTHROPIC_KEY.
  2. Exactly ONE file names api.anthropic.com.
  3. NOTHING in the Ask call path reads ANTHROPIC_API_KEY — no fallback, not even
     as a last resort. That key belongs to the general pipeline and could one day
     be shared with another of the owner's projects.
  4. The Ask feature's OWN modules write exactly one table, and it is ask_queries.
  5. The route imports only READ functions from shared modules.
  6. The cap is read and COMPARED before the request is sent. A counter checked
     after the call has already spent the money it exists to prevent, and the
     two orderings look identical in review.

WHY 4 AND 5 ARE TWO RULES. The first version of this test checked "no file
reachable by import writes anything but ask_queries" and failed against
seventeen tables — because the route imports `curatedJobs` from lib/db.js, and
lib/db.js also *contains* setStage, recordAction and the rest. Importing a module
that holds write functions is not the same as being able to write, and a check
that cannot tell them apart is one that either fails forever or gets deleted.

So the property is split into the two halves that are actually true and actually
checkable: the feature's own code writes one table, and the route pulls only
reads out of the shared modules. Together those are the realistic threat — a
later session adding `import { setStage }` to the route fails rule 5 the moment
it is written.

WHAT IS NOT ASSERTED, stated so nobody reads more into a green run than is
there: this is static. It does not prove the route cannot write at runtime; a
read-only database connection would, and is the stronger build if it is ever
wanted. What it does prove is that no write can be introduced into this feature
without the diff tripping a test.
"""
import io
import os
import re
import sys

from console import utf8_stdout

WEB = "web"
ENTRY = "web/app/api/ask/route.js"
GATE = "web/lib/ask.js"
LOG = "web/lib/asklog.js"

# The feature's own modules — the code written for the Ask box and nothing else.
OWN = [ENTRY, GATE, LOG, "web/lib/askcontext.js"]

# Everything the route is allowed to import from a shared module. Every one is a
# SELECT. Adding a write function here is a deliberate act with a name attached.
ALLOWED_IMPORTS = {
    "ask", "askStatus", "buildContext",
    "curatedJobs", "bandCounts", "entryCounts", "windowChecks", "getSf86",
    # getSf86Affirmations is a SELECT — it loops AFFIRMABLE and calls
    # getSetting(), which is "SELECT value FROM settings WHERE key = ?" and
    # nothing else. Added with eyes open, which is what this list is for: the
    # route needs it because completeness() takes affirmations as its third
    # argument and the call site was dropping them.
    "getSf86Affirmations",
    "getDeadlines", "applyChecks", "listItems", "getPeople",
    "listActiveApplications", "completeness",
    "today", "GRADUATION", "USER_TZ", "NextResponse",
}

WRITE_RE = re.compile(r"\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_]\w*)", re.I)
IMPORT_FROM_RE = re.compile(r"""import\s+([^;]*?)\s+from\s+["']([^"']+)["']""")


def read(path):
    try:
        with io.open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def code(path):
    """The file with comments and docstrings blanked, newlines preserved.

    BOTH of this test's first two failures were PROSE. web/lib/ask.js says "it
    must never read ANTHROPIC_API_KEY" in a comment, and the route says the log
    "can INSERT into exactly one table" — which the write regex read as a table
    named `exactly`. A check that fires on its own documentation is a check you
    learn to skip, which is the same failure as a nag you cannot answer.
    """
    src = read(path)
    blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))
    src = re.sub(r"/\*[\s\S]*?\*/", blank, src)
    # NOT preceded by a colon. `https://api.anthropic.com` is not a comment, and
    # the first version of this stripper deleted the endpoint it exists to
    # police — reporting "found in: (nowhere)" for a constant sitting in plain
    # sight two lines below the thing that read it.
    src = re.sub(r"(?<!:)//[^\n]*", "", src)
    src = re.sub(r'"""[\s\S]*?"""', blank, src)
    src = re.sub(r"(?m)^\s*#[^\n]*", "", src)
    return src


def env_read(name, src):
    """Does this source actually READ that environment variable?

    Naming one in a sentence is not reading it. Matches the shapes this codebase
    uses: process.env.X, env.X, and either with bracket access.
    """
    return re.search(
        r"(?:process\s*\.\s*)?env\s*(?:\.\s*%s\b|\[\s*[\"']%s[\"']\s*\])" % (name, name),
        src) is not None


def resolve(spec, from_file):
    if spec.startswith("@/"):
        base = os.path.join(WEB, spec[2:])
    elif spec.startswith("."):
        base = os.path.normpath(os.path.join(os.path.dirname(from_file), spec))
    else:
        return None
    for cand in (base, base + ".js", base + ".mjs", os.path.join(base, "index.js")):
        if os.path.isfile(cand):
            return cand.replace("\\", "/")
    return None


def call_path(entry):
    seen, stack = set(), [entry]
    while stack:
        f = stack.pop()
        if f in seen or not os.path.isfile(f):
            continue
        seen.add(f)
        for _names, spec in IMPORT_FROM_RE.findall(read(f)):
            r = resolve(spec, f)
            if r:
                stack.append(r)
    return seen


def all_source():
    out = []
    for root, dirs, files in os.walk("."):
        # Any .next* directory is a build output. Enumerating them by name
        # (.next, .next-precommit, .next-verify) let a profiling build in
        # .next-profile through, and its minified chunks are not UTF-8.
        dirs[:] = [d for d in dirs if not d.startswith(".next") and d not in (
            "node_modules", ".git", "__pycache__", "snapshots", "out")]
        for f in files:
            if f.endswith((".js", ".mjs", ".jsx", ".ts", ".tsx", ".py")):
                out.append(os.path.join(root, f).replace("\\", "/").lstrip("./"))
    return out


def main():
    utf8_stdout()
    fails = []
    checked = 0
    me = os.path.basename(__file__)

    if not os.path.isfile(ENTRY):
        print(f"{ENTRY} does not exist — nothing to fence in")
        return 1

    path = call_path(ENTRY)
    sources = [f for f in all_source() if os.path.basename(f) != me]
    print(f"{len(path)} files reachable from {ENTRY}, {len(sources)} scanned repo-wide")

    # A walk or a scan that found nothing would pass every rule below.
    if len(path) < 5 or len(sources) < 20:
        print("\nTHE SCAN FOUND ALMOST NOTHING. Either the import walk or the file\n"
              "walk has stopped working, and every rule below would pass against\n"
              "an empty set.")
        return 1

    # --- 1: the key is read in exactly one file -----------------------------
    checked += 1
    holders = [f for f in sources if env_read("JOBOPS_ANTHROPIC_KEY", code(f))]
    if holders != [GATE]:
        fails.append(f"JOBOPS_ANTHROPIC_KEY must be READ in exactly one file, {GATE}.\n"
                     f"      read in: {holders or '(nowhere)'}")

    # --- 2: the endpoint is named in exactly one file -----------------------
    #
    # POLICING THE HOST REQUIRES NAMING IT. web/test_outbound.mjs carries the
    # allow-list that bans it everywhere else, so it necessarily contains the
    # string. Exempted BY NAME, with a reason, rather than by excluding every
    # test file — a blanket "tests do not count" is how a rule quietly stops
    # covering the thing somebody put in a test.
    POLICE = {"web/test_outbound.mjs"}
    checked += 1
    eps = [f for f in sources if "api.anthropic.com" in code(f) and f not in POLICE]
    if eps != [GATE]:
        fails.append(f"api.anthropic.com must appear in exactly one file, {GATE}.\n"
                     f"      found in: {eps or '(nowhere)'}")

    # --- 3: no fallback to the general key, anywhere in the path ------------
    checked += 1
    leaks = sorted(f for f in path if env_read("ANTHROPIC_API_KEY", code(f)))
    if leaks:
        fails.append(f"ANTHROPIC_API_KEY is READ inside the Ask call path: {leaks}\n"
                     "      There is no fallback of any kind. If JOBOPS_ANTHROPIC_KEY\n"
                     "      is unset the box is disabled and names the variable.")

    # --- 4: the feature's own modules write one table -----------------------
    checked += 1
    writes = {}
    for f in OWN:
        for table in WRITE_RE.findall(code(f)):
            writes.setdefault(table.lower(), set()).add(f)
    tables = sorted(writes)
    if tables != ["ask_queries"]:
        fails.append(
            f"the Ask feature's own modules may write exactly one table "
            f"(ask_queries); they write {tables or '(none)'}\n"
            + "".join(f"      {t}: {sorted(writes[t])}\n" for t in tables))
    elif writes["ask_queries"] != {LOG}:
        fails.append(f"only {LOG} may write ask_queries; also written by "
                     f"{sorted(writes['ask_queries'] - {LOG})}")

    # --- 5: the route imports only reads ------------------------------------
    checked += 1
    # `{ today as todayIn }` pulls the EXPORT `today`; `todayIn` is a local name.
    # Policing the alias would mean policing what the route calls things, which
    # is not the property — what it can REACH is.
    imported = set()
    for names, _spec in IMPORT_FROM_RE.findall(code(ENTRY)):
        body = names.replace("{", " ").replace("}", " ")
        for part in body.split(","):
            toks = [t for t in re.findall(r"[A-Za-z_]\w*", part) if t != "default"]
            if toks:
                imported.add(toks[0])
    unknown = sorted(imported - ALLOWED_IMPORTS)
    if unknown:
        fails.append(
            f"the route imports {unknown}, which is not on the read allow-list.\n"
            "      Every name the route pulls from a shared module must be a SELECT.\n"
            "      If one of these really is a read, add it to ALLOWED_IMPORTS with\n"
            "      your eyes open — that is the point of the list.")

    # --- 6: the cap is compared BEFORE the request is sent ------------------
    #
    # This is the substance of the whole cap. A counter read after the call has
    # already spent the money it exists to prevent, and the two orderings look
    # identical in review — both "check the cap and call the API", just in the
    # order the lines happen to sit.
    checked += 1
    # SCOPED TO ask(), not the whole file. The first version searched the module
    # and found `usedThisMonth(` inside askStatus() — which is defined above
    # ask() and has nothing to do with spending — so the ordering held no matter
    # where the real check sat. Moving the cap check after the fetch passed.
    whole = code(GATE)
    fn = whole.find("export async function ask(")
    gate = whole[fn:] if fn >= 0 else ""
    used_at = gate.find("usedThisMonth(")
    # The comparison itself, not merely the read: reading a counter and not
    # looking at it is the same as not reading it.
    cmp_at = min([i for i in (gate.find(">= ASK_CAP"), gate.find(">=ASK_CAP")) if i >= 0]
                 or [-1])
    fetch_at = gate.find("fetch(")
    if used_at < 0 or cmp_at < 0 or fetch_at < 0:
        fails.append(
            f"could not find the cap check and the request in {GATE} "
            f"(usedThisMonth={used_at}, comparison={cmp_at}, fetch={fetch_at}).\n"
            "      If these were renamed, rename them here too — this rule is\n"
            "      the reason the cap is a cap and not a suggestion.")
    elif not (used_at < cmp_at < fetch_at):
        fails.append(
            "the cap must be READ and COMPARED before the request is sent.\n"
            f"      usedThisMonth at {used_at}, comparison at {cmp_at}, "
            f"fetch at {fetch_at}.\n"
            "      A counter checked after the call has already spent the money.")

    print(f"{checked} structural rules checked")
    if fails:
        print(f"\n{len(fails)} FAILED\n")
        for f in fails:
            print("  " + f + "\n")
        return 1
    print(f"  JOBOPS_ANTHROPIC_KEY and api.anthropic.com live only in {GATE}")
    print("  nothing in the call path reads ANTHROPIC_API_KEY")
    print(f"  the feature writes one table, ask_queries, only from {LOG}")
    print(f"  the route imports {len(imported)} names, all of them reads")
    return 0


if __name__ == "__main__":
    sys.exit(main())
