-- Names staged for the owner to promote, from every source.
--
-- NOTHING HERE IS A CONTACT. A row is a suggestion; promoting it writes a
-- contacts row and is a tap. Nothing is drafted for a suggestion, and the
-- outreach engine never reads this table -- which is what makes an automated
-- reader safe to have pointed at it.
--
-- DEDUPED ON profile_url WHERE THERE IS ONE, and on name+company otherwise.
-- The LinkedIn reader has a stable URL per person; a paste and a CSV export do
-- not, and two spellings of one name must not become two suggestions.
CREATE TABLE IF NOT EXISTS suggested_contacts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  company      TEXT,
  company_slug TEXT,
  title        TEXT,
  headline     TEXT,
  location     TEXT,
  profile_url  TEXT,
  school       TEXT,
  -- linkedin_read | manual_paste | linkedin_export | team_page
  source       TEXT NOT NULL,
  source_url   TEXT,
  rank         INTEGER,
  rank_reason  TEXT,
  raw          TEXT,
  -- Set when the owner promotes it. A promoted suggestion stays here so the same
  -- person is not suggested again by a later run.
  promoted_at  TEXT,
  -- Skipped people do not come back for 30 days. Not deleted: a skip is a
  -- decision about TODAY, and deleting it would let the next run re-suggest
  -- them tomorrow.
  skipped_at   TEXT,
  created_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS suggested_profile
  ON suggested_contacts (profile_url) WHERE profile_url IS NOT NULL AND profile_url <> '';
CREATE INDEX IF NOT EXISTS suggested_rank
  ON suggested_contacts (rank, created_at);

-- What the local reader did, every night, whether or not it read anything.
--
-- A SKIP IS A ROW. "The machine was off", "idle for two hours", "halted on a
-- checkpoint" and "read 40 names" are four different nights, and a digest that
-- can only distinguish the last one from silence is the always-empty-source
-- failure with a browser attached.
CREATE TABLE IF NOT EXISTS reader_runs (
  id         TEXT PRIMARY KEY,
  ran_at     TEXT NOT NULL,
  searches   INTEGER,
  found      INTEGER,
  skipped    TEXT,
  red        INTEGER NOT NULL DEFAULT 0
);
