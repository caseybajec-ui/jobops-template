-- "Ask about this data" — the log, and the only table the feature may write.
--
-- ONE ROW PER QUERY, and it is what makes the 30/month cap real: the counter is
-- a COUNT(*) over this table for the calendar month, never a stored integer. A
-- stored counter is a second copy of a fact, and it desyncs the first time a
-- write fails halfway — at which point the cap is either unenforceable or
-- silently wrong, and both are worse than the extra table.
--
-- It is also the whole reason the footer can show what this costs. A spend
-- feature you cannot see the spend on is worse than a table.
--
-- The QUESTION is stored; the ANSWER is not. Answers are long, they are
-- regenerable, and nothing in this tool reads one back — storing them would be
-- a transcript nobody asked for. The question is kept so a month's queries can
-- be read back to see what this is actually being used for.
--
-- Prices here are SYNCHRONOUS. Every other row in `batches` gets the Batch API's
-- 50% discount because every one of them was a batch; an interactive question
-- cannot be, so the meter must not apply that discount to these. See
-- web/lib/cost.js.
CREATE TABLE IF NOT EXISTS ask_queries (
    id           TEXT PRIMARY KEY,
    asked_at     TEXT NOT NULL,
    question     TEXT,
    model        TEXT,
    -- Measured from the API response, never estimated. The cost meter has been
    -- wrong three times from pricing assumed token shapes; these come off
    -- usage on the response itself.
    in_tok       INTEGER,
    out_tok      INTEGER,
    cache_r_tok  INTEGER,
    cost         REAL,
    -- How much context was assembled, so a query that answered badly can be
    -- told apart from one that was starved of context.
    ctx_tok      INTEGER,
    -- 'ok' | 'capped' | 'error'. A refused query is logged too: the cap doing
    -- its job is a fact worth being able to see, and it costs nothing.
    status       TEXT
);

CREATE INDEX IF NOT EXISTS ask_queries_asked_at ON ask_queries (asked_at);
