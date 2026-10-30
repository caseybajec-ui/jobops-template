-- JobOps 002 — the people side.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/002_people.sql
--
-- NOT with runsql.mjs. That one talks to Neon directly and is Postgres-only,
-- which was right for 001: those tables are the Postgres port of a schema
-- fetch_jobs.py already creates in SQLite. Everything here is owned by the APP
-- — no Python creates any of it — so it has to exist in both backends, and
-- applymigration.mjs goes through driver.js to guarantee one file describes
-- both. Idempotent: safe to run as many times as you like.
--
-- WHY THIS EXISTS. CLAUDE.md's own conclusion is that referrals are what get
-- past a CS-degree screen and a clearance requirement, and the networking half
-- of this tool had a table and nothing else. Daily's "Follow-ups owed" was
-- structurally empty, Companies' "Find 2 names" led nowhere, and the ladder's
-- networking tier read a source that could never be populated from the app.
--
-- THREE PLACES THIS DEPARTS FROM THE BRIEF, each because the existing code
-- already decided otherwise and quietly re-deciding would be worse:
--
--   1. `company_id` with a foreign key was asked for. THERE IS NO COMPANIES
--      TABLE. Companies are derived from `jobs` with a GROUP BY, and every
--      other company reference in this schema — contacts.company, an actions
--      row keyed `target`, companies.yaml itself — is the companies.yaml SLUG
--      as text. A synthetic companies table introduced only to hang a key off
--      would need populating from two sources that disagree. So: `company`,
--      text, the slug.
--
--   2. A `contacts` table was asked for. IT ALREADY EXISTS, created by 001 in
--      phase B and unused for weeks. It is extended, never replaced: `role` is
--      the brief's `title` and `source` is its `source`. Three columns are new.
--
--   3. `status` was asked to be DERIVED and not stored — and contacts.status
--      already exists and contacts.py still writes it. Both are true at once:
--      the app derives status from the latest interaction and never reads the
--      column, and the column stays because nothing here deletes and the Python
--      CLI is still a writer of record. See derivedStatus() in lib/people.js.

-- The contacts table itself, for the backend that does not have one.
--
-- In Neon this is a no-op: 001 created it. In the local SQLite file it is the
-- whole reason the People page can be built and clicked offline, because
-- fetch_jobs.py — which owns the SQLite schema and which this pass may not
-- touch — never creates it. Column-for-column identical to 001, plus the three
-- new ones; the +column directives at the bottom add those to Neon, where the
-- table already exists and CREATE TABLE IF NOT EXISTS does nothing.
CREATE TABLE IF NOT EXISTS contacts (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    company     TEXT,
    role        TEXT,
    channel     TEXT,
    source      TEXT,
    job_key     TEXT,
    target_role TEXT,
    status      TEXT,
    first_touch TEXT,
    last_touch  TEXT,
    touch_count INTEGER,
    next_touch  TEXT,
    replied     TEXT,
    notes       TEXT,
    created_at  TEXT,
    linkedin_url TEXT,
    email        TEXT,
    warmth       TEXT
);
CREATE INDEX IF NOT EXISTS contacts_company ON contacts (company);

-- One row per thing that actually happened with a person.
--
-- INSERT-ONLY, like `actions`, and for the same reason: the history is the
-- point. "Messaged, no reply, messaged again, no reply" is the fact that stops
-- the cadence at two, and a mutable status column cannot hold it.
--
-- `occurred_at` is when it HAPPENED and `created_at` is when it was typed in.
-- They differ whenever the owner logs a call on the train home, and every rule in
-- lib/people.js measures from occurred_at — a follow-up is owed five business
-- days after the message went out, not five days after he got round to
-- recording it.
CREATE TABLE IF NOT EXISTS interactions (
    id          TEXT PRIMARY KEY,      -- ix:<base36 time>-<rand>
    contact_id  TEXT NOT NULL,
    -- outreach_sent | reply_received | call_scheduled | call_done
    -- referral_asked | referral_received | thank_you_sent
    --
    -- TEXT with the closed set enforced in code, not a CHECK constraint and not
    -- an enum type. Same call 001 made about candidate/triage staying INTEGER:
    -- a Postgres enum cannot be created by the SQLite side of this file, and a
    -- CHECK would have to be dropped and recreated to add a type later. The set
    -- is in INTERACTION_TYPES in lib/people.js and the API route rejects
    -- anything else, so nothing can write a value the UI cannot render.
    type        TEXT NOT NULL,
    -- linkedin | email | phone | in_person. Nullable: a referral coming through
    -- is something that happened, not something that happened on a channel.
    channel     TEXT,
    note        TEXT,
    occurred_at TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- Every read is "this contact's interactions, newest first", so the index
-- carries the sort. occurred_at DESC is deliberately NOT in the index: two
-- interactions on the same day are ordered by id in code, and an index that
-- half-answers the sort invites a query that forgets the tie-break.
CREATE INDEX IF NOT EXISTS interactions_contact ON interactions (contact_id, occurred_at);

-- Editable text the app owns: the four outreach templates, and anything else
-- small that has to survive a deploy. Not localStorage — that is per-browser,
-- invisible to Claude, and gone the moment site data is cleared, and an edited
-- template is real work.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT
);

-- Three additive columns on the existing contacts table. See the header for why
-- these are directives rather than ALTER statements.
-- +column contacts linkedin_url TEXT
-- +column contacts email TEXT
-- +column contacts warmth TEXT
