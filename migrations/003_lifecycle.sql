-- JobOps 003 — what happened after "worth a look".
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/003_lifecycle.sql
--
-- Until now a role was either visible or not. There was a per-POSTING
-- `applications.stage` column, written by a select in the expanded row, and it
-- held one value with no history — so "applied 3 weeks ago and heard nothing"
-- and "applied yesterday" were the same fact, and nothing on any page could
-- tell them apart.
--
-- INSERT-ONLY, keyed by the role's GROUP key, like `actions`. Two reasons:
--
--   1. The history is the point. Days-in-stage is the number that says whether
--      to nudge, and it cannot be computed from a column that only holds where
--      something is now.
--
--   2. The group key is the role's identity. Palantir lists "Deployment
--      Strategist, Build to Apply - US Government" in six cities and re-ids the
--      postings when they churn; applying is something you did to the ROLE.
--      Save, Hide and Applied are already stored this way, so a lifecycle keyed
--      on a job key would have been the one thing in the app that forgot which
--      role it was about the next time the board refreshed.
--
-- HOW THIS RELATES TO applications.stage, which is NOT dropped and NOT stopped:
-- recordRoleEvent() keeps writing it for the statuses that have an equivalent
-- there, so the Companies page — which reads it — stays current. Where the two
-- vocabularies do not line up, applications.stage is left alone rather than
-- being given an approximate value. See LIFECYCLE_TO_STAGE in lib/db.js.
--
-- The brief asked for a `saved` status at the head of this list. There already
-- is one: `save` in the actions table, on every row in the app. A second one
-- would be two places to look for the same fact.

CREATE TABLE IF NOT EXISTS role_events (
    id        TEXT PRIMARY KEY,        -- ev:<base36 time>-<rand>
    group_key TEXT NOT NULL,           -- company|normalised title, per groupKeyOf
    -- applied | oa | phone_screen | interview | final | offer | rejected | ghosted
    --
    -- TEXT with the closed set enforced in code, the same call 002 made about
    -- interaction types and 001 made about candidate/triage staying INTEGER: a
    -- Postgres enum cannot be created by the SQLite half of this file, and a
    -- CHECK would have to be dropped and recreated to add a stage later.
    status    TEXT NOT NULL,
    -- WITH A REFERRAL, OR WITHOUT. Asked once, when marking applied, and
    -- optional — an unanswered question stores NULL rather than a guessed 0,
    -- because the whole point of the column is to test the referral thesis
    -- against the owner's own results and a fabricated "no" would poison it.
    referral  INTEGER,
    note      TEXT,
    at        TEXT NOT NULL
);

-- Every read is "the latest event for this role", and the sort is part of it.
CREATE INDEX IF NOT EXISTS role_events_key ON role_events (group_key, at);
