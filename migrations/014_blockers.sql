-- JobOps 014 — the screen-out requirements on a role, stamped at ingest.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/014_blockers.sql
-- (The daily run applies every migration itself.)
--
-- WHY THIS EXISTS. Mistral's AI Deployment Strategist - USA is the exact shape
-- of Palantir Deployment Strategist, the highest-fit role in the corpus. It
-- scores 28/skip, and the reason is two lines in the posting: "4+ years in a
-- client-facing strategic and technical role" and "You hold a degree in a
-- relevant scientific field". the owner holds a B.S. in Business Administration.
-- He had already got attached to the title before the score said so. These tags
-- put the disqualifier on the row WITH the posting rather than three days later.
--
-- IT GATES NOTHING. No role is deleted, hidden, filtered or penalised, and
-- scoring is untouched. `blockers` is read by display code only. The tags for
-- citizenship and obtainable clearances are not blockers at all — the owner is a US
-- citizen with no clearance and no known disqualifying factors, willing to
-- undergo the process — and they render green, so a defense row says "this is
-- fine" instead of leaving a clearance mention unexplained.
--
-- ABSENCE OF A TAG IS NOT ABSENCE OF A BLOCKER. storage_policy truncates any
-- non-candidate description at 2,000 characters, and 9,691 of 9,708
-- non-candidates sit exactly on that limit — requirements sections almost always
-- fall past it. A hit inside the first 2,000 characters is still a true hit, so
-- the patterns run on every row; but a row with no tags is only CLEAR if the
-- text was whole. `blockers_full_text` carries that, and web/lib/blockers.js
-- refuses to render a clean verdict without it. 8,804 open roles are currently
-- unknown for this reason and the digest says so every morning.
--
-- NULL vs '[]' IS THE USUAL DISTINCTION AND IT MATTERS HERE TOO. NULL means the
-- classifier has not run on this row; '[]' means it ran and found nothing. A
-- backfill that has not reached a row must not look like a clean one.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS blockers TEXT;

-- 1 when the description was the complete posting at the time the tags were
-- computed, 0 when it had been truncated. NULL alongside a NULL `blockers`.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS blockers_full_text INTEGER;

-- The read is "every open role carrying a hard blocker", and separately "how
-- many are unknown", both of which scan a lot of rows.
CREATE INDEX IF NOT EXISTS jobs_blockers ON jobs (blockers);
