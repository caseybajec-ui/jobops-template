#!/usr/bin/env python3
"""How much of a posting's description is stored. ONE definition, two callers.

This module exists because the rule was written twice and only one copy was
right. The 64 MB -> 22.4 MB trim ran as a one-off during the migration, while
`fetch_jobs.py` kept writing full descriptions — so the trim survived exactly
until the next 07:10 cron, and the database would have refilled over months with
nobody watching.

So: the predicate lives here, `fetch_jobs.py` applies it on every write, and
`backfill_descriptions.py` applies the identical function to existing rows.
`test_storage_policy.py` fails if the stored state and the write rule disagree.

THE PREDICATE. Full text for anything that passed the title filter OR that the
owner has ever acted on; the first 2,000 characters for everything else.

Why the title filter and not "reachable":

  * The title filter is UPSTREAM of reachability. A role can become reachable
    later — its class year is re-read, a clearance line is re-parsed, the pay
    band changes — and if the rule were "reachable", that role would already be
    stored truncated and would only recover on the next fetch. Keying on the
    title filter removes that gap rather than documenting it.
  * It costs storage rather than saving it: 26.6 MB against the 22.4 MB the old
    rule left behind, because it keeps full text for 1,561 candidates instead of
    the 649 that happened to be reachable. Both are far under Neon's 0.5 GB, and
    the untrimmed 64 MB is what actually mattered. Correctness bought the 4 MB.

Why "ever acted on" is a SEPARATE clause and not a consequence of the first one:
`candidate` is not immutable. It is recomputed from `title_include` /
`title_exclude` on every fetch, and those get tuned. A role the owner saved in
October can become a non-candidate in November because a filter term changed —
and the next 07:10 cron would silently truncate the one row they had explicitly
kept. Deriving this from `candidate` alone would be right today and wrong the
first time the filter moves. There are zero actions on non-candidates right now,
which makes the clause vacuous, NOT unnecessary; a check that can only start
failing later is worth writing while it still passes.

Nothing the scorer or the app reads is lost. The scorer trims to ~9,000
characters anyway and only ever sees gated survivors, all of which are
candidates; the app displays no description at all.
"""
import io

KEEP_FULL_CHARS = 2000


def tracked_boards():
    """Every (source, slug) this tool polls, from companies.yaml.

    Read once and cached. companies.yaml IS the list of companies the owner tracks,
    so membership in it is the same question as "is this a company we care
    about" -- there is no second list to keep in step.
    """
    global _TRACKED
    if _TRACKED is None:
        import yaml
        from paths import repo
        cfg = yaml.safe_load(
            io.open(repo("companies.yaml"), encoding="utf-8")) or {}
        out = set()
        for key, entries in cfg.items():
            for src in _BOARDS:
                if key == src or key.endswith("_" + src):
                    for e in (entries or []):
                        if isinstance(e, dict) and e.get("slug"):
                            out.add((src, e["slug"]))
        if not out:
            # A PARSE THAT MATCHED NOTHING WOULD SILENTLY TRIM EVERY ROW.
            # companies.yaml has had 59 boards for months; zero means the file's
            # shape changed, and failing loudly here is far cheaper than
            # discovering it after a fetch has discarded 40 MB of text that can
            # only be recovered from the boards.
            raise RuntimeError(
                "storage_policy: parsed 0 boards out of companies.yaml. "
                "Refusing to decide what to keep from an empty list.")
        _TRACKED = out
    return _TRACKED


_TRACKED = None
_BOARDS = ("greenhouse", "lever", "ashby", "rippling")


def keep_full(candidate, acted=False, tracked=False):
    """True if this row keeps its complete description.

    `candidate` is jobs.candidate — 1 when the title filter passed it.
    `acted` is True when the row has any row in `actions` — saved, dismissed,
    staged, whatever kind. Callers that cannot cheaply know this may omit it
    ONLY when they are writing a row that is a candidate anyway.
    `tracked` is True when the row's board is listed in companies.yaml.

    WHY `tracked` WAS ADDED (2026-09-06). Blocker tagging is the first consumer
    that reads EVERY role rather than only candidates, and it cannot say anything
    about a posting whose requirements section was cut off: 9,691 of 9,708
    non-candidates sat at exactly KEEP_FULL_CHARS, and 8,777 open roles reported
    `unknown` for no better reason than that. A tag that is silent on three
    quarters of the corpus is not a tag.

    IT IS BARELY NARROWER THAN NO CAP AT ALL, and that was measured rather than
    assumed: 11,494 of 11,500 open roles come from a listed board, and the six
    that do not are `manual` entries which are candidates anyway. Tier 1 alone is
    92% of the corpus, so restricting by tier saves 3 MB of 41. It is still the
    right rule to WRITE rather than simply deleting the cap, because it says why
    a row is worth keeping: a company the owner tracks. Drop a company from
    companies.yaml and its rows go back to being trimmed.
    """
    return bool(candidate) or bool(acted) or bool(tracked)


def store_description(description, candidate, acted=False, tracked=False):
    """The description exactly as it should be stored."""
    if description is None:
        return None
    if keep_full(candidate, acted, tracked):
        return description
    return description[:KEEP_FULL_CHARS]


# The same rule as SQL, for set-based work. Kept beside the Python so the two
# cannot drift apart unnoticed; test_storage_policy.py checks them against each
# other over real rows.
def _sql_tracked():
    """`(source, slug)` membership as a SQL predicate, built from the same list.

    Generated rather than hand-written so the SQL and the Python cannot drift:
    two definitions of one rule is exactly how schema.sql fell twenty columns
    behind reality. Slugs are the ones in companies.yaml -- lowercase, ASCII,
    dots and hyphens -- and are quoted anyway.
    """
    pairs = ",".join(
        "('%s','%s')" % (src.replace("'", "''"), slug.replace("'", "''"))
        for src, slug in sorted(tracked_boards()))
    return "((source, slug) IN (%s))" % pairs


SQL_KEEP_FULL = ("(candidate = 1 OR key IN (SELECT key FROM actions)"
                 " OR " + _sql_tracked() + ")")
SQL_STORED_LENGTH = (
    "CASE WHEN " + SQL_KEEP_FULL + " THEN length(description)"
    " ELSE LEAST(length(description), %d) END" % KEEP_FULL_CHARS
)
