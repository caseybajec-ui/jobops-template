#!/usr/bin/env python3
"""Postgres for the CLI, shaped like the sqlite3 API the scripts already use.

    from pgdb import connect, USING_PG
    con = connect()            # Postgres if DATABASE_URL_UNPOOLED is set
    con.execute("SELECT ... WHERE key = ?", (k,))

Why this exists rather than rewriting every query:

  * pg8000 accepts `paramstyle = "qmark"`, so every `?` placeholder in the
    codebase works UNCHANGED. No `?` -> `%s` shim, and no risk of a `%` inside a
    LIKE pattern being read as a placeholder.
  * sqlite3's Connection has an `.execute()` shortcut and a `row_factory`;
    DB-API 2.0 has neither. Both are provided here so the call sites do not move.

ONE CLIENT LIBRARY, BOTH PLATFORMS. pg8000 is pure Python, so this Windows ARM64
laptop and the Linux x64 Actions runner run the identical code path. psycopg
cannot be used here at all: psycopg[binary] has no win_arm64 wheel and plain
psycopg finds no libpq.

DIRECT connection, never pooled. This does DDL and long transactions, and
PgBouncer in transaction mode supports neither.
"""
import os
import time
import urllib.parse

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


def _url():
    return os.environ.get("DATABASE_URL_UNPOOLED") or ""


def using_pg():
    """Postgres unless there is no URL, or JOBOPS_LOCAL_DB=1 forces SQLite."""
    return bool(_url()) and os.environ.get("JOBOPS_LOCAL_DB") != "1"


USING_PG = using_pg()


class Row(dict):
    """Accessible by name like sqlite3.Row, and by position like a tuple."""

    def __init__(self, cols, values):
        super().__init__(zip(cols, values))
        self._values = list(values)

    def __getitem__(self, k):
        if isinstance(k, int):
            return self._values[k]
        return super().__getitem__(k)

    def keys(self):
        return list(super().keys())

    def __iter__(self):
        """VALUES, not keys.

        sqlite3.Row iterates values, and a dict iterates keys. Without this,
        `for a, b, c in rows` silently unpacks COLUMN NAMES — seed_items.py
        --status printed "source due_at title" as though they were the data.
        No error, just wrong output.
        """
        return iter(self._values)

    def __len__(self):
        return len(self._values)


class _Cursor:
    def __init__(self, cur):
        self._cur = cur

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def description(self):
        """Present because sqlite3 cursors have it and callers reach for it."""
        return self._cur.description

    @property
    def lastrowid(self):
        """Always None, deliberately.

        sqlite3 returns the implicit rowid of the last insert. Postgres has no
        implicit rowid and pg8000 does not populate this. Returning a wrong
        number would be far worse than returning None, so nothing in this
        codebase may depend on it — use RETURNING, or a key you chose yourself.
        """
        return None

    def _cols(self):
        d = self._cur.description
        return [c[0] for c in d] if d else []

    def fetchone(self):
        r = self._cur.fetchone()
        return Row(self._cols(), r) if r is not None else None

    def fetchall(self):
        cols = self._cols()
        return [Row(cols, r) for r in self._cur.fetchall()]

    def __iter__(self):
        cols = self._cols()
        for r in self._cur:
            yield Row(cols, r)


class Connection:
    """The three methods the scripts actually call on a sqlite3 connection."""

    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=()):
        cur = self._raw.cursor()
        # pg8000 wants an empty tuple, not None, when there are no parameters.
        cur.execute(sql, tuple(params) if params else ())
        return _Cursor(cur)

    def executemany(self, sql, seq):
        cur = self._raw.cursor()
        cur.executemany(sql, [tuple(p) for p in seq])
        return _Cursor(cur)

    def commit(self):
        self._raw.commit()

    def rollback(self):
        self._raw.rollback()

    def close(self):
        self._raw.close()

    # sqlite3 code sets this; on Postgres every row is already a Row.
    @property
    def row_factory(self):
        return None

    @row_factory.setter
    def row_factory(self, _value):
        pass


def is_connection_error(exc):
    """Is this the connection dying, rather than the query being wrong?

    THE DISTINCTION MATTERS AND IS EASY TO BLUR. A dead socket is worth
    retrying: reopen, run it again, and the result is identical. A constraint
    violation or a syntax error is not — retrying it three times just produces
    the same failure three times and buries the message that explains it.

    So this deliberately does NOT catch DatabaseError, which is Postgres saying
    "no" for a reason. It catches the transport giving out.

    Run #9 died here: `score` opened a connection, waited eight minutes on a
    batch poll, and by the time results came back Neon had closed the idle
    socket. pg8000 raised InterfaceError from inside _store_run.
    """
    import pg8000.exceptions

    if isinstance(exc, pg8000.exceptions.InterfaceError):
        return True
    # The socket layer underneath, which surfaces directly often enough.
    if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                        BrokenPipeError, TimeoutError)):
        return True
    if isinstance(exc, OSError) and getattr(exc, "errno", None) in (10054, 10053, 104, 32):
        return True
    # pg8000 sometimes wraps the socket error in a bare Exception whose text is
    # the only thing identifying it. Matched narrowly, on phrases that cannot
    # appear in a constraint or syntax message.
    text = str(exc).lower()
    return any(p in text for p in (
        "network error", "connection is closed", "socket", "broken pipe",
        "connection reset", "server closed the connection",
    ))


def with_reconnect(work, attempts=3, on_retry=None):
    """Run `work(con)` on a FRESH connection, retrying if the transport dies.

    `work` receives a connection and must do everything including the commit.
    It is called from the beginning on each attempt, which is only safe because
    every write it performs is idempotent — score_runs and scores both use
    ON CONFLICT DO UPDATE, and a batch's results can be re-read from the API as
    many times as you like.

    WHY RE-RUN RATHER THAN RESUME. The whole collection is one transaction with
    a single commit at the end, so a connection death rolls the server side back
    completely: no scores, no aggregates, and `collected_at` still NULL. There
    is no partial state to resume from, which makes "start again" both the
    simplest and the only correct answer.

    A connection is opened per attempt and closed after, so nothing is held
    across the retry sleep — holding an idle connection across a wait is the
    bug this exists to fix.
    """
    import time

    last = None
    for attempt in range(1, attempts + 1):
        con = None
        try:
            con = connect()
            return work(con)
        except Exception as exc:            # noqa: BLE001 - re-raised below
            last = exc
            if not is_connection_error(exc) or attempt == attempts:
                raise
            if on_retry:
                on_retry(attempt, exc)
            # Short, increasing, and bounded. Neon wakes a suspended compute in
            # a few seconds; anything longer here just delays a real failure.
            time.sleep(2 * attempt)
        finally:
            if con is not None:
                try:
                    con.close()
                except Exception:           # noqa: BLE001
                    pass                    # already dead; nothing to salvage
    raise last


def connect():
    """A Postgres connection wearing the sqlite3 API. Raises if misconfigured."""
    import pg8000.dbapi as dbapi

    url = _url()
    if not url:
        raise RuntimeError(
            "DATABASE_URL_UNPOOLED is not set.\n"
            "  It should hold the Neon DIRECT connection string — the one whose host\n"
            "  does NOT contain \"-pooler\". The CLI runs DDL and long transactions,\n"
            "  which PgBouncer in transaction mode does not support.\n"
            "  Neon console -> Connect -> \"Connection pooling\" OFF -> copy."
        )
    if "-pooler." in url:
        raise RuntimeError(
            "DATABASE_URL_UNPOOLED holds the POOLED string, but the CLI needs the DIRECT one.\n"
            "  Its host contains \"-pooler\", which is PgBouncer in transaction mode: no DDL,\n"
            "  no SET/RESET, no temp tables. This script runs CREATE TABLE on startup and\n"
            "  will fail on it.\n"
            "  Fix: Neon console -> Connect -> \"Connection pooling\" OFF -> copy -> set\n"
            "  DATABASE_URL_UNPOOLED."
        )

    # Every `?` in the codebase works as-is. No rewriting, and a % inside a LIKE
    # pattern is never mistaken for a placeholder.
    dbapi.paramstyle = "qmark"
    u = urllib.parse.urlparse(url)
    kw = dict(
        user=urllib.parse.unquote(u.username or ""),
        password=urllib.parse.unquote(u.password or ""),
        host=u.hostname,
        port=u.port or 5432,
        database=(u.path or "/").lstrip("/").split("?")[0],
        ssl_context=True,
        # SCALE-TO-ZERO MEANS THE FIRST CONNECTION AFTER IDLE IS A COLD START.
        #
        # Neon suspends compute when nothing has talked to it, which is what
        # keeps the free tier free and must stay on. Waking it takes a few
        # seconds, and the first connect can sit there or be refused outright
        # while the proxy brings it up.
        #
        # An EXPLICIT 30s beats the default. Without one, pg8000 inherits the
        # OS socket timeout, which is minutes on some paths and immediate on
        # others -- so the behaviour on a cold start depended on which machine
        # was asking. 30 seconds is well past Neon's wake time and well short of
        # a cron step hanging.
        timeout=CONNECT_TIMEOUT,
    )
    try:
        return Connection(dbapi.connect(**kw))
    except Exception as e:
        # ONE RETRY, AND ONLY FOR THE TRANSPORT. A wrong password or a missing
        # database is not going to be right the second time, and retrying it
        # would turn a clear error into a slow one. is_connection_error() is the
        # same predicate with_reconnect() uses.
        if not is_connection_error(e):
            raise
        time.sleep(COLD_START_WAIT)
        return Connection(dbapi.connect(**kw))


# Seconds to wait for the socket. See the note in connect().
CONNECT_TIMEOUT = 30

# How long to wait before the single retry. Long enough that the compute has
# actually started rather than being asked again mid-wake.
COLD_START_WAIT = 3
