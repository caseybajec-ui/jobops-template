-- JobOps 010 — what has been emailed, so nothing is emailed twice.
--
-- Apply with:  cd web && node lib/applymigration.mjs ../migrations/010_notifications.sql
-- (The daily run applies every migration itself.)
--
-- ONE DIGEST A DAY, AND ONLY WHEN SOMETHING FIRED. A daily email that arrives
-- whether or not anything happened is one you filter to a folder inside a
-- fortnight, and then the one that mattered goes there too. So the sender reads
-- this table first and refuses to send a second digest on a day that already
-- has one.
--
-- `fired` is the list of trigger keys that produced the email, and it is what
-- makes the repeat rules possible: a closing window notifies at 7 days, then
-- again at 3, then at 1, and NOT on the four days in between. The key carries
-- its threshold — "window:deloitte|strategy:3" — so "have I already said this"
-- is a lookup rather than a guess.
--
-- Failure alerts are exempt from the one-a-day cap and are recorded here too,
-- with kind = 'failure'. A run that fails twice in a day is worth hearing about
-- twice; a digest is not.
CREATE TABLE IF NOT EXISTS notifications (
    id       TEXT PRIMARY KEY,      -- nt:<base36 time>-<rand>
    day      TEXT NOT NULL,         -- YYYY-MM-DD in the user's timezone
    kind     TEXT NOT NULL,         -- digest | failure | test
    subject  TEXT,
    fired    TEXT,                  -- JSON array of trigger keys
    -- What actually happened at the provider. 'dry-run' when no key was
    -- configured, which is a real outcome and must not look like a send.
    status   TEXT,
    detail   TEXT,
    sent_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_day ON notifications (day, kind, id);
