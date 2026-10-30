#!/usr/bin/env python3
"""The retry that run #9 needed. Run: python test_reconnect.py

Run #9's `score` step opened a Postgres connection, polled a batch for eight
minutes, and died writing the results: Neon had closed the idle socket and
pg8000 raised InterfaceError from inside _store_run. The API call had already
been paid for.

TWO THINGS HAVE TO BE TRUE for the fix to be worth anything, and neither is
obvious from reading it:

  a connection error must be RETRIED, and a real database error must NOT be —
  retrying a constraint violation three times just produces it three times and
  buries the message that explains it;

  and the retry must open a FRESH connection each attempt, because the whole
  point is that the old one is dead.

This proves both by making a connection die on purpose. It needs no Postgres:
the failure is simulated at the boundary, which is where the real one happened.
"""
import sys

import pgdb
from console import utf8_stdout

import pg8000.exceptions as pgerr

PASS = []
FAIL = []


def ok(cond, what):
    (PASS if cond else FAIL).append(what)


def main():
    utf8_stdout()

    # ---------------------------------------------- what counts as retryable
    #
    # The exact exception run #9 died on.
    ok(pgdb.is_connection_error(pgerr.InterfaceError("network error")),
       "InterfaceError('network error') — the one run #9 hit — is retryable")
    ok(pgdb.is_connection_error(ConnectionResetError(10054, "forcibly closed")),
       "a reset socket is retryable")
    ok(pgdb.is_connection_error(BrokenPipeError("broken pipe")),
       "a broken pipe is retryable")
    ok(pgdb.is_connection_error(Exception("server closed the connection unexpectedly")),
       "and so is the bare-Exception form pg8000 sometimes raises")

    # AND THE OTHER HALF, which is the half that matters. A database saying
    # "no" is not a transport failure, and retrying it hides the reason.
    ok(not pgdb.is_connection_error(pgerr.DatabaseError(
        'duplicate key value violates unique constraint "scores_pkey"')),
       "a constraint violation is NOT retried")
    ok(not pgdb.is_connection_error(pgerr.DatabaseError("syntax error at or near")),
       "nor is a syntax error")
    ok(not pgdb.is_connection_error(ValueError("bad parameter")),
       "nor is a plain bug in our own code")

    # ------------------------------------------------- the retry itself
    #
    # `connect` is replaced so this needs no database at all. The failure is
    # injected exactly where the real one happened: inside the work, after the
    # connection was handed over.
    real_connect = pgdb.connect
    try:
        opened = []
        closed = []

        class FakeCon:
            def __init__(self, n):
                self.n = n

            def close(self):
                closed.append(self.n)

        def fake_connect():
            opened.append(len(opened) + 1)
            return FakeCon(len(opened))

        pgdb.connect = fake_connect

        # Dies twice on the transport, then succeeds.
        attempts = []

        def flaky(con):
            attempts.append(con.n)
            if len(attempts) < 3:
                raise pgerr.InterfaceError("network error")
            return "written"

        retried = []
        out = pgdb.with_reconnect(
            flaky, attempts=4, on_retry=lambda a, e: retried.append(a))

        ok(out == "written", "the write eventually succeeds")
        ok(attempts == [1, 2, 3], "and each attempt got a FRESH connection (%s)" % attempts)
        ok(len(opened) == 3, "three connections were opened, not one reused")
        ok(sorted(closed) == [1, 2, 3],
           "and every one was closed, including the dead ones (%s)" % sorted(closed))
        ok(retried == [1, 2], "the caller was told about each retry")

        # A REAL ERROR IS NOT RETRIED. One attempt, then it propagates.
        tries = []

        def broken(con):
            tries.append(con.n)
            raise pgerr.DatabaseError("duplicate key value")

        try:
            pgdb.with_reconnect(broken, attempts=4)
            ok(False, "a database error propagates")
        except pgerr.DatabaseError:
            ok(True, "a database error propagates")
        ok(len(tries) == 1, "and is attempted exactly once (%d)" % len(tries))

        # Exhausting the attempts raises the LAST error rather than swallowing
        # it — a retry that gives up quietly is worse than no retry.
        always = []

        def dead(con):
            always.append(1)
            raise pgerr.InterfaceError("network error")

        try:
            pgdb.with_reconnect(dead, attempts=2)
            ok(False, "giving up re-raises")
        except pgerr.InterfaceError:
            ok(True, "giving up re-raises rather than returning None")
        ok(len(always) == 2, "after exactly the requested number of attempts")

    finally:
        pgdb.connect = real_connect

    # ------------------------------------- the connection is not held over a wait
    #
    # The structural half of the fix, checked by reading the source: the wait
    # loop must not sit between an open and a commit. This is what actually
    # broke, and no unit test of the retry would have caught it.
    import io
    src = io.open("score_jobs.py", encoding="utf-8").read()
    # Sliced on the NAME, not the full signature. The first version pinned
    # "def cmd_collect(wait):" and broke the moment the function grew a client
    # parameter -- a test that fails on an unrelated signature change teaches
    # you to edit the test rather than read it.
    body = src[src.index("def cmd_collect("):src.index("def _retry_write(")]
    wait_at = body.index("time.sleep(60)")
    close_at = body.index("con.close()")
    ok(close_at < wait_at,
       "cmd_collect closes its connection BEFORE the batch wait loop")
    ok("_retry_write(write_batch" in body,
       "and the write goes through the retry wrapper")

    # --------------------------------- the same claim, EXECUTED rather than read
    #
    # The two assertions above are positions in a string, and they do not settle
    # the property they name. `close_at < wait_at` stays true if someone opens a
    # SECOND connection between the close and the wait — which is precisely the
    # bug, reintroduced, with the text still in the right order. It also stays
    # true if time.sleep(60) becomes time.sleep(0).
    #
    # Structure verified, value unverified. So run cmd_collect with the boundary
    # faked and watch what it actually does: every open, every close, every
    # sleep, in the order they happen. The assertion is not "close appears
    # earlier in the file" but "no connection was open while it waited".
    import json as _json
    import score_jobs

    events = []

    class FakeCursor:
        def __init__(self, rows): self._rows = rows
        def fetchall(self): return self._rows
        def fetchone(self): return self._rows[0] if self._rows else None

    # submitted_at is read by the reaper on the wait=False path: a batch still
    # processing is left alone unless it is past the 24h guarantee. "now" keeps
    # this fixture on the leave-it-alone side, which is the shape being tested.
    BATCH = {"batch_id": "batch_test", "keymap": _json.dumps({}), "model": "m",
             "stage": "score", "collected_at": None, "n": 1,
             "submitted_at": score_jobs.now()}

    class FakeCon:
        def __init__(self): events.append(("open",)); self.row_factory = None
        def execute(self, sql, *a):
            return FakeCursor([BATCH] if "FROM batches" in sql else [])
        def commit(self): pass
        def close(self): events.append(("close",))

    class FakeBatches:
        def __init__(self): self.n = 0
        def retrieve(self, _id):
            # in_progress once, so the wait loop runs exactly one iteration.
            self.n += 1
            return type("S", (), {"processing_status":
                                  "in_progress" if self.n == 1 else "ended"})()
        def results(self, _id): return []

    class FakeClient:
        def __init__(self, *a, **k): self.messages = type("M", (), {"batches": FakeBatches()})()

    real = (score_jobs.db, score_jobs.funnel, score_jobs.time.sleep,
            score_jobs.anthropic.Anthropic, pgdb.using_pg)
    try:
        score_jobs.db = lambda: FakeCon()
        score_jobs.funnel = lambda con: None
        score_jobs.time.sleep = lambda s: events.append(("sleep", s))
        score_jobs.anthropic.Anthropic = FakeClient
        pgdb.using_pg = lambda: False          # _retry_write takes the db() path
        score_jobs.cmd_collect(wait=True)
    finally:
        (score_jobs.db, score_jobs.funnel, score_jobs.time.sleep,
         score_jobs.anthropic.Anthropic, pgdb.using_pg) = real

    kinds = [e[0] for e in events]
    ok("sleep" in kinds,
       "the fake batch actually made cmd_collect wait — the path was exercised")

    # THE REAL PROPERTY: at the moment of every sleep, opens == closes, so
    # nothing was held. A connection opened and not closed before the wait makes
    # this negative, and no reading of source positions can.
    held_during_wait = []
    depth = 0
    for kind, *rest in events:
        if kind == "open":
            depth += 1
        elif kind == "close":
            depth -= 1
        elif kind == "sleep" and depth != 0:
            held_during_wait.append(depth)
    ok(not held_during_wait,
       "NO connection is open while cmd_collect waits "
       f"(open connections at each sleep: {held_during_wait or 'none'})")

    ok(all(s == 60 for k, *r in [e for e in events if e[0] == "sleep"] for s in r),
       "and the wait is a real 60 seconds, not a zero that would pass on position")

    # ---------------------------- AND wait=False NEVER SLEEPS AT ALL
    #
    # This is the shape the workflow runs, and it is the whole of item 2: the
    # scoring step must not block on a batch. daily #21 sat 27m49s in the loop
    # above and was cancelled at the 30-minute job timeout with the results
    # already paid for. The Batch API offers no latency guarantee below 24
    # hours, so no timeout makes that loop safe -- only not entering it does.
    events.clear()
    real = (score_jobs.db, score_jobs.funnel, score_jobs.time.sleep,
            score_jobs.anthropic.Anthropic, pgdb.using_pg)
    try:
        score_jobs.db = lambda: FakeCon()
        score_jobs.funnel = lambda con: None
        score_jobs.time.sleep = lambda s: events.append(("sleep", s))
        score_jobs.anthropic.Anthropic = FakeClient
        pgdb.using_pg = lambda: False
        score_jobs.cmd_collect(wait=False)
    finally:
        (score_jobs.db, score_jobs.funnel, score_jobs.time.sleep,
         score_jobs.anthropic.Anthropic, pgdb.using_pg) = real

    ok(not [e for e in events if e[0] == "sleep"],
       "cmd_collect(wait=False) NEVER sleeps — a batch still processing is "
       "left for the next run rather than polled inside a timed job")
    ok(events, "and it did run: the path was exercised, not skipped")

    print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
    for p in PASS:
        print("  ok    %s" % p)
    for f in FAIL:
        print("  FAIL  %s" % f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
