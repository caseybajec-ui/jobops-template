-- Pages the fetcher cannot read, watched for change.
--
-- WHY THIS EXISTS. McKinsey's 2027 window ran 2026-07-01 to 2026-08-11 and
-- closed before this tool existed. companies.yaml carried a note reading
-- "MBB full-time window typically closes mid/late September" -- acting on it
-- would have cost an entire recruiting cycle. Consulting, PM cohorts and the
-- primes' LDPs run on Workday and custom pages with no machine-readable board,
-- so they are structurally invisible to fetch_jobs and always will be. The only
-- thing that can be automated about them is noticing that the PAGE changed.
--
-- NO MODEL ANYWHERE IN THIS PATH. Hash and regex. A model reading a careers
-- page would produce a confident wrong date, which is the exact failure the
-- McKinsey miss already demonstrated, and verify_deadlines.py deliberately does
-- not scrape for the same reason. This does not decide what a page MEANS. It
-- reports that the bytes moved and shows the lines that differ; a human reads
-- them.
CREATE TABLE IF NOT EXISTS watched_pages (
  url             TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  company         TEXT,
  category        TEXT,

  -- The hash of the NORMALISED content region, never of the raw response.
  -- A careers page rewrites a CSRF token, a build id and a copyright year on
  -- every request; hashing the raw body would report a change every night and
  -- the section would be noise inside a week.
  last_hash       TEXT,
  last_changed_at TEXT,
  last_checked_at TEXT,

  -- Optional. When this flips from not-matching to matching, that is a
  -- WINDOW OPENED event -- the single most time-sensitive thing this tool can
  -- say. Stored per page because "apply now" means different things on a
  -- consulting page and a prime's LDP page.
  status_regex    TEXT,
  last_status_hit INTEGER NOT NULL DEFAULT 0,

  -- What the last check actually got. A page that 403s, redirects to a login,
  -- or serves a bot check is NOT "unchanged" -- it is a broken watcher, and
  -- reporting it as no-change is the always-empty-source failure this project
  -- has already hit three times. NULL means the last fetch was clean.
  last_error      TEXT,
  -- Consecutive failures, so one flaky night is not an alarm and a fortnight
  -- of them is.
  fail_streak     INTEGER NOT NULL DEFAULT 0,

  -- Capped diff summary of the most recent real change, for the digest.
  last_diff       TEXT,
  notes           TEXT,
  created_at      TEXT
);

-- The digest asks "what changed recently" every night.
CREATE INDEX IF NOT EXISTS watched_pages_changed
  ON watched_pages (last_changed_at DESC);

-- The previous normalised text, so the next run can DIFF rather than only say
-- "something changed". Separate table because it is large and the digest never
-- reads it -- keeping it in watched_pages would drag a few hundred KB through
-- every query that renders the section.
CREATE TABLE IF NOT EXISTS watched_snapshots (
  url        TEXT PRIMARY KEY,
  last_lines TEXT,
  saved_at   TEXT
);
