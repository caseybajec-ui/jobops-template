#!/usr/bin/env python3
"""Every node script a workflow runs must actually run there.
Run: python test_ci_scripts.py

WHY THIS EXISTS. Run #9's digest step died on ERR_MODULE_NOT_FOUND for
web/lib/config.generated.js — a file produced by the `prebuild` hook, gitignored
because it is generated, and never created on the runner because the runner
never builds the web app. That step could not have worked on any run. It was
written, committed, reviewed and deployed, and the first time anybody found out
was in production.

Nothing in the suite could have caught it, because every local check runs after
a build. The build IS the thing that hides it.

So this reads the workflows, finds every node script they invoke, and checks two
things a machine can settle:

  1. any script that (transitively) imports lib/config.generated.js must be
     preceded in its own job by a step that runs `genconfig`;

  2. the import graph is walked for real rather than grepped one level deep —
     notify.mjs imports it directly, but a script that merely imports db.js
     would inherit the dependency without naming it, which is precisely the
     shape that would slip through a shallow check.

It needs no node, no network and no build.
"""
import io
import os
import re
import shutil
import subprocess
import sys

import yaml

from console import utf8_stdout

WORKFLOWS = ".github/workflows"
WEB = "web"
GENERATED = "lib/config.generated.js"

PASS = []
FAIL = []


def ok(cond, what):
    (PASS if cond else FAIL).append(what)


def resolve(importer, spec):
    """A relative or @/ import, as a repo-relative path under web/."""
    if spec.startswith("@/"):
        return os.path.normpath(os.path.join(WEB, spec[2:])).replace("\\", "/")
    if spec.startswith("."):
        base = os.path.dirname(importer)
        return os.path.normpath(os.path.join(base, spec)).replace("\\", "/")
    return None                      # a package, not ours


IMPORT = re.compile(r"""(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]""")
DYNAMIC = re.compile(r"""import\(\s*['"]([^'"]+)['"]""")


def needs_generated(entry, seen=None):
    """Does this script reach lib/config.generated.js by any import path?"""
    seen = seen if seen is not None else set()
    path = entry if entry.startswith(WEB) else os.path.join(WEB, entry)
    path = path.replace("\\", "/")
    if path in seen:
        return False
    seen.add(path)
    try:
        src = io.open(path, encoding="utf-8").read()
    except OSError:
        return False
    for m in list(IMPORT.finditer(src)) + list(DYNAMIC.finditer(src)):
        target = resolve(path, m.group(1))
        if not target:
            continue
        if target.endswith("config.generated.js"):
            return True
        if not os.path.exists(target):
            continue
        if needs_generated(target, seen):
            return True
    return False


def mapped(workflow_path):
    """Every env var name the workflow actually maps, at any level.

    Parsed, because a substring search over the file is satisfied by a
    comment -- which is how the missing NEON_API_KEY mapping went on
    passing this very check after it was written to catch exactly that.
    """
    doc = yaml.safe_load(io.open(workflow_path, encoding="utf-8").read())
    names = set()

    def collect(node):
        if isinstance(node, dict):
            env = node.get("env")
            if isinstance(env, dict):
                names.update(str(k) for k in env)
            for v in node.values():
                collect(v)
        elif isinstance(node, list):
            for v in node:
                collect(v)

    collect(doc)
    return names


def walk_all(entry, seen=None):
    """Every module reachable from `entry`. Visits all of them.

    needs_generated() RETURNS EARLY the moment it finds its target, which
    is right for answering its own question and wrong for anything that
    wants the whole graph. Reusing it to collect modules gave a TRUNCATED
    set -- 6 modules instead of 18 for notify.mjs -- and the env-var check
    built on it passed while missing the exact variable it was written for.

    The positive assertion `len(seen) >= 1` was satisfied by the truncated
    walk, so it proved nothing. A count is not evidence that the right
    things were counted.
    """
    seen = seen if seen is not None else set()
    path = entry if entry.startswith(WEB) else os.path.join(WEB, entry)
    path = path.replace("\\", "/")
    if path in seen:
        return seen
    seen.add(path)
    try:
        src = io.open(path, encoding="utf-8").read()
    except OSError:
        return seen
    for m in list(IMPORT.finditer(src)) + list(DYNAMIC.finditer(src)):
        target = resolve(path, m.group(1))
        if target and os.path.exists(target):
            walk_all(target, seen)
    return seen


def main():
    utf8_stdout()

    files = [f for f in os.listdir(WORKFLOWS) if f.endswith((".yml", ".yaml"))]
    ok(len(files) >= 2, "found %d workflow file(s)" % len(files))

    checked = 0
    for f in files:
        doc = yaml.safe_load(io.open(os.path.join(WORKFLOWS, f), encoding="utf-8").read())
        for job_name, job in (doc.get("jobs") or {}).items():
            steps = job.get("steps") or []
            # Where genconfig first runs in this job, if at all.
            gen_at = None
            for i, s in enumerate(steps):
                if "genconfig" in str(s.get("run", "")):
                    gen_at = i
                    break

            for i, s in enumerate(steps):
                run = str(s.get("run", ""))
                for m in re.finditer(r"node\s+(lib/[\w./-]+\.mjs)", run):
                    script = m.group(1)
                    checked += 1
                    where = "%s:%s step %d (%s)" % (
                        f, job_name, i + 1, s.get("name") or "unnamed")
                    full = os.path.join(WEB, script).replace("\\", "/")
                    ok(os.path.exists(full),
                       "%s: %s exists" % (where, script))
                    if not needs_generated(script):
                        continue
                    # THE CHECK. This script cannot start without the generated
                    # module, so something before it has to have made one.
                    ok(gen_at is not None,
                       "%s: %s needs %s, so this job must run genconfig"
                       % (where, script, GENERATED))
                    # BEFORE means before, at whichever granularity applies.
                    # A step may run genconfig and the script in one `run:`
                    # block — notify-test.yml does — and there "before" is a
                    # position inside the shell script rather than a step index.
                    # The first version compared step indices only and reported
                    # that correct workflow as broken.
                    if gen_at == i:
                        earlier = run.index("genconfig") < m.start()
                    else:
                        earlier = gen_at is not None and gen_at < i
                    ok(earlier,
                       "%s: %s needs %s, and genconfig runs BEFORE it"
                       % (where, script, GENERATED))

    ok(checked > 0, "the workflows invoke %d node script(s) to check" % checked)

    # -----------------------------------------------------------------------
    # THE SAME CLAIM, EXECUTED: a missing generated module is FATAL.
    #
    # Everything above is positions in a YAML file. It asserts that genconfig
    # runs before a script that needs the generated module — and the word
    # "needs" is doing all the work. If a consumer ever swallowed the missing
    # import and carried on with a default, the ordering would still be green
    # and CI would still pass while the deployed meter read a made-up number.
    #
    # That is not hypothetical: it is the original bug. cost.js read config.yaml
    # at request time, a bare `catch {}` ate the ENOENT, and "1970-01-01" turned
    # every batch ever submitted into this month's spend — $29.88 / $5.00 OVER
    # CAP in red, deployed, against $3.17 locally. A default that changes what a
    # number MEANS is worse than a crash.
    #
    # So: take the generated module away and require that importing a consumer
    # FAILS. Both directions, because an assertion that only ever saw the broken
    # case cannot tell a real dependency from a broken command.
    import shutil
    import subprocess

    gen_path = os.path.join(WEB, GENERATED).replace("\\", "/")
    consumer = "./lib/cost.js"          # imports it directly, no side effects on load

    def import_consumer():
        r = subprocess.run(
            ["node", "--input-type=module",
             "-e", "await import('%s');" % consumer],
            cwd=WEB, capture_output=True, text=True)
        return r.returncode, (r.stderr or "")

    if not os.path.exists(gen_path):
        ok(False, "%s is missing — run `npm run genconfig` before this test" % GENERATED)
    else:
        # Control first: with the module present the import must SUCCEED.
        code, err = import_consumer()
        ok(code == 0,
           "with %s present, importing %s succeeds (exit %d)%s"
           % (GENERATED, consumer, code, ("\n         " + err.strip()[:200]) if code else ""))

        aside = gen_path + ".testaside"
        shutil.move(gen_path, aside)
        try:
            code, err = import_consumer()
            ok(code != 0,
               "with %s ABSENT, importing %s FAILS rather than defaulting quietly"
               % (GENERATED, consumer))
            ok("config.generated" in err or "ERR_MODULE_NOT_FOUND" in err,
               "and the failure names the missing module rather than dying vaguely\n"
               "         %s" % err.strip().splitlines()[0][:160] if err.strip() else
               "and the failure names the missing module")
        finally:
            # ALWAYS restored, including on an assertion failure above. Leaving
            # the tree without its generated module would break every later test
            # in this run and look like a different bug entirely.
            shutil.move(aside, gen_path)
        ok(os.path.exists(gen_path), "and the generated module is put back")

    # ---------------------------------------------------------------------
    # A MONITOR THAT CANNOT REPORT ITS OWN FAILURE IS NOT A MONITOR.
    #
    # Run #9 failed and both reporting steps still ran, which is the only
    # reason there is anything to fix rather than a silent bad morning. Three
    # properties make that work, all of them one careless edit from gone, and
    # none visible by reading a single line:
    #
    #   both reporting steps carry `if: always()` — without it a failed step
    #   skips everything after it, so the run that most needs reporting is
    #   exactly the run that reports nothing;
    #
    #   "Record the run" comes BEFORE "Email the digest", because the digest
    #   reads the status row the recorder writes. Reversed, the failure email
    #   would carry yesterday's status;
    #
    #   and neither may be the step that fails the job.
    daily = yaml.safe_load(
        io.open(os.path.join(WORKFLOWS, "daily.yml"), encoding="utf-8").read())
    dsteps = daily["jobs"]["run"]["steps"]
    names = [str(s.get("name") or "") for s in dsteps]

    def index_of(needle):
        for i, n in enumerate(names):
            if needle.lower() in n.lower():
                return i
        return None

    rec = index_of("Record the run")
    dig = index_of("Email the digest")
    scored = index_of("Score what survived")

    ok(rec is not None, "the workflow records what the run did")
    ok(dig is not None, "and emails a digest")
    if rec is not None and dig is not None:
        ok(str(dsteps[rec].get("if", "")).strip() == "always()",
           "Record the run has if: always(), so a failed run still records")
        ok(str(dsteps[dig].get("if", "")).strip() == "always()",
           "Email the digest has if: always(), so a failed run still emails")
        ok(rec < dig,
           "Record the run comes BEFORE Email the digest, so the alert reads "
           "this run's status and not yesterday's")
    if scored is not None and rec is not None:
        ok(scored < rec,
           "and both come after the step that can fail (Score what survived)")

    # EVERY REQUIRED STAGE REPORTS ITS OUTCOME, and this is the guard that
    # cannot live in a JS test.
    #
    # runCompleted() in notify.js falls back to the job status when a row has
    # no stages -- correctly, for rows written before the workflow reported
    # them. So if this interpolation is ever dropped, every future row gets
    # stages = NULL, every one of them takes the fallback, and partial-run
    # detection dies WITH THE ENTIRE SUITE STILL GREEN. daily #21 is the run
    # that shape hides: cancelled at the 30-minute timeout with scoring still
    # blocked on a batch poll, then recorded in one second as a row.
    if rec is not None:
        body = str(dsteps[rec].get("run") or "")
        # THE INVOCATION LINE, not the step body. The first version of this
        # check looked for "$STAGES" anywhere in the step and passed happily
        # with the argument deleted from the command -- the lines that BUILD
        # the variable still mention it. A guard satisfied by the setup for
        # the thing it is guarding is not a guard.
        call = [ln for ln in body.splitlines() if "recordrun.mjs" in ln]
        ok(len(call) == 1, "one line invokes recordrun.mjs")
        ok(call and "$STAGES" in call[0],
           "and it PASSES the stages argument -- without it every row falls "
           "back to the job status and a run that stopped partway is "
           "indistinguishable from one that finished")
        # notify.js decides which stages are required; the workflow must
        # actually report each of them, or the check silently reads undefined.
        notify = io.open(os.path.join("web", "lib", "notify.js"),
                         encoding="utf-8").read()
        m = re.search(r"REQUIRED_STAGES\s*=\s*\[([^\]]*)\]", notify)
        required = re.findall(r'"([^"]+)"', m.group(1)) if m else []
        ok(required, "notify.js names the stages a run must finish")
        step_ids = {str(s.get("id") or "") for s in dsteps}
        for stage in required:
            ok(stage in step_ids,
               f"the workflow has a step id '{stage}', so its outcome can be "
               f"reported -- notify.js requires it to have succeeded")
            ok(f"{stage}=${{{{ steps.{stage}.outcome }}}}" in body,
               f"and Record the run interpolates {stage}'s outcome")

    # THE GENERATED FILE IS NOT COMMITTED, which is the whole reason this can
    # go wrong. If that ever changes the check above becomes theatre, so it is
    # asserted rather than assumed.
    ok(not os.path.exists(os.path.join(WEB, GENERATED))
       or os.system("git check-ignore -q %s/%s" % (WEB, GENERATED)) == 0,
       "%s is gitignored, so a runner really does start without it" % GENERATED)

    # And the walker itself works: notify.mjs must come back True, and a module
    # that genuinely does not need it must come back False. Without this the
    # whole file could pass by finding nothing.
    ok(needs_generated("lib/notify.mjs"),
       "the import walker sees that notify.mjs needs the generated module")
    ok(not needs_generated("lib/applymigration.mjs"),
       "and that applymigration.mjs does not")

    # ===== THE GATE SAYS WHICH QUESTION IT IS ANSWERING ====================
    #
    # A red gate has two completely different meanings -- "your change is
    # wrong" and "nothing was checked" -- and on 2026-09-06, when the Neon
    # allowance ran out, they looked identical. A red you cannot explain is how
    # --no-verify becomes a habit, so the two are worded and coloured apart.
    #
    # BOTH STILL BLOCK, and that is asserted here rather than assumed: a
    # classifier that accidentally turned one of them into a pass would be far
    # worse than the confusion it was written to fix.
    lib = os.path.join(".githooks", "lib.sh")
    if not os.path.exists(lib) or not shutil.which("sh"):
        ok(False, "found .githooks/lib.sh and a POSIX sh to exercise it with")
    else:
        # Real failure text, from the real incidents where possible.
        cases = [
            ("quota", "{'S': 'ERROR', 'C': '53000', 'M': 'Your project has "
                      "exceeded the data transfer quota.'}", True),
            ("refused", "Error: connect ECONNREFUSED 127.0.0.1:5432", True),
            ("vpn", "OSError: [WinError 10054] connection forcibly closed", True),
            ("dns", "getaddrinfo EAI_AGAIN ep-x.neon.tech", True),
            ("shutdown", "FATAL: 57P01 terminating connection due to "
                         "administrator command", True),
            ("real", "FAIL title_ok('Software Engineer II') expected False", False),
        ]
        script = chr(10).join([
            "HOOK=TEST",
            '. "$1"',
            'fail_checked "test_filters.py" "$2"',
        ])
        for name, text, want_incon in cases:
            r = subprocess.run(["sh", "-c", script, "sh", lib, text],
                               capture_output=True, text=True)
            blob = r.stdout + r.stderr
            said = "GATE INCONCLUSIVE" in blob
            # THE ASSERTION THAT MATTERS: it blocks either way.
            ok(r.returncode != 0,
               "a %s failure still blocks the commit (exit %d)"
               % (name, r.returncode))
            ok(said == want_incon,
               "a %s failure reads as %s"
               % (name, "INCONCLUSIVE" if want_incon else "a real FAILURE"))
            if want_incon:
                ok("database unreachable" in blob,
                   "the %s message names the cause" % name)
            else:
                ok("FAILED" in blob and "INCONCLUSIVE" not in blob,
                   "a real regression still reads as FAILED and nothing else")
        # NO BYPASS. The point is that the gate keeps blocking; a flag or an env
        # var that skipped it would be the original bug wearing the fix's face.
        libsrc = io.open(lib, encoding="utf-8").read()
        tail = libsrc[libsrc.index("inconclusive()"):]
        ok("exit 1" in tail[:1200], "inconclusive() exits non-zero")
        ok("JOBOPS_SKIP" not in libsrc and "--no-db" not in libsrc,
           "and lib.sh offers no switch to skip an inconclusive gate")

    # BOTH GATES CLASSIFY, not just the fast one. pre-push is where the
    # browser stages live, and every one of them talks to Neon -- so it is if
    # anything MORE exposed to an outage reading as a regression. A call site
    # still using bare `fail` would print a red with no explanation, which is
    # the exact habit-forming failure this whole thing exists to remove.
    for hook in ("pre-commit", "pre-push"):
        hp = os.path.join(".githooks", hook)
        if not os.path.exists(hp):
            ok(False, "found .githooks/%s" % hook)
            continue
        body = io.open(hp, encoding="utf-8").read()
        # Strip comments, so prose about the old shape does not read as code.
        code = chr(10).join(l for l in body.split(chr(10))
                            if not l.lstrip().startswith("#"))
        ok("fail_checked" in code,
           "%s classifies its failures" % hook)
        # `fail "` is the unclassified form. `fail_checked "` is the good one,
        # and `fail()` itself is defined in lib.sh, not here.
        bare = [l.strip() for l in code.split(chr(10))
                if 'fail "' in l and "fail_checked" not in l]
        ok(not bare,
           "%s has no unclassified `fail` left (%d: %s)"
           % (hook, len(bare), "; ".join(bare)[:120]))

    # ===== A GENERATOR MUST NOT IMPORT WHAT IT GENERATES ===================
    #
    # genconfig.mjs WRITES lib/config.generated.js. It imported TRIGGERS from
    # notify.js, notify.js imports transfer.js, and transfer.js began reading
    # the baked allowance out of config.generated.js -- closing the loop:
    #
    #   genconfig -> notify.js -> transfer.js -> config.generated.js
    #                   ^                               |
    #                   +--------- which genconfig WRITES
    #
    # It ran perfectly on a laptop that had already built once, and would have
    # died with ERR_MODULE_NOT_FOUND on a fresh clone and on the Actions runner
    # -- the exact failure this file was written for, arriving by a new route.
    # It surfaced locally only because test_config.mjs builds its fixture in a
    # throwaway tree WITHOUT the generated file.
    #
    # needs_generated is the same walker used above, so this follows the chain
    # rather than grepping one level deep. The cycle was three hops long; no
    # shallow check would have seen it.
    for gen in ("lib/genconfig.mjs", "lib/genresumes.mjs"):
        if not os.path.exists(os.path.join(WEB, gen)):
            continue
        seen = set()
        reaches = needs_generated(gen, seen)
        ok(not reaches,
           "%s does not import the module it writes" % gen)
        # POSITIVE ASSERTION: the walk went somewhere. A walker that silently
        # returned nothing would satisfy the check above while proving nothing
        # -- the same shape as a snapshot tool measuring zero pages and
        # diffing clean.
        ok(len(seen) >= 1,
           "and the walk from %s examined %d module(s)" % (gen, len(seen)))

    # ===== AN UNMAPPED SECRET IS A SILENTLY MISSING VALUE ==================
    #
    # NEON_API_KEY existed in the repository's Actions secrets and the digest
    # still reported "Neon transfer: not being read" every night. A secret is
    # NOT an environment variable on the runner: Actions exposes only what a
    # step or job maps, and nobody had mapped it. lib/neonusage.mjs read
    # process.env.NEON_API_KEY, found nothing, and returned its no-key state --
    # which is the CORRECT behaviour and looks exactly like a missing secret.
    # The bug was a missing line in daily.yml, and nothing could tell the two
    # apart from the outside.
    #
    # So: every env var a workflow script reads, transitively, must be mapped
    # in that workflow -- or named here as deliberately optional, which is a
    # decision someone has to write down rather than an absence nobody notices.
    # TWO SHAPES, because the data layer uses the second one. driver.js does
    #   const env = { ...readEnv(), ...process.env };
    # and then reads env.DATABASE_URL_UNPOOLED -- so a pattern matching only
    # `process.env.NAME` sees nothing in the module that reads every
    # connection variable in the project. A guard blind to the dominant
    # spelling in the code it guards is not a guard.
    ENV_READ = re.compile(r"(?:process\.)?env\.([A-Z][A-Z0-9_]{2,})")

    # Vars that are legitimately absent on a runner. Each needs a reason.
    # VARS THAT MUST NEVER BE MAPPED, which is a stronger claim than optional.
    #
    # JOBOPS_PG_SCHEMA redirects every statement on a connection into a scratch
    # schema. test_runhistory.mjs sets it on the children it spawns so that
    # spawning the real recordrun cannot write into the real tables. Set in a
    # workflow it would silently point the whole nightly run at an empty
    # schema: the fetch would find no jobs, insert everything as new, and the
    # digest would report a triumphant morning about nothing.
    #
    # Exempting it from the mapping check would leave that possible. It is
    # asserted ABSENT instead, so the guard is stronger here rather than
    # weaker.
    ENV_FORBIDDEN = {"JOBOPS_PG_SCHEMA"}

    ENV_OPTIONAL = set(ENV_FORBIDDEN) | {
        # Set per-step where it applies; absent means "use the pooled URL".
        "JOBOPS_DIRECT",
        # Local-only opt-in for working against SQLite. Never set in CI.
        "JOBOPS_LOCAL_DB",
        # Node's own.
        "NODE_ENV", "CI", "TZ",
        # Next.js build plumbing, set by the build not by us.
        "NEXT_DIST_DIR", "VERCEL", "VERCEL_URL", "VERCEL_ENV",
        # The pooled connection string, used when JOBOPS_DIRECT is unset.
        "DATABASE_URL",
        # The Ask box's key. Deliberately NOT on the runner: the box is a web
        # surface only, and CLAUDE.md requires that key to reach exactly one
        # file. A digest step that could read it would be the second caller.
        "JOBOPS_ANTHROPIC_KEY",
        # Web-only: the password gate, set in Vercel not in Actions.
        "JOBOPS_PASSWORD", "JOBOPS_SESSION_SECRET",
    }

    total_found, total_walked = set(), set()

    # THE PYTHON STEPS TOO. ANTHROPIC_API_KEY is read by score_jobs.py, not
    # by anything under web/, so a node-only scan reported "every env var is
    # mapped" while blind to the most expensive secret in the project. A
    # guard that names a category it does not cover is worse than one that
    # claims less: it retires the worry without doing the work.
    #
    # No import walk on this side -- the CLIs all import fetch_jobs, so the
    # union over every tracked .py in the repo root is both simpler and
    # wider than following each entry point.
    PY_ENV = re.compile(
        "environ(?:" + chr(92) + ".get" + chr(92) + "(|" + chr(92) + "[)"
        + "[" + chr(34) + chr(39) + "]([A-Z][A-Z0-9_]{2,})")
    # PER WORKFLOW, over the CLIs THAT WORKFLOW RUNS.
    #
    # The first version scanned every .py in the repo root against
    # daily.yml alone, which is wrong in both directions: it demanded
    # daily.yml map google_check.py's secrets (run by google_check.yml),
    # and it would have missed a second workflow that mapped nothing at
    # all. A guard whose scope does not match the thing it guards reports
    # confidently about the wrong file.
    py_total = set()
    for wf_name in [f for f in os.listdir(WORKFLOWS)
                    if f.endswith((".yml", ".yaml"))]:
        wf_path = os.path.join(WORKFLOWS, wf_name)
        text = io.open(wf_path, encoding="utf-8").read()
        wanted = set()
        for script in re.findall(r"run:\s*python\s+(\S+\.py)", text):
            if not os.path.exists(script):
                continue
            try:
                wanted |= set(PY_ENV.findall(
                    io.open(script, encoding="utf-8").read()))
            except OSError:
                continue
        py_total |= wanted
        wanted -= ENV_OPTIONAL
        # Local tuning knobs, every one with a documented default in the
        # CLI that reads it. Absent on a runner is the INTENDED state.
        wanted -= {"JOBOPS_MODEL", "JOBOPS_PACK_MODEL", "JOBOPS_PACK_CACHE",
                   "PYTHONIOENCODING", "JOBOPS_BASE_URL", "JOBOPS_SKIP_DB",
                   "JOBOPS_EFFORT", "JOBOPS_SAMPLES", "JOBOPS_TRIAGE_MODEL",
                   "JOBOPS_CRITIC_MODEL", "JOBOPS_PREP_MODEL",
                   # Local-only: the reader runs on the owner's PC via Task
                   # Scheduler, never in Actions.
                   "JOBOPS_LOCAL_TOKEN", "JOBOPS_CHROME_CDP",
                   "JOBOPS_API_URL", "JOBOPS_SOURCE_MODEL",
                   # The address the check EXPECTS. It has a default in
                   # google_check.py and is only set to override it.
                   "JOBOPS_GOOGLE_ADDRESS"}
        missing_py = sorted(v for v in wanted if v not in mapped(wf_path))
        ok(not missing_py,
           "%s maps every env var its python CLIs read%s"
           % (wf_name, "" if not missing_py
              else " -- MISSING " + ", ".join(missing_py)))

    # WHAT THIS SIDE CANNOT SEE, said out loud: ANTHROPIC_API_KEY is never
    # read as a literal in python -- load_dotenv() puts it in the
    # environment and the anthropic SDK picks it up. It is mapped at job
    # level, and unlike NEON_API_KEY its absence fails LOUDLY with a 401.
    # Silent-failure vars are what this guard is for.
    ok(len(py_total) >= 2,
       "the python scan found %d var(s) across the workflows, so it read "
       "something" % len(py_total))

    # THE PYTHON STEPS TOO. ANTHROPIC_API_KEY is read by score_jobs.py, not by
    # anything under web/, so a node-only scan reported "every env var is
    # mapped" while blind to the single most expensive secret in the project.
    # A guard that names a category it does not cover is worse than one that
    # says less: it retires the worry without doing the work.

    for wf_name in [f for f in os.listdir(WORKFLOWS) if f.endswith((".yml", ".yaml"))]:
        wf_path = os.path.join(WORKFLOWS, wf_name)
        text = io.open(wf_path, encoding="utf-8").read()
        for step in re.findall(r"run:\s*node\s+(\S+)", text):
            entry = "%s/%s" % (WEB, step) if not step.startswith(WEB) else step
            if not os.path.exists(entry):
                continue
            seen = walk_all(entry)
            wanted = set()
            for mod in seen | {entry}:
                try:
                    body = io.open(mod, encoding="utf-8").read()
                except OSError:
                    continue
                wanted |= set(ENV_READ.findall(body))
            found_all = set(wanted)
            wanted -= ENV_OPTIONAL
            # AGAINST THE PARSED env BLOCKS, never the raw text.
            #
            # `v not in text` passed while NEON_API_KEY was unmapped,
            # because the COMMENT explaining why it must be mapped contains
            # the name. The check was satisfied by its own documentation --
            # the same shape as a secret-scanner that fires on the file
            # describing secrets, inverted into a false pass.
            #
            # env: appears at job level and step level and both count, so
            # the mapping is the union of every env block in the file.
            missing = sorted(v for v in wanted if v not in mapped(wf_path))
            ok(not missing,
               "%s: every env var %s reads is mapped in the workflow%s"
               % (os.path.basename(wf_path), step,
                  "" if not missing else " -- MISSING " + ", ".join(missing)))
            total_found |= found_all
            total_walked |= seen

    # AND THE FORBIDDEN ONES ARE ABSENT FROM EVERY WORKFLOW.
    #
    # Checked against the parsed env blocks AND the raw text, because this one
    # is dangerous wherever it appears -- a `run:` line exporting it would not
    # show up in an env: block at all.
    for f in sorted(os.listdir(WORKFLOWS)):
        if not f.endswith((".yml", ".yaml")):
            continue
        path = os.path.join(WORKFLOWS, f)
        text = io.open(path, encoding="utf-8").read()
        blocks = mapped(path)
        for var in sorted(ENV_FORBIDDEN):
            # The comment above names it, so the text check requires an
            # assignment rather than a mention -- the NEON_API_KEY lesson,
            # applied in the opposite direction.
            assigned = re.search(
                r"^\s*(?:%s\s*:|export\s+%s=|%s=)" % (var, var, var),
                text, re.M)
            ok(var not in blocks and not assigned,
               "%s does not set %s -- it redirects every query into a scratch "
               "schema, and a nightly run pointed at an empty one would fetch "
               "everything as new and report a triumphant morning about nothing"
               % (f, var))

    # THE POSITIVE ASSERTION, ONCE, ACROSS EVERY SCRIPT.
    #
    # Per-script it was WRONG: backfill_units.mjs legitimately reads no env
    # var by either spelling, so requiring one of every script failed a
    # correct file. Globally it is right and still has teeth -- if the walk
    # or the regex broke, the total goes to zero and this fails, which is
    # exactly what the first version could not detect.
    ok(len(total_found) >= 3,
       "the env scan found %d distinct var(s) across %d module(s) -- proof "
       "it read something rather than matching nothing"
       % (len(total_found), len(total_walked)))
    ok("NEON_API_KEY" in total_found,
       "including NEON_API_KEY, the one whose absence from daily.yml made "
       "the digest report 'not being read' every night"
       + ("" if "NEON_API_KEY" in total_found
          else " -- NOT FOUND, so the scan cannot see the case it exists for"))

    print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
    for p in PASS:
        print("  ok    %s" % p)
    for x in FAIL:
        print("  FAIL  %s" % x)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
