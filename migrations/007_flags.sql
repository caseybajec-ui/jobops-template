-- JobOps 007 — a role or a company that is the wrong cycle, hidden everywhere.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/007_flags.sql
-- (The daily run applies every migration itself.)
--
-- Bessemer's "Full Time Analyst 2027" is the case. It reads as a perfect match —
-- named 2027, analyst, a growth-equity firm on the target list — and companies.yaml
-- already records why it is not: their 2027 class targets December 2027 to June
-- 2028 graduates. Wrong cycle. It sat at the top of Daily anyway, because that
-- fact lived in a note a human wrote and nothing read.
--
-- WHY A TABLE AND NOT A COLUMN ON `jobs`. The brief asked for `roles.wrong_cycle`
-- and `companies.wrong_cycle`. Neither is possible here:
--
--   `jobs` is created by fetch_jobs.py, which this pass may not modify, and
--   test_schema_parity.py fails on any column a migration adds that
--   fetch_jobs.db() does not also create. A column on `jobs` would break the
--   build on the next commit.
--
--   There is no `companies` table at all. Companies are a GROUP BY over `jobs`.
--
-- So it is an app-owned flag table, keyed the way every other app-owned fact in
-- this schema is keyed: a role by its GROUP key, a company by its slug. The
-- group key also survives a requisition churning, which a job key does not —
-- Palantir re-ids postings constantly, and a flag that evaporated on the next
-- fetch would be worse than none.
--
-- INSERT-ONLY, like `actions`. Un-hiding writes a row saying so rather than
-- deleting, so "he hid this and changed his mind" stays legible — and the
-- reasons he hides things are the only training data this system will ever
-- produce about his own judgement.

CREATE TABLE IF NOT EXISTS role_flags (
    id    TEXT PRIMARY KEY,        -- fl:<base36 time>-<rand>
    -- role | company
    scope TEXT NOT NULL,
    -- the role's group key (company|normalised title), or the company slug
    key   TEXT NOT NULL,
    -- wrong_cycle is the only flag today. The column exists so the second one
    -- does not need a migration.
    flag  TEXT NOT NULL,
    -- 1 sets it, 0 lifts it. The LATEST row for a (scope, key, flag) wins,
    -- ordered by id — never by `at`, because two clicks inside one second write
    -- identical timestamps and the pair would settle at random. The same trap
    -- the actions table documents.
    on_   INTEGER NOT NULL,
    note  TEXT,
    at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS role_flags_key ON role_flags (scope, key, flag, id);
