-- Append-only run history. One row per run, kept 90 days.
--
-- WHY. pipeline_status held exactly one row, id='last', overwritten every run.
-- So "which runs failed in the last 30 days" had no data behind it, and a run
-- that died before reaching the record step left no trace at all -- the next
-- run simply overwrote the single row. The 2026-09-08 audit could not answer
-- the question it was asked, which is the finding.
--
-- pipeline_status IS KEPT, not dropped. Existing readers use it as the pointer
-- to the latest run, and changing that in the same commit as adding history
-- would make one change impossible to verify from the other.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id      TEXT PRIMARY KEY,
  day         TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  status      TEXT NOT NULL,
  -- Per-stage outcomes as JSON: {"fetch":"ok","gate":"ok","score":"failed"}.
  -- A run is only as good as its worst stage, and "success" on a run whose
  -- score step died is the lie this table exists to stop.
  stages      TEXT,
  error       TEXT,
  run_url     TEXT
);

CREATE INDEX IF NOT EXISTS pipeline_runs_day ON pipeline_runs (day DESC);

-- The existing id='last' row becomes the first history row. Migrated rather
-- than discarded: it is the only record that the 2026-09-07 run happened.
INSERT INTO pipeline_runs (run_id, day, started_at, finished_at, status, error, run_url)
SELECT
  COALESCE(run_url, 'migrated-last'),
  COALESCE(substr(finished_at, 1, 10), '1970-01-01'),
  NULL, finished_at, COALESCE(status, 'unknown'), note, run_url
FROM pipeline_status WHERE id = 'last'
ON CONFLICT (run_id) DO NOTHING;
