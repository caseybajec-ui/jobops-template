-- JobOps 013 — what each board actually returned, every day.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/013_board_fetches.sql
-- (The daily run applies every migration itself.)
--
-- WHY THIS EXISTS. cmd_fetch already knew every board's role count and every
-- board's error — it PRINTED them, into an Actions log nobody reads, and then
-- threw them away. So a company whose board quietly started returning zero was
-- indistinguishable from a company that simply had no new roles: same green
-- run, same freshness stamp, same silence. That is the project's own #1 failure
-- class, "an always-empty source and an always-zero count are the same bug",
-- sitting in the one place that talks to fifty-nine third parties every morning.
--
-- A COUNT ALONE CANNOT SAY WHETHER ZERO IS WRONG. Judgment Labs has 5 roles and
-- could legitimately go to 0 next week; Anduril going to 0 is a broken slug.
-- The only thing that distinguishes them is HISTORY — what this board returned
-- before — so the history is what gets stored, one row per board per run.
--
-- IT STORES THE OBSERVATION, NEVER A CONCLUSION. `n_roles` is what the board
-- said and `error` is what went wrong; neither field means "this is broken".
-- Whether a zero is an anomaly is decided at read time by boardAnomalies() in
-- web/lib/boards.js, against the rest of the history. That is the same rule as
-- a window check: a negative observation records that you looked, never what
-- you found.
--
-- ERROR AND ZERO ARE DIFFERENT ROWS AND MUST STAY DIFFERENT. A board that threw
-- HTTP 500 returned no information at all; a board that answered cleanly with 0
-- roles returned information. Collapsing them to `n_roles = 0` would lose the
-- distinction fetch_jobs.py already depends on for closed-detection — it
-- refuses to close roles on a board that errored, precisely because silence is
-- not evidence.
CREATE TABLE IF NOT EXISTS board_fetches (
    -- <day>:<source>:<slug>. Derived, so a run that is retried on the same day
    -- overwrites its own row instead of appending a second one.
    id           TEXT PRIMARY KEY,
    day          TEXT NOT NULL,         -- YYYY-MM-DD, UTC (the runner's clock)
    source       TEXT NOT NULL,         -- greenhouse | lever | ashby | rippling
    slug         TEXT NOT NULL,
    display_name TEXT,
    -- How many roles the board listed. NULL when the fetch ERRORED — which is
    -- not the same as 0, and the difference is the whole point of the table.
    n_roles      INTEGER,
    -- The failure, verbatim from cmd_fetch. NULL on success.
    error        TEXT,
    fetched_at   TEXT NOT NULL
);

-- The read is always "this board, most recent first", to compare today against
-- what it used to return.
CREATE INDEX IF NOT EXISTS board_fetches_board ON board_fetches (source, slug, day);
CREATE INDEX IF NOT EXISTS board_fetches_day ON board_fetches (day);
