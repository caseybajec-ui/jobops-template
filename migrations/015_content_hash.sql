-- JobOps 015 — the fingerprint that stops the nightly fetch rewriting the world.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/015_content_hash.sql
--
-- WHY. The fetch upserted every open role every morning whether or not anything
-- about it had changed: 11,494 rows carrying a mean 6,358-character
-- description, roughly 77 MB of payload per run and about 2.3 GB a month before
-- any backfill. Neon's 5 GB monthly transfer allowance ran out and put compute
-- at risk of suspension.
--
-- Almost none of it changes. The first fetch after the description backfill
-- moved 73 descriptions out of ~9,900, and 52 of those by exactly one
-- character. Writing the other 99% again every night bought nothing at all.
--
-- With this column the fetch compares first: a row whose hash matches gets
-- last_seen and closed_at moved and nothing else, which carries no description.
--
-- NULL MEANS "WRITTEN BEFORE THIS COLUMN EXISTED" and takes the full path, so
-- the first run after deploy writes everything once and then stops. That is
-- deliberate: the alternative is computing the hash server-side in SQL to match
-- what Python computes, and two spellings of one hash is a silent wrong answer
-- waiting to happen -- a row whose hash agrees by accident is a changed posting
-- that never gets written again.
--
-- 32 hex characters, 128 bits. A collision is not a crash here, it is a changed
-- posting silently skipped forever, so the extra 16 bytes a row (180 KB across
-- the table) is not worth saving.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- The read is "every key and its hash", once per fetch, over the whole table.
-- Covering both columns keeps that off the heap: 11,494 rows x ~72 bytes is
-- under a megabyte, against the 77 MB it replaces.
CREATE INDEX IF NOT EXISTS jobs_key_hash ON jobs (key, content_hash);
