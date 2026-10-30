-- APPLICATIONS THAT WERE ACTUALLY SUBMITTED.
--
-- Everything else in this database records what the tool PREPARED: roles it
-- found, scores it computed, packs it wrote, people it suggested. Nothing
-- recorded what the owner did, so the audit's finding 2 -- zero applications, zero
-- contacts touched, 121 packs unused -- was a fact nothing in the system could
-- see. This is the table that makes it visible.
--
-- FED BY HAND, DELIBERATELY. An external bot submits applications and produces
-- a log; the owner pastes it into /applications. Nothing here contacts that bot:
-- no client, no webhook, no polling, no credential. The paste box is the only
-- way in, and that is the whole security model.
--
-- employer_id IS NULLABLE ON PURPOSE and there is no foreign key. A row whose
-- employer could not be matched confidently must still be STORED -- it is a
-- real application the owner made -- and appear in the unmatched list for him to
-- resolve. A constraint here would make the safe outcome (record it, admit the
-- match is unknown) impossible, and the unsafe one (guess a company) the only
-- way to save the row. Same reason `companies` is not referenced: it is
-- companies.yaml, baked at build time, not a table.
CREATE TABLE IF NOT EXISTS applied_apps (
  id            TEXT PRIMARY KEY,
  applied_date  TEXT NOT NULL,
  channel       TEXT,
  employer_raw  TEXT NOT NULL,
  employer_id   TEXT,
  role          TEXT,
  location      TEXT,
  status        TEXT NOT NULL,
  notes         TEXT,
  source        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- DEDUPE ON (employer_raw, role), which is what makes re-pasting the same log
-- safe. the owner will paste the day's log, then paste the 7pm digest of the same
-- day, then very likely paste the whole thing again next week; each of those
-- must update what is already there rather than pile up duplicates that then
-- have to be found by hand.
--
-- ON employer_raw RATHER THAN employer_id, because employer_id is NULL for
-- everything unmatched -- and in Postgres every NULL is distinct, so a unique
-- index over it would let the same unmatched employer in an unlimited number
-- of times. The raw string is what the log actually said and is stable across
-- pastes; the match is a judgement layered on top of it and can change.
--
-- COALESCE on role for the same reason: the 7pm digest carries company names
-- with no role at all, so role is NULL there, and two NULL roles at one
-- employer are the same row rather than two.
CREATE UNIQUE INDEX IF NOT EXISTS applied_apps_dedupe
  ON applied_apps (lower(employer_raw), lower(COALESCE(role, '')));

CREATE INDEX IF NOT EXISTS applied_apps_date ON applied_apps (applied_date DESC);

-- EVERY PASTE THAT PRODUCED NOTHING, recorded rather than shrugged off.
--
-- "0 rows added" on a green page is indistinguishable from "there was nothing
-- to add", and this project has hit that class of failure on three separate
-- surfaces. A paste with text in it that yields no rows is a FAILURE: the
-- format changed, or the wrong thing was pasted, and either way somebody has
-- to look. The raw text is kept so the shape can be read afterwards instead of
-- reconstructed from memory.
CREATE TABLE IF NOT EXISTS applied_imports (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  chars       INTEGER NOT NULL,
  parsed      INTEGER NOT NULL,
  stored      INTEGER NOT NULL,
  updated     INTEGER NOT NULL,
  method      TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  raw         TEXT,
  note        TEXT
);
