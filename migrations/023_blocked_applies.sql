-- APPLICATIONS THAT CANNOT BE SUBMITTED, AND WHY.
--
-- Every other table here records what the tool found, scored, drafted or
-- watched. None of them could record the one state that stops an application
-- dead: the apply flow itself is broken. An hCaptcha that loops forever on
-- Lever, a careers site answering 406 to everything, a form that rejects a
-- valid file. The role stays open, the score stays high, the window stays on
-- the tracker, and the digest goes on recommending it every morning while
-- nothing can actually be submitted.
--
-- INSERT-ONLY, folded latest-per-(scope, key) BY id. Never by `at`: two writes
-- inside one second carry identical timestamps and the pair settles at random.
-- role_flags documents the same trap and foldBlocked() uses the same ordering.
--
-- A NEW TABLE, NOT A COLUMN ON `jobs`. test_schema_parity.py fails on any
-- column a migration adds to `jobs` that fetch_jobs.db() does not also create,
-- so a column here would have broken the build on the next commit. It is also
-- the owner's observation about an apply flow rather than anything the board
-- published, which is the reason every app-owned table in this list exists.
--
-- AND NOT role_flags EITHER, which is the near-miss worth writing down.
-- role_flags has the right shape — scope, key, on_, insert-only — and would
-- have been one `flag` value away from working. It cannot be used: foldFlags()
-- drops `flag` when it folds, keying only on (scope, key), so a blocked row
-- and a wrong-cycle row on the same role would overwrite each other, and every
-- blocked role would be reported to the owner as one he had marked the wrong
-- graduating cycle. Sharing a table with a folder that ignores the column
-- distinguishing the rows is not sharing a table.
CREATE TABLE IF NOT EXISTS blocked_applies (
  id      TEXT PRIMARY KEY,

  -- 'role' or 'window'.
  --
  -- A ROLE IS KEYED ON jobs.key — ONE POSTING — and not on the group key every
  -- other app-owned fact about a role uses. That is deliberate and it is the
  -- whole reason this is not role_flags. Palantir lists Deployment Strategist
  -- in a dozen cities; they collapse to the single group key
  -- `palantir|deployment strategist`, and the hCaptcha loop that blocks the
  -- Chicago requisition says nothing whatever about the New York one. Blocking
  -- the group would have hidden eleven good postings to record one broken form.
  --
  -- A WINDOW IS KEYED `window:<firm>|<program>`, the shape `actions` already
  -- uses for window checks, so the two can be read side by side.
  scope   TEXT NOT NULL,
  key     TEXT NOT NULL,

  -- One of the values in lib/blocked.js. NULL is legal and means unknown —
  -- fail open: an unrecognised or absent reason renders as a plain "Blocked"
  -- and the row is kept. Dropping a row because its reason did not parse would
  -- silently un-block an application that is still broken.
  reason  TEXT,
  note    TEXT,

  -- SNAPSHOTTED AT WRITE TIME, both of them, and that is the point of having
  -- them at all rather than joining to `jobs`.
  --
  -- Lever re-ids requisitions constantly; Palantir's board churns weekly. A
  -- blocked row whose job key has since vanished must still render — as a
  -- stale row naming what it was and where it was — because "the apply flow at
  -- Palantir is broken" is true whether or not that particular requisition
  -- still exists. A join would make the row disappear at exactly the moment
  -- the board re-posted the same job, which reads on screen as "it got fixed".
  label   TEXT,
  url     TEXT,

  -- 1 blocked, 0 lifted. A LIFT IS A NEW ROW, never a DELETE and never an
  -- UPDATE — the same rule role_flags follows, for a better reason here: the
  -- history is the only record this system will hold of which apply flows have
  -- broken and how long each stayed broken, and that is the evidence for
  -- whether a company is worth the trouble at all.
  on_     INTEGER NOT NULL DEFAULT 1,
  at      TEXT NOT NULL
);

-- The fold reads every row for a key and takes the highest id.
CREATE INDEX IF NOT EXISTS blocked_applies_key
  ON blocked_applies (scope, key, id);
