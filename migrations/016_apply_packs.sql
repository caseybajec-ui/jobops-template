-- JobOps 016 — the apply pack: everything needed to actually send an application.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/016_apply_packs.sql
--
-- WHY. The pipeline finds and scores roles well and then stops. What stands
-- between a 60+ role and a submitted application is an evening of writing, and
-- that evening is the reason `applications` held zero rows on the day this was
-- built. A pack removes the blank page; the owner still reads, edits and sends.
--
-- ONE PACK PER ROLE, keyed by the job key. Regenerating replaces it rather than
-- appending, so there is never a question of which draft is current.
--
-- THE RESUME VARIANT IS NOT WRITTEN BY THE MODEL. web/lib/variant.js maps a
-- company category to tech or finance and that lookup stays in code -- "if code
-- can decide it, code decides it". The model writes the one-line REASON for a
-- choice already made, and `variant` is NULL when the category has no rule
-- rather than being guessed.
--
-- `used_at` IS THE POINT OF THE TABLE, not an afterthought. A pack nobody opened
-- and a pack the owner worked from look identical in a count, and "141 packs
-- generated" would be a vanity number if it could not tell them apart. It is set
-- the first time he copies any field.
--
-- NOTHING HERE IS SENT. There is no recipient column, no send path, and no code
-- that could add one. Same rule as everywhere else: the tool drafts, the owner sends.

CREATE TABLE IF NOT EXISTS apply_packs (
    -- jobs.key. One row per role.
    key             TEXT PRIMARY KEY,

    -- Chosen in code from the company category. NULL means no rule matched, and
    -- the surface shows no tag rather than a guess.
    variant         TEXT,
    -- One line, written by the model, about a choice the model did not make.
    variant_reason  TEXT,

    -- 150 words, the owner's voice, grounded in projects.md and the two resumes.
    cover_note      TEXT,

    -- The four standard prompts, drafted separately so one can be edited or
    -- regenerated without disturbing the others.
    why_company     TEXT,
    why_role        TEXT,
    project_story   TEXT,
    biggest_challenge TEXT,

    -- Provenance. `model` matters for the same reason it does on scores: two
    -- models writing into one table is two voices nobody can tell apart later.
    model           TEXT,
    batch_id        TEXT,
    created_at      TEXT NOT NULL,

    -- When the owner first copied any field out of this pack. NULL = never opened.
    used_at         TEXT,

    -- Set when the model's response could not be parsed into the fields above.
    -- The raw text is KEPT rather than dropped: a pack that failed to parse is
    -- still evidence, and "fail open" applies here as everywhere -- discarding
    -- it would delete work already paid for.
    raw             TEXT
);

-- The reads are "which eligible roles have no pack" and "which packs are
-- untouched", both of which scan for NULLs.
CREATE INDEX IF NOT EXISTS apply_packs_used ON apply_packs (used_at);
CREATE INDEX IF NOT EXISTS apply_packs_batch ON apply_packs (batch_id);
