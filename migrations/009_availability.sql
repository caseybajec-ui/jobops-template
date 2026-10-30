-- JobOps 009 — how long he actually has today, and whether the cron worked.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/009_availability.sql
-- (The daily run applies every migration itself.)

-- HOW MANY HOURS TODAY.
--
-- The ladder already knows what each task costs — `minutes` is a stated field
-- on items and on the deadline windows, never inferred — and it has never known
-- what the owner has. So it offers a three-hour composite on a day with forty
-- minutes in it, and the honest answer to that is not a smaller task, it is
-- knowing to offer a smaller task.
--
-- ONE ROW PER DAY, keyed by the date. Answering twice replaces the answer:
-- "actually I have four hours now" is a correction, not a second fact.
--
-- UNANSWERED IS A REAL STATE and the most common one. No answer means no
-- trimming and no nagging — the page asks once and then leaves him alone,
-- because a question that reappears is one you learn to dismiss without
-- reading, and this one has to be worth reading on the day it matters.
CREATE TABLE IF NOT EXISTS daily_availability (
    day     TEXT PRIMARY KEY,       -- YYYY-MM-DD in the user's timezone
    hours   REAL NOT NULL,
    at      TEXT NOT NULL
);

-- DID THE CRON RUN, AND DID IT WORK.
--
-- Daily says "UPDATED 10 HOURS AGO", computed from the newest row in the jobs
-- table. That answers "is the data fresh" and cannot answer "did this morning's
-- run fail" — a failed run leaves yesterday's data looking exactly like a run
-- that had nothing new to fetch. The freshness stamp exists precisely to catch
-- silent staleness, so the one thing it must not do is report a failure as
-- calm.
--
-- SINGLE ROW, keyed 'last', written by the workflow itself at the end of the
-- run. `status` is whatever GitHub reports; `run_url` is the link to the log,
-- so "it failed" comes with somewhere to go.
CREATE TABLE IF NOT EXISTS pipeline_status (
    id          TEXT PRIMARY KEY,   -- always 'last'
    status      TEXT,               -- success | failure | cancelled
    run_url     TEXT,
    finished_at TEXT,
    note        TEXT
);
