-- JobOps 004 — the SF-86 evidence pack.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/004_sf86.sql
--
-- "Assemble the SF-86 evidence pack" was ONE LINE on a checklist. The thing it
-- names is seven to ten years of addresses with no gaps, every employer with a
-- supervisor who can be contacted, every foreign trip, and every foreign
-- contact — weeks of intermittent remembering, spread over months, and a
-- checkbox is the wrong shape for it in both directions: it cannot be honestly
-- ticked until the whole thing is done, and it says nothing about how far along
-- it is. So it sat at 7 days due, untouched, for the life of the list.
--
-- WHOSE DATA IS IN HERE. the owner's own addresses and employment, deliberately —
-- the same reasoning that puts profile.json in the repo. But ALSO other
-- people's names and contact details: supervisors, and foreign contacts. That
-- is the category CLAUDE.md keeps out of the repository entirely, which is why
-- this is a table and not a file. It lives in Postgres alongside `contacts`,
-- for exactly the same reason, and nothing writes it to disk.
--
-- ONE TABLE, FOUR SECTIONS. The four sections ask for overlapping things — a
-- span of dates, a name, a place — and four near-identical tables would mean
-- four near-identical queries and four places to add a column. The fields are
-- named for what they hold rather than for one section's word for it, and
-- lib/sf86.js defines which section uses which.
--
-- NOT a JSON blob, which was the other option. This is data a human types once
-- and reads back years later under penalty of perjury; a shape that can only be
-- understood by the code that wrote it is the wrong one for that.
--
-- Dates are YYYY-MM. The form asks for month and year, so storing a day would
-- be inventing precision — the same reason profile.json's graduation is a month
-- and cycleFrame anchors it to the middle rather than picking the 1st.

CREATE TABLE IF NOT EXISTS sf86_entries (
    id         TEXT PRIMARY KEY,      -- sf:<base36 time>-<rand>
    -- address | employer | travel | contact
    section    TEXT NOT NULL,
    -- The main thing: the address, the employer, the person's name.
    label      TEXT,
    -- A second person attached to it: the supervisor, for an employer.
    person     TEXT,
    -- How to reach that person. Email or phone, as typed.
    contact    TEXT,
    -- Why: the purpose of a trip, or the relationship to a contact.
    purpose    TEXT,
    country    TEXT,
    from_ym    TEXT,                  -- YYYY-MM
    to_ym      TEXT,                  -- YYYY-MM, or NULL meaning "still there"
    -- Explicit ordering, so a re-render cannot reshuffle rows a human is
    -- reading down. Every list in this app that tied on its sort keys has
    -- reshuffled on its own at least once.
    sort       INTEGER,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS sf86_section ON sf86_entries (section, sort);
