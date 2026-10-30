-- Interview prep for one role, generated once when a status reaches interview.
--
-- ZERO COST UNTIL A STATUS FLIPS. Nothing writes here on a schedule; a row
-- appears only when the owner runs `prep_pack.py build <key>` for a role he is
-- actually interviewing for. A generator that fired on every scored role would
-- cost more than the interviews are worth.
--
-- raw AND note ARE THE REFUSAL PATH, the same shape apply_packs uses. A pack
-- that breaks a hard rule -- a clearance claim, a bracket, a dash -- is stored
-- as raw with the reason in note and the structured columns left NULL, so the
-- page shows nothing rather than showing something false.
CREATE TABLE IF NOT EXISTS prep_packs (
  key        TEXT PRIMARY KEY,
  model      TEXT,
  created_at TEXT,
  summary    TEXT,
  -- JSON arrays. Postgres has json types and this deliberately does not use
  -- them: sqlite is the offline path and the two must hold the same bytes.
  questions  TEXT,
  answers    TEXT,
  ask_them   TEXT,
  position   TEXT,
  raw        TEXT,
  note       TEXT
);
