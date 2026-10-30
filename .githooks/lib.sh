# Shared by pre-commit and pre-push. Sourced, never run directly.
#
# WHY THE SUITE IS SPLIT. Measured 2026-09-03, per stage, on a clean dist:
#
#   python tests   32s | genconfig+genresumes  5s | js tests  68s | ask cap 21s
#   next build     36s | overflow  100s | /resumes 1s | controls 23s | tour 28s
#
# 5m34s total, and the browser stages plus the build that exists only to serve
# them are 188s of it — 56%. A gate that long gets run in the background, or
# with --no-verify, and then it is not a gate.
#
# PUSH IS THE BOUNDARY, not commit. A local commit is amendable and reaches
# nobody; a PUSH is what Vercel deploys from. So the build and the browser
# stages sit where the consequence is. The accepted cost is that a commit can
# land with a broken build — it cannot reach anyone until the push gate passes.

fail() { printf '\n  %s FAILED: %s\n\n' "$HOOK" "$1" >&2; exit 1; }

# A browser test, run again once if it fails.
#
# These boot a server, drive Chrome and hit Neon, and any of the three can be
# slow enough on one run to time out a navigation. Retrying once turns that into
# a passing gate instead of a red one nobody believes.
#
# IT SAYS SO, LOUDLY, WHEN IT RETRIES. A silent retry is how a test that fails
# half the time goes unnoticed for months — worse than the flake it hid. If the
# RETRIED line shows up often, that is a real signal, on screen.
browser_test() {
  if out=$(cd web && NEXT_DIST_DIR=$DIST node "$1" 2>&1); then
    return 0
  fi
  printf 'RETRYING... '
  if out=$(cd web && NEXT_DIST_DIR=$DIST node "$1" 2>&1); then
    printf 'ok on the second run — web/%s was FLAKY, not broken\n' "$1"
    return 0
  fi
  # DOES NOT PRINT. It leaves the failure in $out and returns 1, so the caller
  # can hand it to fail_checked, which decides whether this is a verdict on the
  # change or a database that never answered -- and does the printing either
  # way. Two printers meant the output appeared twice.
  return 1
}

# True when every file in $CHANGED ends .md or .txt.
#
# FAILS CLOSED. Only when at least one file changed at all; an empty list would
# otherwise satisfy "every file is a doc" vacuously. Stage one .py alongside and
# the full suite runs. Deliberately not a flag or an env var, because each of
# those is a thing a person reaches for on a day when the tests are inconvenient.
#
# It SAYS SO, loudly, every time. A skip nobody sees is how a docs-only change
# quietly becomes the way to avoid the suite.
docs_only=no
set_docs_only() {
  if [ -n "$CHANGED" ] && ! printf '%s\n' "$CHANGED" | grep -qvE '\.(md|txt)$'; then
    docs_only=yes
  fi
}

needs_db() {
  [ "$docs_only" = yes ] && return 0
  return 1
}

# ---------------------------------------------------------------------------
# "YOUR CODE IS WRONG" AND "NOTHING WAS ASKED" ARE DIFFERENT ANSWERS.
#
# On 2026-09-06 the Neon allowance ran out and the fast gate went red on
# test_filters.py. The gate was RIGHT to block -- with no database, the checks
# that need one verified nothing, and a commit that has not been checked is not
# a commit that passed. But it looked identical to a real regression, and a red
# you cannot explain is how `--no-verify` becomes a habit. That is the same
# failure as a nag you cannot answer: the gate stops being read.
#
# So the gate still blocks, always. It just says WHICH question it is answering.
#
# THIS IS NOT A BYPASS AND MUST NEVER GROW ONE. There is deliberately no env
# var, no flag and no auto-skip -- every one of those is a thing somebody
# reaches for on a day when the tests are inconvenient, which is exactly the
# day the gate is load-bearing. The only way past an inconclusive gate is a
# database that answers.
#
# Signatures of a database that did not answer, as opposed to one that answered
# with bad news. Postgres SQLSTATEs: 53000 insufficient resources (Neon's quota
# refusal), 57P01-03 admin shutdown / crash / cannot connect now, 08xxx
# connection exceptions. The rest are socket- and driver-level.
DB_DOWN_RE='exceeded the data transfer quota|53000|57P0[123]|08001|08006|08004|08P01|could not connect|Connection refused|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|WinError 10054|WinError 10060|Name or service not known|SSL connection has been closed|terminating connection|too many connections|Connection timed out|server closed the connection'

# Bold amber, and a different word. `fail` says FAILED; this says INCONCLUSIVE.
# Distinguishable by colour on a terminal and by wording anywhere else, because
# a hook's output gets piped into logs where escapes are noise.
inconclusive() {
  # -t 2, not -t 1: this writes to STDERR, so stderr is the stream whose
  # tty-ness decides whether escapes are readable or become noise in a log.
  if [ -t 2 ]; then y=$(printf '\033[1;33m'); n=$(printf '\033[0m'); else y=''; n=''; fi
  printf '\n%s  GATE INCONCLUSIVE: database unreachable, commit blocked%s\n' "$y" "$n" >&2
  printf '  %s could not reach the database, so it checked NOTHING.\n' "$1" >&2
  printf '  This is not a verdict on your change -- the gate has no opinion yet.\n\n' >&2
  printf '%s\n' "$2" | sed -n '1,6p' | sed 's/^/    /' >&2
  printf '\n  There is no flag for this, on purpose. Fix the database, then commit.\n\n' >&2
  exit 1
}

# Fail a check, saying which of the two things went wrong.
#
# Classifies on the OUTPUT of the check that actually ran, rather than opening
# its own connection to ask. A gate that probes the database to find out why the
# database is unhappy is one more consumer of the thing that ran out -- the same
# reason transfer_budget.py refuses to touch it.
fail_checked() {
  if printf '%s' "$2" | grep -qE "$DB_DOWN_RE"; then
    inconclusive "$1" "$2"
  fi
  printf '\n%s\n' "$2" >&2
  fail "$1"
}
