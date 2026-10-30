"""Scoring submits and exits, and never pays for the same role twice.

Run: python test_async_scoring.py

WHY THIS EXISTS. daily #21 was cancelled at its 30-minute job timeout with the
scoring step 27m49s into a synchronous poll of the Batch API. The API offers no
latency guarantee below 24 hours, so blocking on it inside a timed job is wrong
by design rather than unlucky -- and the run died with a batch submitted, paid
for, and unread.

The old selection asked only "does this role have a score row yet". An
uncollected batch has written none, so the next run would have resubmitted
every role in it and bought the same six scores a second time. Nothing caught
that, because the blocking wait made it impossible for a run to END with a
batch outstanding -- the failure mode did not exist until the timeout created
it.

BEHAVIOURAL, THREE SIMULATED RUNS, one fake client standing in for the API. It
drives the real cmd_score and cmd_collect against a real (throwaway) database
and asserts what actually happened to the rows: nothing here reimplements the
selection or the reaper.
"""
import datetime as dt
import io
import json
import os
import sqlite3
import sys
import tempfile

from console import utf8_stdout

PASS = 0
FAILS = []


def ok(cond, what):
    global PASS
    if cond:
        PASS += 1
    else:
        FAILS.append(what)


# --------------------------------------------------------------- the fake API

class FakeMessage:
    def __init__(self, text):
        self.content = [type("B", (), {"type": "text", "text": text})()]
        self.usage = type("U", (), {
            "input_tokens": 100, "output_tokens": 50,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0})()


class FakeResult:
    def __init__(self, custom_id, text):
        self.custom_id = custom_id
        self.result = type("R", (), {"type": "succeeded",
                                     "message": FakeMessage(text)})()


class FakeBatches:
    """Records every call, so the test can assert what was NOT done."""

    def __init__(self, status="in_progress"):
        self.status = status
        self.created = []       # every submission
        self.retrieved = []     # every status check
        self.read = []          # every results() read
        self._n = 0

    def create(self, requests):
        self._n += 1
        bid = f"msgbatch_fake{self._n}"
        self.created.append((bid, [r["custom_id"] for r in requests]))
        return type("B", (), {"id": bid, "processing_status": "in_progress"})()

    def retrieve(self, batch_id):
        self.retrieved.append(batch_id)
        return type("S", (), {"processing_status": self.status})()

    def results(self, batch_id):
        self.read.append(batch_id)
        ids = dict(self.created)[batch_id]
        for cid in ids:
            yield FakeResult(cid, json.dumps({
                "score": 71, "tier": "good", "why": "fake",
                "gaps": [], "pitch": "fake"}))


class FakeClient:
    def __init__(self, status="in_progress"):
        self.messages = type("M", (), {})()
        self.messages.batches = FakeBatches(status)


# ---------------------------------------------------------------- the fixture

def seed(con, n=3):
    """n roles that the real selection will pick up."""
    for i in range(n):
        con.execute(
            "INSERT INTO jobs (key, company, slug, title, location, url, "
            " description, first_seen, candidate, triage, entry_level, tier) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"fake:{i}", "FakeCo", "fakeco", f"Product Manager, New Grad {i}",
             "Los Angeles, CA", f"https://example.invalid/{i}",
             "A role for a graduating senior. " * 20,
             "2026-09-08T00:00:00+00:00", 1, 1, "entry", 1))
    con.commit()


def main():
    utf8_stdout()
    import fetch_jobs
    import score_jobs

    tmp = os.path.join(tempfile.mkdtemp(prefix="jobops-async-"), "async.db")
    fetch_jobs.DB = tmp
    os.environ["JOBOPS_LOCAL_DB"] = "1"
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("DATABASE_URL_UNPOOLED", None)

    con = fetch_jobs.db()
    con.row_factory = sqlite3.Row
    seed(con)
    con.close()

    def batches():
        c = fetch_jobs.db()
        c.row_factory = sqlite3.Row
        rows = c.execute("SELECT * FROM batches ORDER BY submitted_at").fetchall()
        c.close()
        return rows

    def scored():
        c = fetch_jobs.db()
        n = c.execute("SELECT count(*) FROM scores").fetchone()[0]
        c.close()
        return n

    api = FakeClient(status="in_progress")

    # ---- RUN 1: submit, and do not wait. ---------------------------------
    score_jobs.cmd_score(limit=100, rescore_all=False, client=api)

    ok(len(api.messages.batches.created) == 1,
       f"run 1 submits exactly one batch ({len(api.messages.batches.created)})")
    rows = batches()
    ok(len(rows) == 1, f"and records it ({len(rows)} row(s))")
    ok(rows and rows[0]["collected_at"] is None,
       "uncollected, because it did not wait -- which is the whole point: "
       "blocking on a 24h-guarantee API inside a 30-minute job is what "
       "cancelled daily #21")
    ok(rows and json.loads(rows[0]["keymap"] or "{}"),
       "with a keymap, which is what makes exiting safe")
    ok(scored() == 0, "nothing is scored yet")
    ok(api.messages.batches.read == [],
       "and it never tried to READ its own batch -- that read is the poll "
       "that ran for 27m49s and took the job down with it")

    # ---- RUN 2: the batch is STILL processing. ---------------------------
    #
    # THE ASSERTION THAT MATTERS. The next run must pick the pending batch up
    # and must NOT submit those roles again -- they are already billed.
    before = len(api.messages.batches.created)
    api.messages.batches.retrieved.clear()
    score_jobs.cmd_score(limit=100, rescore_all=False, client=api)

    ok(api.messages.batches.retrieved,
       "run 2 RETRIEVES the pending batch before doing anything else")
    ok(len(api.messages.batches.created) == before,
       f"and submits NOTHING new -- the roles are in flight and already paid "
       f"for ({len(api.messages.batches.created)} total submissions, "
       f"expected {before})")
    ok(len(batches()) == 1, "so there is still exactly one batch row")

    # And the mechanism, directly: the keys are excluded by name.
    c = fetch_jobs.db()
    c.row_factory = sqlite3.Row
    flight = score_jobs.in_flight_keys(c)
    c.close()
    ok(len(flight) == 3, f"all three roles read as in flight ({len(flight)})")
    ok("fake:0" in flight, "by key, from the batch's own keymap")

    # ---- RUN 3: it ended. ------------------------------------------------
    api.messages.batches.status = "ended"
    score_jobs.cmd_score(limit=100, rescore_all=False, client=api)

    ok(scored() == 3, f"run 3 collects the results ({scored()} scored)")
    rows = batches()
    ok(rows and rows[0]["collected_at"], "and marks the batch collected")
    ok(rows[0]["in_tok"], "recording MEASURED usage, not an estimate")

    c = fetch_jobs.db()
    c.row_factory = sqlite3.Row
    ok(not score_jobs.in_flight_keys(c),
       "nothing is in flight once it is collected, so the roles are free "
       "again if they ever need re-scoring")
    c.close()

    # ---- THE REAPER ------------------------------------------------------
    #
    # A batch that has not ended 24h after submission is past the Batch API's
    # own guarantee and past its expires_at. Left uncollected it blocks every
    # role in its keymap from EVER being scored again -- silently, which is
    # the always-empty-source failure with a receipt attached.
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=30)) \
        .isoformat(timespec="seconds")
    # A ROLE THAT HAS NEVER BEEN SCORED, stuck in that batch. It has to be a
    # fresh one: a role that already has a score is excluded by the selection
    # anyway, so releasing it would prove nothing about the release.
    c = fetch_jobs.db()
    c.execute(
        "INSERT INTO jobs (key, company, slug, title, location, url, "
        " description, first_seen, candidate, triage, entry_level, tier) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ("fake:stuck", "FakeCo", "fakeco", "Associate Product Manager, New Grad",
         "Los Angeles, CA", "https://example.invalid/stuck",
         "A role for a graduating senior. " * 20,
         "2026-09-08T00:00:00+00:00", 1, 1, "entry", 1))
    c.execute(
        "INSERT INTO batches (batch_id, stage, model, n, submitted_at, keymap) "
        "VALUES (?,?,?,?,?,?)",
        ("msgbatch_stuck", "score", "claude-haiku-4-5-20251001", 1, old,
         json.dumps({"c0": ["fake:stuck", 0]})))
    c.commit()
    c.close()
    api.messages.batches.created.append(("msgbatch_stuck", ["c0"]))

    c = fetch_jobs.db()
    c.row_factory = sqlite3.Row
    ok("fake:stuck" in score_jobs.in_flight_keys(c),
       "a stuck batch blocks its roles while it is uncollected")
    c.close()

    api.messages.batches.status = "in_progress"
    before_submits = len(api.messages.batches.created)
    rc = score_jobs.cmd_score(limit=100, rescore_all=False, client=api)

    ok(rc == 1,
       f"a run that reaped returns NON-ZERO ({rc}) -- money was spent on roles "
       "that were never scored, and that must redden the step rather than "
       "pass as a quiet morning")

    # AND IT STILL DID THE RUN. The first version exited inside the collect,
    # so a reaping morning submitted nothing at all -- the reap cost that day's
    # scoring on top of the batch it was cleaning up after.
    ok(len(api.messages.batches.created) > before_submits,
       "and the run still SUBMITTED the released role rather than dying in "
       "the collect -- reaping must not also cost that morning's scoring")

    # And a collect with nothing stuck reports no reaping, so the non-zero
    # exit above is discriminating rather than always-on.
    api.messages.batches.status = "ended"
    ok(score_jobs.cmd_collect(wait=False, client=api) == [],
       "a collect with nothing stuck reports no reaping")

    c = fetch_jobs.db()
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT collected_at FROM batches WHERE batch_id=?",
                    ("msgbatch_stuck",)).fetchone()
    ok(row and row["collected_at"] and "REAPED" in row["collected_at"],
       f"the stuck batch is MARKED, not deleted ({row and row['collected_at']})")
    ok("fake:stuck" not in score_jobs.in_flight_keys(c),
       "and stops blocking, so the role can be scored again")
    c.close()

    # A YOUNG BATCH IS NOT REAPED. Without this the check is "reap everything
    # uncollected", which would throw away every batch the moment it is
    # submitted -- and the test above would still pass.
    c = fetch_jobs.db()
    c.execute(
        "INSERT INTO batches (batch_id, stage, model, n, submitted_at, keymap) "
        "VALUES (?,?,?,?,?,?)",
        ("msgbatch_young", "score", "claude-haiku-4-5-20251001", 1,
         score_jobs.now(), json.dumps({"c0": ["fake:1", 0]})))
    c.commit()
    c.close()
    # Registered with the fake API as well. It REFUSES to return results for a
    # batch it never created, and that strictness is deliberate: a lenient fake
    # yields nothing for an unknown id, and every "N collected" assertion in
    # this file would then pass over an empty read.
    api.messages.batches.created.append(("msgbatch_young", ["c0"]))
    # STILL PROCESSING, and minutes old. That is the pair of conditions the
    # reaper must distinguish from the stuck one above, which was also still
    # processing and differed ONLY in age.
    api.messages.batches.status = "in_progress"
    ok(score_jobs.cmd_collect(wait=False, client=api) == [],
       "a young batch that is still processing reaps nothing")
    c = fetch_jobs.db()
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT collected_at FROM batches WHERE batch_id=?",
                    ("msgbatch_young",)).fetchone()
    ok(row and row["collected_at"] is None,
       "a batch submitted minutes ago is LEFT ALONE, not reaped")
    c.close()

    # An unreadable timestamp is not a young batch.
    ok(score_jobs.batch_age_hours("not a date") is None,
       "an unparseable submitted_at reads as unknown age")
    ok(score_jobs.batch_age_hours(old) >= 24,
       "and a real one is measured in hours")

    print(f"{PASS} checks passed")
    if FAILS:
        print("\nFAILED:")
        for f in FAILS:
            print("  " + f)
        sys.exit(1)


if __name__ == "__main__":
    main()
