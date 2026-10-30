#!/usr/bin/env python3
"""The apply-pack generator. Pure parts only, no database, no model.

Run: python test_apply_packs.py
"""
import io
import re
import sys

import apply_packs as ap
from console import utf8_stdout
from paths import repo

utf8_stdout()
FAILS, PASSED = [], 0


def ok(cond, what):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILS.append(what)


# ============ THE VARIANT MAP MATCHES web/lib/variant.js ===================

# The lookup lives in two languages because the page renders it and the batch
# needs it. Two spellings of one rule is how schema.sql drifted twenty columns,
# so the JS is parsed and compared rather than trusted to have been kept in step.
js = io.open(repo("web/lib/variant.js"), encoding="utf-8").read()
block = re.search(r"const BY_CATEGORY = \{(.*?)\}", js, re.S)
ok(block is not None, "found BY_CATEGORY in web/lib/variant.js")
js_map = dict(re.findall(r"(\w+):\s*\"(\w+)\"", block.group(1))) if block else {}
ok(len(js_map) >= 4, f"parsed the JS map ({len(js_map)} entries)")
for cat, want in js_map.items():
    ok(ap.variant_for(cat) == want,
       f"category `{cat}` maps to {want} in both languages, "
       f"python says {ap.variant_for(cat)}")

# AN UNKNOWN CATEGORY IS NULL, NOT A GUESS. variant.js returns null and the
# surfaces show no tag; the pack must do the same rather than defaulting to tech
# because most roles happen to be tech.
ok(ap.variant_for("charity") is None, "an unknown category has no variant")
ok(ap.variant_for(None) is None, "and neither does a missing one")

# ==================== WHAT COUNTS AS A NON-BLOCKING TAG ====================

ok("clearance_obtainable" in ap.OK_BLOCKERS,
   "an obtainable clearance does not disqualify a role from being packed")
ok("citizenship_only" in ap.OK_BLOCKERS, "nor does US-citizens-only")
for t in ("cs_degree", "years_4plus", "clearance"):
    ok(t not in ap.OK_BLOCKERS, f"{t} DOES disqualify")

# ============== THE RULES SAY THE THINGS THAT MUST NOT DRIFT ===============

R = ap.RULES
ok("INVENT NOTHING" in R, "the rules forbid invention first")
ok("NEVER CLAIM A CLEARANCE" in R, "and forbid claiming a clearance")
ok("adjudicator" in R,
   "naming WHY: eligibility is decided by an adjudicator, not the candidate")
ok(re.search(r"clearance-eligible", R) is not None,
   "and forbids the specific phrase that reads as a settled determination")
ok("NO EM DASHES" in R, "and forbid em dashes")
ok("NO SQUARE BRACKETS" in R, "and forbid bracket placeholders")
# THE CLASS YEAR COMES FROM profile.json. The rules must name the owner's
# graduation and start season, and must NOT carry anyone else's: the template
# shipped with one person's year typed in, which is how a copy writes cover
# notes for the wrong class.
from owner import OWNER
ok(OWNER["graduation"] in R and f"summer {OWNER['grad_year']}" in R,
   "and state the owner's class year, so nothing is written as if they could start now")
ok(OWNER["name"] in R, "and the owner's name, from profile.json")
ok(OWNER["school_short"] in R, "and the owner's school, from profile.json")
_src = io.open(repo("apply_packs.py"), encoding="utf-8").read()
ok(not re.search(r"\b(?:May|June|December) 20\d\d\b", _src),
   "apply_packs.py carries no month-year literal of its own")
ok(not re.search(r"class of 20\d\d", _src, re.I),
   "nor a literal class year")

# THE RULES THEMSELVES MUST OBEY THE RULES. A prompt containing an em dash while
# forbidding them is the kind of thing nobody checks.
ok(not re.search("[—–]", R), "the rules text contains no em dash itself")

# Brackets appear ONLY inside rule 4, which necessarily quotes the placeholders
# it forbids. Anywhere else in the prompt they would be a placeholder the model
# could copy straight into a cover note.
_rule4 = re.search(r"4\. NO SQUARE BRACKETS.*?(?=\n\n)", R, re.S)
ok(_rule4 is not None, "rule 4 is findable")
ok("[" not in R.replace(_rule4.group(0) if _rule4 else "", ""),
   "and no bracket appears anywhere else in the prompt")

# ================= EM DASHES AND BRACKETS ARE REMOVED IN CODE ==============

# "If code can decide it, code decides it." Asking a model for no em dashes
# works most of the time; removing them works every time.
ok("—" not in ap._clean("a — b"), "an em dash is stripped from output")
ok("–" not in ap._clean("a – b"), "and an en dash")
ok(ap._clean(None) is None, "None survives as None")
ok(ap._clean("  padded  ") == "padded", "and whitespace is trimmed")

# ========================= THE JSON PARSER =================================

ok(ap._parse('{"a": 1}') == {"a": 1}, "plain JSON parses")
ok(ap._parse('Here you go:\n{"a": 1}\nHope that helps') == {"a": 1},
   "JSON wrapped in prose parses, which models produce about half the time")
ok(ap._parse('{"a": {"b": 2}}') == {"a": {"b": 2}}, "nested objects parse")
ok(ap._parse("no json here") is None, "and a response with none returns None")
ok(ap._parse("") is None, "as does an empty one")

# ===================== THE ESTIMATE COMES FROM THE REQUESTS ================

fake = [{"custom_id": f"pack-{i}",
         "params": {"model": ap.MODEL, "max_tokens": ap.MAX_TOKENS,
                    "system": [{"type": "text", "text": "x" * 40000,
                                "cache_control": {"type": "ephemeral"}}],
                    "messages": [{"role": "user", "content": "y" * 4000}]}}
        for i in range(10)]
est = ap.estimate(fake)
ok(est["n"] == 10, "the estimate counts the real requests")
ok(est["cost"] > 0, "and produces a cost")
# THIS USED TO ASSERT "caching is cheaper", WHICH THE FIRST REAL BATCH
# DISPROVED. Measured usage showed ~104 cache WRITES against 75 reads over 124
# parallel requests, not one write and 123 reads: workers that start before the
# cache is warm each write it, and the ephemeral cache expires inside a batch
# this long. At this shape caching costs about 11% MORE. It stays on because
# the owner asked for it, but the test now asserts the estimator REPORTS the
# comparison rather than asserting a saving that is not there.
ok(abs(est["cost"] - est["uncached_cost"]) / est["uncached_cost"] < 0.5,
   "cached and uncached costs are within the same order, which is the honest "
   "claim -- the tenfold saving the first version assumed was never real")
ok(est["uncached_cost"] > 0, "and the uncached figure is computed, so the "
   "dry-run can print the comparison instead of a claim")
ok(ap.estimate([])["cost"] == 0, "an empty batch costs nothing")

# CACHING IS OFF, AND THE COMPARISON IS STILL COMPUTED.
#
# It was on and measured 11% WORSE at this batch shape: ~104 cache writes
# against 75 reads over 124 parallel requests, because workers starting before
# the cache is warm each write the prefix and an ephemeral cache expires inside
# a forty-minute batch. Turning it off without keeping the counterfactual would
# mean never noticing if the shape changed back, so both numbers are computed
# every run and the dry-run prints them.
ok(ap.CACHE is False, "caching is off by default for this job")
ok("cached_cost" in est and est["cached_cost"] > 0,
   "and the cached counterfactual is still computed, so the comparison survives")
ok(est["cost"] == est["uncached_cost"],
   "with caching off, the quoted cost IS the uncached cost")

# The request the estimator priced is the request that would be sent: with
# caching off the system block is a plain string, with no cache breakpoint.
real_reqs, _ = ap.build_requests([])
ok(isinstance(real_reqs, list), "build_requests returns a list")

# ========================= NOTHING HERE SENDS ==============================

src = io.open(repo("apply_packs.py"), encoding="utf-8").read()
ok("smtp" not in src.lower() and "sendgrid" not in src.lower(),
   "no mail transport is imported")
ok("resend" not in src.lower(), "and no mail API")
ok("@" not in re.sub(r"https?://\S+", "", re.sub(r"#.*", "", src)),
   "and no email address appears anywhere in the file")

# THE BATCH API, NOT SYNCHRONOUS. Synchronous is double the price.
ok("batches.create" in src, "it submits through the Batch API")
ok("messages.create(" not in src, "and never synchronously")

# ============ THE ESTIMATE PRICES THE MODEL IN THE REQUEST =================

# Not the module global. They are the same value today; reading it off the
# object that will actually be sent is what keeps them the same tomorrow.
def one_req(model):
    return [{"custom_id": "pack-0", "params": {
        "model": model, "max_tokens": 8000, "system": "S" * 4000,
        "output_config": {"effort": "low"},
        "messages": [{"role": "user", "content": "M" * 8000}]}}]


# Haiku and Sonnet are exactly 3x apart on BOTH input and output, so a correct
# estimate that follows the request model differs by exactly 3.0. One that
# reads the global returns the same number twice.
c_haiku = ap.estimate(one_req("claude-haiku-4-5-20251001"))["cost"]
c_sonnet = ap.estimate(one_req("claude-sonnet-5"))["cost"]
ok(c_haiku > 0 and c_sonnet > 0, "the estimator prices both models")
ok(abs(c_sonnet / c_haiku - 3.0) < 1e-9,
   f"sonnet costs exactly 3x haiku for identical requests "
   f"({c_sonnet:.6f} / {c_haiku:.6f} = {c_sonnet / c_haiku:.4f}) -- "
   f"an estimate reading the module global would return the same twice")

# AN UNPRICED MODEL REFUSES. It used to fall back to Sonnet's rate, and this
# number is what gets checked against the monthly cap, so a wrong one decides
# rather than merely misinforms.
try:
    ap.estimate(one_req("claude-not-a-real-model"))
    ok(False, "estimate REFUSES an unpriced model")
except SystemExit as e:
    ok("No price for" in str(e),
       f"estimate refuses an unpriced model and says which: {str(e)[:60]}")

# ============ THE CLEARANCE RULE, ON THE WAY INTO THE TABLE ===============

# A pack is the only model-generated text in this tool that goes to an EMPLOYER,
# and CLAUDE.md calls clearance phrasing "the highest-stakes place in this
# pipeline to get wrong". The predicate guarded the resume, the profile card,
# the SF-86 page and Why -- every surface except this one.

# BOTH DIRECTIONS. A pattern tuned only against violations flags the permitted
# sentence too, and then the tool cannot say the one true thing it is allowed
# to say. This is not hypothetical: the shipped predicate did exactly that, and
# it was found on the real top-scoring Palantir cover note.
FORBIDDEN_TEXT = [
    ("He is cleared for TS/SCI.", "is cleared"),
    ("I have an active clearance.", "active clearance"),
    ("She holds a current clearance.", "current clearance"),
    ("I am clearance-eligible.", "clearance-eligible"),
    ("He holds a top secret clearance.", None),      # matched, phrase varies
    ("My eligibility has been confirmed.", None),
    # NEGATION IS NOT A BYPASS for a flat assertion.
    ("There is no doubt that he is cleared.", "is cleared"),
    # ADJACENT negator. The sentence above has three words between "no"
    # and the phrase, so NEGATOR does not reach it either way -- it could
    # not tell a working guard from a broken one. This one CAN: "no" is one
    # word away, so it is excused the moment assertions become negatable.
    ("No one is cleared for this programme.", "is cleared"),
    ("Not everyone is cleared.", "is cleared"),
]
for text, want in FORBIDDEN_TEXT:
    got = ap.clearance_claim(text)
    ok(got is not None,
       f"REFUSED: {text!r}" + ("" if got else " -- WAS NOT CAUGHT"))
    if want:
        ok(got == want, f"and it names the phrase {want!r}, got {got!r}")

PERMITTED_TEXT = [
    "US citizen, no current or prior clearance, no known disqualifying factors, "
    "willing to undergo the process.",
    # The sentence from the real Palantir Deployment Strategist pack. A guard
    # that rejected this would re-pack the role forever, paying each time to
    # regenerate text that was already correct.
    "I am a US citizen, hold no clearance, know of no disqualifying factors, "
    "and am ready to start the process whenever it begins.",
    "I have no active clearance and no prior government deployment experience.",
    "I hold no active clearance.",
    "I do not have a current clearance.",
    "Applying without an active clearance.",
    "Willing to undergo the clearance process.",
    "No clearance mentioned in the posting.",
]
for text in PERMITTED_TEXT:
    got = ap.clearance_claim(text)
    ok(got is None, f"ALLOWED: {text[:52]!r}"
       + (f" -- WRONGLY FLAGGED on {got!r}" if got else ""))

# ONE DEFINITION IN TWO LANGUAGES, compared rather than trusted. The JS is the
# source; this parses it. A pattern added there and not here would otherwise be
# enforced on the pages and not on the packs -- the exact gap being closed.
js_clr = io.open(repo("web/lib/clearance.js"), encoding="utf-8").read()
js_srcs = re.findall(r"String\.raw`([^`]+)`", js_clr)
ok(len(js_srcs) >= 12, f"parsed the JS clearance patterns ({len(js_srcs)})")
ok(len(ap._ASSERT_SRC) + len(ap._POSSESS_SRC) == len(js_srcs),
   f"python reads every JS pattern "
   f"({len(ap._ASSERT_SRC)}+{len(ap._POSSESS_SRC)} vs {len(js_srcs)})")
ok(set(ap._ASSERT_SRC + ap._POSSESS_SRC) == set(js_srcs),
   "and exactly those, with none of its own")

# THE PACK IS REFUSED, NOT CLEANED. _clean strips em dashes because a dash is
# formatting; a false claim and a bracket are not fixable by editing a string.
good = {f: "true, plain, verifiable text." for f, _ in ap.PROMPTS}
good["cover_note"] = "I am a US citizen and hold no clearance."
good["variant_reason"] = "tech leads with shipped infrastructure."
ok(ap.pack_violation(good) is None, "a clean pack is stored")

bad = dict(good)
bad["why_company"] = "I am clearance-eligible for this work."
ok(ap.pack_violation(bad) is not None, "a pack claiming eligibility is REFUSED")
ok("why_company" in (ap.pack_violation(bad) or ""),
   f"and the reason names the field: {ap.pack_violation(bad)}")

# NEVER EMIT A BRACKET, on the same path.
brk = dict(good)
brk["project_story"] = "Cut AI cost per brief by [X]% using the Batch API."
ok(ap.pack_violation(brk) is not None, "a pack carrying a [placeholder] is REFUSED")
ok("[X]" in (ap.pack_violation(brk) or ""),
   f"and the reason quotes it: {ap.pack_violation(brk)}")

# A pack refused for one field is refused whole; the rest was written around it.
ok(ap.pack_violation({"cover_note": "He is cleared."}) is not None,
   "one bad field refuses the pack")

# ============ COLLECT: A RUNNING BATCH IS SKIPPED, NOT FATAL ===============

# do_collect takes an injectable client so these two branches can be reached
# without the API: a batch still running, and results spanning two models.
# Both were previously only reachable by having a real batch in flight, which
# is to say they were never tested at all.
#
# THE SHAPE THIS GUARDS. The real SDK RAISES on results() for an unfinished
# batch -- verified against a live one on 2026-09-06:
#   AnthropicError: No `results_url` for the given batch; ... in_progress
# so one running batch used to abort the whole command and take every FINISHED
# batch in the same run down with it. The fake below raises exactly that way.

import contextlib
import json as _json
from types import SimpleNamespace as NS


class FakeResults:
    """Stands in for messages.batches. Raises on an unfinished batch."""

    def __init__(self, states, results):
        self.states, self.results_by_id = states, results
        self.retrieved, self.results_called = [], []

    def retrieve(self, bid):
        self.retrieved.append(bid)
        return NS(processing_status=self.states[bid])

    def results(self, bid):
        self.results_called.append(bid)
        if self.states[bid] != "ended":
            raise RuntimeError(
                "No `results_url` for the given batch; "
                f"Has it finished processing? {self.states[bid]}")
        return iter(self.results_by_id.get(bid, []))


def fake_client(states, results):
    return NS(messages=NS(batches=FakeResults(states, results)))


def pack_result(cid, tin, tout, cw=0, cr=0, capped=False):
    body = _json.dumps({f: f"text for {f}" for f, _ in ap.PROMPTS}
                       | {"variant_reason": "because"})
    return NS(custom_id=cid, result=NS(
        type="succeeded",
        message=NS(
            content=[NS(type="text", text=body)],
            stop_reason="max_tokens" if capped else "end_turn",
            usage=NS(input_tokens=tin, output_tokens=tout,
                     cache_creation_input_tokens=cw,
                     cache_read_input_tokens=cr))))


class FakeCon:
    """Enough of the connection for do_collect. Records every write."""

    def __init__(self, batches):
        self.batches, self.writes, self.commits = batches, [], 0

    def execute(self, sql, params=()):
        s = " ".join(sql.split())
        if s.startswith("SELECT batch_id"):
            return NS(fetchall=lambda: self.batches)
        if s.startswith("SELECT category"):
            return NS(fetchone=lambda: {"category": "product"})
        self.writes.append((s, params))
        return NS(fetchall=lambda: [], fetchone=lambda: None)

    def commit(self):
        self.commits += 1

    def stored(self):
        return [w for w in self.writes if w[0].startswith("INSERT INTO apply_packs")]

    def marked(self):
        # The batch_id is the LAST parameter, not the second. It moved when the
        # update began writing measured usage back, and hardcoding position 1
        # made this read a token count as a batch id.
        return [w[1][-1] for w in self.writes if w[0].startswith("UPDATE batches")]


def run_collect(batches, states, results):
    cl = fake_client(states, results)
    buf = io.StringIO()
    con = FakeCon(batches)
    with contextlib.redirect_stdout(buf):
        rc = ap.do_collect(con, client=cl)
    return rc, buf.getvalue(), con, cl.messages.batches


HAIKU, SONNET = "claude-haiku-4-5-20251001", "claude-sonnet-5"
KEYMAP = _json.dumps({"pack-0": "co::role"})

# --- one running batch, alone: skipped, and NOT marked collected ------------
rc, out, con, api = run_collect(
    [{"batch_id": "b_run", "model": HAIKU, "keymap": KEYMAP}],
    {"b_run": "in_progress"}, {})
ok(rc == 0, "a running batch does not make collect fail")
ok("still in_progress" in out, "it says the batch is still running")
ok(api.results_called == [],
   f"results() is never called on a running batch (called {api.results_called})")
ok(con.stored() == [], "and nothing is written for it")
ok(con.marked() == [],
   "and it is NOT marked collected, so the next run picks it up")

# --- the finished one still lands when a running one is in the same run -----
# THIS is the regression. Order matters: the running batch comes FIRST, so a
# raise would kill the finished batch behind it.
rc, out, con, api = run_collect(
    [{"batch_id": "b_run", "model": HAIKU, "keymap": KEYMAP},
     {"batch_id": "b_done", "model": HAIKU, "keymap": KEYMAP}],
    {"b_run": "in_progress", "b_done": "ended"},
    {"b_done": [pack_result("pack-0", 1000, 100)]})
ok(rc == 0, "a mixed run succeeds")
ok(len(con.stored()) == 1,
   f"the FINISHED batch behind the running one still stored its pack "
   f"({len(con.stored())} stored)")
ok(con.marked() == ["b_done"],
   f"only the finished batch is marked collected (marked {con.marked()})")
ok("1 batch(es) still running" in out,
   f"and the count of waiting batches is reported: {out.strip()[:90]}")

# ---- the guard, THROUGH collect, not just called directly ----------------
#
# pack_violation being correct is worth nothing if do_collect never calls it.
# The mutation audit found exactly that hole: blanking the call site left every
# direct test of the predicate green.

def violating_result(cid, field, text):
    body = _json.dumps({f: "true, plain, verifiable text." for f, _ in ap.PROMPTS}
                       | {"variant_reason": "because", field: text})
    return NS(custom_id=cid, result=NS(
        type="succeeded",
        message=NS(content=[NS(type="text", text=body)], stop_reason="end_turn",
                   usage=NS(input_tokens=100, output_tokens=50,
                            cache_creation_input_tokens=0,
                            cache_read_input_tokens=0))))


for field, text, label in (
        ("cover_note", "I am clearance-eligible and ready to deploy.", "a clearance claim"),
        ("why_role", "I cut cost per brief by [X]%.", "a [placeholder]")):
    rc, out, con, api = run_collect(
        [{"batch_id": "b_v", "model": HAIKU, "keymap": KEYMAP}],
        {"b_v": "ended"}, {"b_v": [violating_result("pack-0", field, text)]})
    ok(rc == 0, f"collect survives {label}")
    stored = con.stored()
    ok(len(stored) == 1, f"{label}: the raw row is still written ({len(stored)})")
    # THE RAW IS KEPT AND THE FIELDS ARE NOT. It is paid for, and cover_note
    # staying NULL is what re-queues the role on the next run.
    ok("raw" in stored[0][0] if stored else False,
       f"{label}: stored as RAW, not as a finished pack")
    ok("REFUSED" in out, f"{label}: it says REFUSED, naming the field")
    ok(field in out, f"{label}: and names {field}")
    ok("1 REFUSED on a hard rule" in out,
       f"{label}: the run summary counts it -- got {out.strip()[-90:]!r}")

# AND A CLEAN PACK STILL LANDS, so the guard cannot pass by refusing everything.
rc, out, con, api = run_collect(
    [{"batch_id": "b_ok", "model": HAIKU, "keymap": KEYMAP}],
    {"b_ok": "ended"}, {"b_ok": [pack_result("pack-0", 100, 50)]})
ok("REFUSED" not in out, "a clean pack is not refused")
ok(len(con.stored()) == 1 and "variant" in con.stored()[0][0],
   "and lands as a full pack")

# ============ COLLECT COSTS ARE PRICED PER MODEL, NOT IN ONE PILE ==========

# Two ended batches, different models, identical usage. Priced correctly these
# are $0.75 + $2.25 = $3.00. Priced as ONE PILE at the module default's rate --
# the bug this replaces -- the same tokens come to $4.50. The test asserts the
# VALUE, so it cannot pass on a mispriced total.
U = dict(tin=1_000_000, tout=100_000)
rc, out, con, api = run_collect(
    [{"batch_id": "b_h", "model": HAIKU, "keymap": KEYMAP},
     {"batch_id": "b_s", "model": SONNET, "keymap": KEYMAP}],
    {"b_h": "ended", "b_s": "ended"},
    {"b_h": [pack_result("pack-0", **U)], "b_s": [pack_result("pack-0", **U)]})


def money(s):
    return sorted(float(x) for x in re.findall(r"\$([0-9]+\.[0-9]{2})", s))


ok(HAIKU in out and SONNET in out, "both models are named in the cost report")
ok("0.75" in out, f"haiku priced at its own rate ($0.75); got {money(out)}")
ok("2.25" in out, f"sonnet priced at its own rate ($2.25); got {money(out)}")
ok("3.00" in out, f"the total is the SUM of the two ($3.00); got {money(out)}")
ok("4.50" not in out,
   "and NOT the one-pile figure ($4.50) the module default would have given")
ok(len(con.stored()) == 2, "both batches stored their packs")

# --- an unpriced model is reported, never guessed at Sonnet's rate ----------
rc, out, con, api = run_collect(
    [{"batch_id": "b_x", "model": "claude-does-not-exist", "keymap": KEYMAP}],
    {"b_x": "ended"}, {"b_x": [pack_result("pack-0", **U)]})
ok("UNPRICED" in out, "an unpriced model says so instead of inventing a cost")
ok("1,000,000" in out,
   "its real token counts are still printed -- only the dollar figure is held")
ok("2.25" not in out,
   "and it is NOT silently billed at the Sonnet fallback the old line used")

# --- capped responses are still surfaced, per model -------------------------
rc, out, con, api = run_collect(
    [{"batch_id": "b_c", "model": HAIKU, "keymap": KEYMAP}],
    {"b_c": "ended"}, {"b_c": [pack_result("pack-0", 1000, 100, capped=True)]})
ok("hit max_tokens" in out, "a capped response is warned about")

# THE INJECTION POINT IS FOR TESTS AND CHANGES NOTHING FOR CALLERS.
ok("def do_collect(con, client=None)" in src,
   "do_collect still defaults to the real client")

ok(PASSED > 35, f"the suite exercised the generator ({PASSED} checks)")

print(f"test_apply_packs: {PASSED} passed" if not FAILS
      else f"test_apply_packs: {len(FAILS)} FAILED, {PASSED} passed")
for f in FAILS:
    print(f"  FAIL  {f}")
sys.exit(1 if FAILS else 0)
