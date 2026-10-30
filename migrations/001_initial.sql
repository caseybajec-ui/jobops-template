-- JobOps — initial Postgres schema (Neon).
--
-- Generated from the LIVE SQLite schema in jobs.db, not from schema.sql. That
-- file predates ~20 columns added since it was written, and migrating against
-- it would have silently dropped every one of them.
--
-- Run this in the Neon console SQL Editor, which uses the direct connection.
-- It is idempotent: safe to run twice.
--
-- Deliberate choices, each one load-bearing:
--
--   Timestamps stay TEXT. Every one of them holds an ISO-8601 string written by
--   Python, and two queries do substr(posted_at, 1, 10) to get the date part.
--   timestamptz would be tidier and would break both. Convert later, on purpose,
--   or not at all.
--
--   candidate / triage / verdict stay INTEGER, not BOOLEAN. The Python compares
--   them to 1 and 0 in a dozen places and the web layer counts them with SUM.
--   Changing the type here means changing all of that in the same commit, which
--   is exactly the kind of coupled change to avoid during a migration.
--
--   AUTOINCREMENT becomes GENERATED ALWAYS AS IDENTITY. `actions.id` is the
--   ordering that makes "latest wins" deterministic when two clicks share a
--   timestamp, so it must stay strictly monotonic.

BEGIN;

-- ---------------------------------------------------------------- jobs
CREATE TABLE IF NOT EXISTS jobs (
    key              TEXT PRIMARY KEY,   -- source:slug:ext_id
    source           TEXT,
    slug             TEXT,
    ext_id           TEXT,
    company          TEXT,
    title            TEXT,
    location         TEXT,
    url              TEXT,
    description      TEXT,
    posted_at        TEXT,
    tier             INTEGER,
    candidate        INTEGER,            -- passed the title filter
    first_seen       TEXT,
    last_seen        TEXT,
    closed_at        TEXT,

    -- deterministic gate
    triage           INTEGER,            -- NULL not yet, 1 passed, 0 killed
    triage_reason    TEXT,
    triaged_at       TEXT,
    gate_name        TEXT,               -- which gate fired
    gate_text        TEXT,               -- the exact phrase it matched
    gate_field       TEXT,               -- location | title | description

    -- classification
    yoe              INTEGER,
    yoe_text         TEXT,
    category         TEXT,
    start_window     TEXT,
    clearance_status TEXT,
    entry_level      TEXT,
    display_name     TEXT,

    -- graduating class
    class_fit        TEXT,               -- ok | wrong_year
    class_reason     TEXT,
    class_text       TEXT,
    start_year       INTEGER,
    start_month      INTEGER,
    class_year       INTEGER,

    -- compensation
    comp_min         INTEGER,
    comp_max         INTEGER,
    comp_currency    TEXT,
    comp_source      TEXT,               -- structured | parsed | none
    comp_raw         TEXT
);

-- The predicates every list filters on.
CREATE INDEX IF NOT EXISTS jobs_open        ON jobs (closed_at, candidate, triage);
CREATE INDEX IF NOT EXISTS jobs_company     ON jobs (company);
CREATE INDEX IF NOT EXISTS jobs_reachable   ON jobs (entry_level, class_fit, clearance_status);

-- ---------------------------------------------------------------- scores
-- ONE MODEL SCORES EVERYTHING. Never let two models score overlapping
-- populations; a partial migration leaves two incomparable scales in one table.
CREATE TABLE IF NOT EXISTS scores (
    key          TEXT PRIMARY KEY,
    score        INTEGER,               -- median of n_samples runs
    tier         TEXT,
    model        TEXT,
    reasons      TEXT,                  -- JSON array
    gaps         TEXT,                  -- JSON array
    evidence_ids TEXT,                  -- JSON array
    angle        TEXT,
    raw          TEXT,
    scored_at    TEXT,
    score_lo     INTEGER,
    score_hi     INTEGER,
    score_spread INTEGER,               -- wide spread = the scorer was unsure
    n_samples    INTEGER,
    effort       TEXT
);

CREATE TABLE IF NOT EXISTS score_runs (
    key          TEXT,
    run_idx      INTEGER,
    score        INTEGER,
    tier         TEXT,
    reasons      TEXT,
    gaps         TEXT,
    evidence_ids TEXT,
    angle        TEXT,
    raw          TEXT,
    model        TEXT,
    effort       TEXT,
    at           TEXT,
    PRIMARY KEY (key, run_idx)
);

-- ---------------------------------------------------------------- pipeline
CREATE TABLE IF NOT EXISTS batches (
    batch_id     TEXT PRIMARY KEY,
    stage        TEXT,                  -- 'triage' | 'score'
    model        TEXT,                  -- the authority on what produced a response
    n            INTEGER,
    submitted_at TEXT,
    collected_at TEXT,
    keymap       TEXT,                  -- JSON {custom_id: job key}
    -- MEASURED usage, written at collect time from the API's usage objects.
    -- Estimating from mean token shapes read 35% low because it priced no cache
    -- traffic; these are the real counts, so the meter reports measured spend
    -- for finished batches and estimates only for ones still in flight.
    in_tok       INTEGER,
    out_tok      INTEGER,
    cache_w_tok  INTEGER,
    cache_r_tok  INTEGER
);

CREATE TABLE IF NOT EXISTS triage_history (
    key            TEXT,
    prompt_version INTEGER,
    model          TEXT,
    verdict        INTEGER,
    reason         TEXT,
    at             TEXT
);

-- ---------------------------------------------------------------- things the owner does
CREATE TABLE IF NOT EXISTS applications (
    key            TEXT PRIMARY KEY,
    stage          TEXT,
    notes          TEXT,
    contact        TEXT,
    applied_at     TEXT,
    next_action    TEXT,
    next_action_at TEXT,
    updated_at     TEXT
);

-- INSERT-ONLY. The latest row for a (key, kind) wins; a row whose meta is
-- {"undo": true} reverses it. Ordering is by id, NEVER by at: two clicks inside
-- one second produce identical timestamps and the pair would settle at random.
CREATE TABLE IF NOT EXISTS actions (
    id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key  TEXT NOT NULL,                 -- role group key, company slug, or item id
    kind TEXT NOT NULL,                 -- save | hide | applied | done | target
    at   TEXT NOT NULL,
    note TEXT,
    meta TEXT
);
CREATE INDEX IF NOT EXISTS actions_key ON actions (key, kind, id);

-- One row per load of Daily. "New since your last visit" reads the PREVIOUS one.
CREATE TABLE IF NOT EXISTS visits (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    id         TEXT PRIMARY KEY,        -- seed:<sha1> | followup:<key> | item:<rand>
    title      TEXT NOT NULL,
    note       TEXT,
    due_at     TEXT,
    created_at TEXT,
    source     TEXT,                    -- seed | user | auto | split
    -- How long the thing actually takes, in minutes. The Daily ladder refuses to
    -- put an item at the top that does not fit the time available, and this is
    -- the only place that number may come from: stated, or absent. Never guessed
    -- by a model, and never inferred from the text.
    minutes    INTEGER,
    -- PRE-AUTHORED smaller steps, JSON: ["...", {"text": "...", "minutes": 15}].
    -- "Stuck" splits an item into these. Hand-written in daily.yaml precisely so
    -- that nothing generates them: a model-invented breakdown of "assemble the
    -- SF-86 pack" would cost money to be wrong about a form the owner signs under
    -- penalty of perjury.
    steps      TEXT
);

-- ---------------------------------------------------------------- people
-- New in Postgres: contacts.csv and outreach/ are file-based today and are
-- gitignored because they hold OTHER PEOPLE'S details. They move here so the
-- deployed app can read them without those files ever entering the repo.
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
    -- WHEN THE ROW WAS CREATED, which is not first_touch. first_touch is when
    -- the first message went out; the weekly cadence counts contacts ADDED —
    -- five new tier-1 names a week. Reading first_touch made that count
    -- permanently zero, because a name entered today has not been written to
    -- yet. Same always-empty shape as reading contacts.csv on Vercel, one layer
    -- down, and it would have kept the networking tier firing forever while
    -- looking like it was measuring something.
    created_at  TEXT
);
CREATE INDEX IF NOT EXISTS contacts_company ON contacts (company);

CREATE TABLE IF NOT EXISTS outreach (
    id         TEXT PRIMARY KEY,
    contact_id TEXT,
    kind       TEXT,                    -- cold | follow_up | thank_you
    body       TEXT,
    approved   INTEGER DEFAULT 0,       -- NEVER send unless this is 1
    created_at TEXT,
    sent_at    TEXT
);

COMMIT;
