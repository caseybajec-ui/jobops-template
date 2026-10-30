-- JobOps 008 — the profile card: the 25 fields Workday asks for every time.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/008_profile.sql
-- (The daily run applies every migration itself.)
--
-- WHY A TABLE FOR ONE ROW. Every application form asks for the same legal name,
-- address, phone, GPA and graduation date, and the owner retypes them each time
-- from memory or from whichever document is open. Retyping is where a GPA turns
-- into 3.19 and a postcode loses a digit, and neither is noticeable until an
-- application has already gone.
--
-- WHY NOT profile.json. That file is the source of truth for who the owner IS and
-- goes into the scorer's system prompt. This is contact detail he pastes into
-- forms — it changes when he moves flat, not when his experience changes, and
-- it must be EDITABLE FROM THE DEPLOYED APP, which a file in the repo cannot
-- be. Same reasoning that put contacts and outreach in Postgres.
--
-- Its address and phone are the reason the repo's deny list exists in the first
-- place; they belong in the database and never in a commit.
--
-- SINGLE ROW, enforced by a fixed primary key rather than by a constraint. `id`
-- is always 'me'. An INSERT ... ON CONFLICT DO UPDATE against that key is the
-- whole write path, which means there is no way to end up with two profiles and
-- no way for a page to have to choose between them.

CREATE TABLE IF NOT EXISTS profile (
    id                  TEXT PRIMARY KEY,   -- always 'me'

    legal_name          TEXT,
    preferred_name      TEXT,
    email               TEXT,
    phone               TEXT,

    street              TEXT,
    city                TEXT,
    state               TEXT,
    postal              TEXT,
    country             TEXT,

    linkedin_url        TEXT,
    briefd_url          TEXT,

    gpa                 TEXT,               -- TEXT: "3.91", never a float. A
                                            -- form wants the string he wrote.
    expected_graduation TEXT,               -- "May 2027"

    work_authorization  TEXT,
    -- FIXED PHRASING, and the app renders it read-only.
    --
    -- Clearance eligibility is decided by a government adjudicator, not by the
    -- candidate. This may say he holds none and is willing to undergo the
    -- process; it may never say he is cleared or eligible, which would be a
    -- false claim on a defense application. lib/clearance.js holds the
    -- predicate and test_clearance.mjs fires it at this default.
    clearance_line      TEXT,

    -- Three bullets he pastes into "tell us about yourself" boxes. Seeded
    -- empty: CLAUDE.md rule 4 is absolute, and inventing resume text here to
    -- have something to show would break it on the surface where the text is
    -- most likely to be pasted somewhere real.
    bullet_1            TEXT,
    bullet_2            TEXT,
    bullet_3            TEXT,

    updated_at          TEXT
);
