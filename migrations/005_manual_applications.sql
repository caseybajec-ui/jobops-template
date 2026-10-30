-- JobOps 005 — applications the fetcher can never see.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/005_manual_applications.sql
-- (The daily GitHub Actions run applies every migration itself, so this
-- normally needs nobody to do anything.)
--
-- THE GAP THIS CLOSES. Consulting, VC and big-tech APM run Workday or custom
-- systems with no public feed — that is why they live in `deadlines:` and on
-- Forecast rather than in the inbox. It also meant the three applications that
-- matter most this month (Accenture, Deloitte, EY-Parthenon) had no object to
-- be recorded against: "In flight" could only ever show scraped roles, so the
-- half of the search with the nearest deadline was the half the tracker could
-- not see.
--
-- FOUR PLACES THIS DEPARTS FROM THE BRIEF, each because the codebase already
-- decided and quietly re-deciding would be worse:
--
--   1. `company_id references companies(id)` was asked for. THERE IS NO
--      COMPANIES TABLE — companies are a GROUP BY over `jobs` plus
--      companies.yaml, and every company reference in this schema is the yaml
--      SLUG as text. Worse, half the firms here (Accenture, EY-Parthenon) have
--      no slug at all: they exist only as a `firm:` string in the deadlines
--      block. So: `company` holds the slug when there is one, and `firm_label`
--      carries the display name either way.
--
--   2. `status`, `with_referral` and `submitted_at` were asked for as COLUMNS,
--      alongside an events table. All three are derivable from the events —
--      status is the latest one, submitted_at is the `applied` one's timestamp,
--      with_referral is that event's `referral`. Storing them twice is the
--      thing contacts.status already demonstrates going wrong: two copies of
--      one fact that disagree the first time a write half-fails. They are
--      derived, by the SAME currentStatus() the roles use, which is also what
--      makes days-in-stage identical across both kinds without a second
--      implementation.
--
--   3. `uuid`/`gen_random_uuid()` was asked for. SQLite has no such function,
--      and applymigration.mjs applies this file to the local file as well as to
--      Neon. TEXT ids minted in JS, like role_events, items and contacts.
--
--   4. A `deleted_at` soft-delete column was offered. The acceptance criteria
--      actually describe an undo WINDOW — sixty seconds, then the checkbox
--      locks — which is the fence undoInteraction() already uses. A hard delete
--      inside the window and a refusal outside it is the same guarantee with
--      one less nullable column and no "did you remember to filter deleted"
--      trap on every query.

CREATE TABLE IF NOT EXISTS manual_applications (
    id           TEXT PRIMARY KEY,      -- ma:<base36 time>-<rand>
    -- The companies.yaml slug where one exists, so this joins to everything
    -- else. NULL-ish (empty) for a deadline firm that has no board.
    company      TEXT,
    -- What to put on screen. Always present: a row nobody can read is worse
    -- than a row with a slug in it, and half of these firms have only a name.
    firm_label   TEXT NOT NULL,
    program_name TEXT NOT NULL,
    class_year   INTEGER,
    -- windowKey() from lib/display.js: "window:<firm>|<program>". Ties the
    -- application back to the window it was spawned from, so Forecast can show
    -- that this one is already in flight.
    window_id    TEXT,
    source       TEXT NOT NULL,         -- window | direct
    notes        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS manual_applications_company ON manual_applications (company);

-- Column-for-column the shape of role_events, deliberately.
--
-- currentStatus() and inFlight() in lib/lifecycle.js are written against that
-- shape and take a plain array; feeding them these rows unchanged is what makes
-- "14 days in this stage" mean the same thing whether the application came off
-- a job board or out of a Workday form. A different shape here would be a
-- second implementation of days-in-stage, and the two would drift.
CREATE TABLE IF NOT EXISTS manual_application_events (
    id             TEXT PRIMARY KEY,    -- mev:<base36 time>-<rand>
    application_id TEXT NOT NULL,
    status         TEXT NOT NULL,       -- the LIFECYCLE keys, same set as roles
    -- Asked once, at `applied`, and allowed to be NULL. An unanswered question
    -- stores NULL rather than a guessed 0: this column is the only evidence
    -- about whether referrals work for him, and a fabricated "no" poisons it.
    referral       INTEGER,
    note           TEXT,
    at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS manual_application_events_app
    ON manual_application_events (application_id, at);
