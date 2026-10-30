# JobOps

A personal job-search pipeline for one person — the owner of this clone. Automate discovery,
analysis, and drafting; keep a human gate on every send. The value is in knowing what to apply
to and who to talk to first, not in spraying applications.

A future session should be able to start from this file alone. It is long because it is the
record of every way this system has been wrong, and each entry exists so that the same mistake
is not made twice. Read the Hard rules and the COST section before touching anything.

## Who the owner is

**`profile.json` is the only source of truth about the person this instance serves.** It holds
their name, school, graduation, targets, hard-nos, citizenship and clearance wording, and an
`evidence` array that every claim the tool ever makes about them must trace to. The setup step
(`setup/SETUP.md`) builds it from their resume and inputs; `profile.example.json` shows the
shape for a fictional person.

Code reads personal facts through exactly two doors:

- **Python:** `from owner import OWNER` — `owner.py` loads `profile.json` once and exposes
  `name`, `first_name`, `email`, `school`, `school_short`, `school_search_terms`,
  `school_linkedin_alumni_url`, `class_label`, `degree`, `home_city`, `grad_year`,
  `grad_month`, `target_start`, `citizenship`, `clearance`.
- **Web:** the `OWNER` export of `web/lib/config.generated.js`, baked from `profile.json` at
  build time by `web/lib/genconfig.mjs`, re-exported through `web/lib/constants.js` as
  `OWNER`, `USER_CLASS_YEAR`, `NOTIFY_TO`, `SCHOOL_LINKEDIN_ALUMNI`, `SCHOOL_SEARCH_PREFIX`.

**No personal fact may ever be a literal in code.** Not a name, not a school, not a class
year, not an email, not a city. The template was built for one person and had those baked
into prompts, outreach templates and the class-year classifier — exactly the kind of thing
that survives a copy and then quietly produces someone else's cover letter. If a prompt, a
label or a test needs the owner's name or year, it reads `OWNER`; if `OWNER` lacks the field,
add it to `profile.json` and to both readers, never to the call site.

What the owner *wants*, as opposed to what they *are*, lives in `config.yaml` under
`preferences:` and is deliberately not in `profile.json` — see that file's comments for why.

## Files

- `fetch_jobs.py` — polls Greenhouse / Lever / Ashby / **Rippling** public boards listed in `companies.yaml` into **Neon Postgres**. `discover <name>` finds a company's ATS and slug; `resolve <name> <domain>` reads the company's own careers page for the link. `manual` applies `manual_jobs.yaml`.
- `test_filters.py` — tests for `title_ok`. Run `python test_filters.py` before committing any filter change.
- `web/lib/today.js` — the Daily ladder: which single thing to do right now, and the cycle
  frame line above it. Pure, no I/O, no model. `web/test_today.mjs` covers it.
- `score_jobs.py` — `gate` runs the deterministic classifiers and writes the verdict; `score` sends unscored reachable candidates to Claude on the Batch API against `profile.json`; `rank`, `show`, `cost`, `verify-models`. Profile goes in the system prompt.
- `classify.py` — the deterministic classifiers (level, class year, clearance, blockers). Every verdict the gate writes comes from here.
- `profile.json` — source of truth for who the owner is. Every claim the tool ever makes about them must trace to an `evidence` item here. `owner.py` is the only Python reader.
- `projects.md` — what the owner has actually built, in prose. Read into the system prompt by `apply_packs.py`, `pack_critic.py` and `prep_pack.py`, so it may contain only true projects.
- `companies.yaml` — target companies grouped by ATS (`greenhouse`, `ashby`, `lever`, `rippling`, `defense_*`, `new_*`, `infrared_*`, `manual`) plus the five title-filter lists, plus the `deadlines:` block for windows no board exposes.
- `config.yaml` — the spend cap and its reset date, the Neon plan's transfer allowance, on-track targets, preferences, notification switches. Baked into the web bundle at build time; read by Python directly.
- `daily.yaml` — seed on-you items; `seed_items.py` moves them into the `items` table once.
- `manual_jobs.yaml` — roles typed in by hand because no board exposes them; `source: manual` rows bypass every gate.
- `migrations/001_initial.sql` — the Postgres schema, generated from the live SQLite
  schema. A hand-maintained `schema.sql` used to hold this and drifted 20 columns; it is gone.
  `test_schema_parity.py` fails when the two diverge. Later migrations apply themselves from the daily workflow.
- `resume_tech.md` / `resume_finance.md` — **the two authoritative resumes**, GENERATED from
  `web/public/resume/resume-tech.pdf` and `resume-finance.pdf` by
  `python resume_from_pdf.py install <src.pdf> <variant>`, which VERIFIES the source is that
  variant before it copies anything — the swap it prevents (finance PDF into the tech slot)
  passes every parity check afterwards. Never hand-edit them: edits are lost on the next run
  and `python test_resume_parity.py` fails, because it asserts each file equals exactly what
  the converter produces from its PDF today. Tech covers defense and product & tech; finance
  covers consulting and VC & growth.
- **There is no `resume_current.md`, no `resume_v2.md`, no `resume_retired_*.md`.** Sessions
  have reached for each of those names. The two files above are the only authoritative
  resumes; when a brief says "the current resume", read `resume_tech.md` and
  `resume_finance.md` and say which one. The owner supplies resume text; never fabricate it.
- `web/lib/variant.js` — **which resume goes to which company**, by company category, in code. No
  model decides this. An unknown category returns null and the surfaces show no tag rather than a
  guess.
- `apply_packs.py` / `pack_critic.py` / `prep_pack.py` — the pack writer (cover note, fit, talking points per role), the critic that refuses a pack whose claims the source material does not support, and the interview-prep builder. All three read `profile.json`, `projects.md` and both resumes, and nothing else about the owner.
- `contacts.py` / `outreach.py` / `source_contacts.py` — people, drafts, and the team-page sourcing that reads `company_sites.json`.
- `watch_pages.py` / `verify_deadlines.py` — the careers-page watcher and the deadline worklist. Neither scrapes a date.
- `README.md` — what it is, the views, the daily loop, the cost rules.
- `HOSTING.md` — Neon + Vercel + GitHub Actions, step by step, and what to expect to break.
- `setup/SETUP.md` — the one-shot setup with Claude Code for a new owner.
- `.gitignore` — `jobs.db*`, `__pycache__/`, `out/`, `voice/`, `.env`, `.env.local`, `/outreach/`, `/contacts.csv`, the generated web modules.
- `.github/workflows/daily.yml` — **the daily job runs here**, not on a laptop. Needs
  two repo secrets: `DATABASE_URL_UNPOOLED` (the DIRECT Neon string) and `ANTHROPIC_API_KEY`;
  `RESEND_API_KEY` and `NEON_API_KEY` are optional and must be mapped in the workflow to be seen.

## Environment

- **The original ran on Windows 11 under PowerShell**, on an ARM64 laptop. That is why this
  file has rules about cp1252 console output, CRLF line endings, backslashes through heredocs,
  `pg8000` over `psycopg` (no `win_arm64` wheel), and `puppeteer-core` driving an installed
  Chrome rather than downloading one. The rules stand on every platform because each one
  guards a silent failure; the *commands* do not. macOS and Linux users use bash
  equivalents: `python3`/`python` as installed, `&&` chaining, `$VAR`, `/dev/null`, `head`.
  `precommit.ps1` and `daily_run.ps1` are the Windows wrappers; `.githooks/*` and
  `daily_run.sh` are the portable ones.
- Python 3.12. `pip install -r requirements.txt` → requests, pyyaml, anthropic,
  python-dotenv, pg8000. Ask before adding anything beyond those.
- `ANTHROPIC_API_KEY` lives in `.env`, loaded by `python-dotenv` at the top of `fetch_jobs.py` and
  `score_jobs.py`. In `score_jobs.py` the `load_dotenv()` call sits **above** the module-level
  `JOBOPS_MODEL` lookup so `.env` can set the model too — keep that order if you reorganize imports.
- `.env` is gitignored. Verify with `git check-ignore -v .env`.
  **Never print, echo, log, or commit the key value.** Report only whether it loaded — a boolean,
  never the string. `python -c "import os, fetch_jobs; print(bool(os.environ.get('ANTHROPIC_API_KEY')))"`
- `JOBOPS_MODEL` optional. **The default is `claude-haiku-4-5-20251001`**, and the scorer
  refuses to run a different model over a table that already holds Haiku scores (see COST).
- `paths.py` anchors every repo file to `__file__`, so commands work from any directory; the
  rule "run from the repo root" is no longer load-bearing, but it is still the convention.

### Neon is the database. The local SQLite file is retired

`jobs.db` is renamed `jobs.db.retired-<date>` and nothing reads it. The web driver
**refuses** rather than falling back to it: an app that renders yesterday's roles without
saying so is worse than one that will not start. `JOBOPS_LOCAL_DB=1` is the deliberate opt-in
for working offline.

Two things the rename broke, both caught here rather than in a commit:

- **`jobs.db.retired-…` did not match the `jobs.db` gitignore line**, so a 94 MB database was
  one `git add -A` from the repo. The pattern is `jobs.db*` now, and
  `test_nothing_private_staged.py` treats anything containing `.db.` as a database.
- **`test_schema_parity.py` read the live file.** It builds the SQLite side in a throwaway
  temp database by calling `fetch_jobs.db()` instead — which is strictly better, because it
  compares the migration against the DDL that actually creates tables rather than against
  whatever a long-lived local file had accumulated.

**A rename moves a file out of range of every pattern that named it.** Check the ignore
rules and the guards, not just the code.

## Hard rules

Verbatim from the owner. Non-negotiable — refuse if asked to break one casually.

1. Never auto-submit an application. The tool prepares; the owner applies.
2. Never scrape LinkedIn or any site whose terms prohibit it. Contacts get entered by hand from the owner's school alumni directory, their clubs, and warm intros.
3. Never send an email unless the outreach row has approved=true. Drafts only until the owner approves.
4. Never invent resume content. Tailoring selects and reorders bullets from profile.json evidence. It does not create claims, numbers, or skills.
5. Keep it cheap. Cache the profile in the system prompt, trim postings, batch where possible, print cost estimates when you add a model call.
6. Preserve the existing CLI shape (fetch/discover/stats, gate/score/rank/show). Add commands; don't break existing ones.
7. When unsure whether something is in scope, ask the owner. Don't guess.

### The one LinkedIn exception, and everything still forbidden

Rule 2 says never scrape LinkedIn. **One narrow, read-only exception exists, and
nothing outside its limits is permitted.** The owner authorised it after being told
the risk in plain terms: LinkedIn's User Agreement §8.2 prohibits automated access,
read-only is not carved out, and the asset at risk is their own alumni network — the
highest-value input to the entire search and the one thing this tool cannot replace.
They decided; the limits below are theirs. **A new owner who has not made that decision
has not authorised it**: the reader stays off until they do, and the paste box is the
only path.

**What is allowed:** a local job on the owner's own machine, `jobops-local/read_alumni.py`,
that attaches to the Chrome they are already signed into and READS search result
pages.

**Every limit, enforced in code and asserted in `test_reader.py`:**

- **Real Chrome, the owner's Default profile, over the remote debugging port.** Never
  headless, never a fresh profile, never a second account. It calls
  `connect_over_cdp` and there is no `launch(` anywhere in the file.
- **Read only.** No path clicks a profile, connects, messages or follows. The
  test scans the source with comments stripped and fails on any of `.click(`,
  `.press(`, `.fill(`, `.hover(` and the rest, and on any selector containing
  connect, message, follow, invite or `artdeco-button`. A button that is never
  located cannot be pressed.
- **3 searches a day for the first 14 days, then 5.** 20 results each, page 1
  only. There is no pagination and there is not going to be one.
- **Only while the owner is at the machine** — input inside the last 30 minutes — and
  only between 13:00 and 18:00. Unreadable idle time SKIPS rather than
  proceeding.
- **5 to 30 seconds between every action**, randomised.
- **Halts for the day** on any captcha, checkpoint, "unusual activity" or login
  page, judged on page CONTENT rather than status code. Red in the digest. It
  never retries.
- **`jobops-local/PAUSE`** stops every run while the file exists.
- **Two halts in 14 days and it disables itself**, and the paste box becomes the
  only path until the owner re-enables it by hand.
- **No token, no run.** Reading with nowhere to put the result is pure risk for
  no gain.
- **Zero results across every search is RED**, not "nothing new" — the
  always-empty-source failure, which this project has already hit three times.

**Still forbidden, and not made less so by the above:** connecting, messaging,
following, viewing profiles, scraping anything but search results, running
headless, running in Actions or on any machine that is not the owner's, running
while they are away, a second account, and any of it without the limits above.

**Two limits had to be made testable before they were real.** `gate()` takes
`now_hour` and `idle` as parameters because `idle_seconds()` reads live OS
input — and the mutation audit proved the point: with the idle branch deleted
outright, every assertion stayed green, because none of them ever reached it.
**A limit no test can drive is a limit nobody knows works.** 11/11 mutations
caught now, including adding a click, launching headless, raising either cap,
disabling the PAUSE file, and ignoring a captcha.

### Clearance and citizenship phrasing

A hard constraint on wording, in every resume, cover note, outreach draft, form answer, and
interview-prep answer the tool ever produces. `profile.json` carries the canonical strings in its
`citizenship` and `clearance` fields — use those, and do not paraphrase them upward.

**You MAY state:** whatever `profile.json` says about citizenship and sponsorship; that the owner
holds no current or prior clearance (if that is what it says); that they know of no disqualifying
factors; that they are willing to undergo the process.

**You may NEVER write or imply:** that the owner is "cleared," that they hold "an active
clearance," that they are "clearance-eligible" or "eligible for TS/SCI" as though that were a
settled determination, or any equivalent phrasing that reads as an adjudicated result.

**Why:** clearance eligibility is decided by a government adjudicator, not by the candidate. Asserting
it is a false claim on a defense application — the highest-stakes place in this pipeline to get wrong.
"No known disqualifying factors, willing to undergo the process" says everything true without
claiming a determination nobody has made. Do not let this drift, and do not soften it because a
posting's phrasing invites it. `web/lib/clearance.js` enforces it on generated prose; see the
forbidden-claim guard note below for the half it must also permit.

### profile.json may hold evidence that is not on the resume

`profile.json` legitimately contains accurate evidence that `resume_tech.md` and `resume_finance.md`
do not — its job is broader: it feeds scoring, pack writing, and conversation prep, not just the
one-page document. Real work can be true, relevant, and still not worth resume space.

Such items live in a `not_on_resume` array on their parent evidence item. **When the pack writer
or any prep output surfaces one, it must flag it as "not currently on resume — add it if you use
this angle."** Never let one appear silently in a talking point.

**Why:** the owner must never walk into an interview referencing a bullet the interviewer cannot
see on the page in front of them. Either it goes on the resume or it stays out of the conversation.

### Board discovery: validate shape, never status codes

`discover` and `probe_board` check the *shape* of an ATS response, not its HTTP status.
**Ashby returns HTTP 200 with a JS shell for any slug whatsoever** — a 200 from Ashby proves
nothing. Greenhouse and Lever 404 correctly, but Lever's 404 body is ~297 KB, so response size is
also useless. Two further rules learned the hard way:

- **Never stop at the first hit.** Try every ATS and report all of them. A false Greenhouse match on
  slug `shield` (an unrelated public *demo* board) short-circuited the search and hid Shield AI's
  real Lever board.
- **A board with exactly one role is suspect**, not a find. That signature caught the `shield` demo
  board and a live "Test Role 8.24" posting at Castelion.

When two boards answer for one company, use the one the company's own careers page links to.
Adding both double-counts every role — see the Shield AI note in `companies.yaml`.

### Title filtering

Matching is **word-boundary**, never bare substring. Bare substrings silently over-excluded:
`intern` killed every *International* role, `iv` killed *Activity* and *Drive*, and `lead` killed
*Leadership* — which defeated the `leadership development` include term entirely.

`title_ok()` evaluates five lists from `companies.yaml` in order: `title_exclude` (hard-no function)
→ `title_senior` (too senior, unless `title_protect` exempts it) → `title_level` (explicit
early-career signal passes outright) → `title_include` (topic match). Unleveled titles fall through
to the topic check, because many good startup roles carry no level signal at all.

Two constraints that will look like bugs if you don't know why:

- **Bare `engineer` is deliberately not a topic term.** It matched ~700 staff-level hardware roles at
  Anduril alone. Topic match is not fit. An owner targeting engineering roles adds it back
  knowingly, at setup, and re-reads the funnel.
- **`title_protect` exists for "Chief of Staff"**, a tier-1 target that contains `staff` — otherwise a
  reliable seniority signal. Do not add bare `chief` or bare `manager` to `title_senior`; they would
  kill "Chief of Staff" and "Product Manager" respectively.

Any change here must keep `python test_filters.py` green.

### Scoring is one deterministic gate and one model pass. There is no LLM triage stage

The pipeline is **gate → score**:

1. **Gate** — `score_jobs.py gate`, deterministic, free. `classify.py` reads title, location and
   description per bullet and per line, and `gate_verdict()` kills a role only on things it can
   prove from the text: a clearance required at hire, a level or class year that is not the
   owner's, a seniority threshold relative to the company's own board. The verdict is stored in
   `jobs.triage` (1 = pass, 0 = kill, NULL = not yet gated) with the reason in `triage_reason`
   and the matched phrase in `gate_text` / `gate_field`. A `source: manual` row gets no verdict at
   all. **The column is named `triage` for history, not because a model writes it.**
2. **Score** — `score_jobs.py score`, Haiku on the Batch API, one sample per role by default, only
   on gate survivors that are reachable (program or entry level, right class year, no clearance at
   hire). Full assessment against `profile.json`; raw scores, one model.

**There was an LLM triage stage between them, and it was deleted.** It bought roughly a dollar a
month and cost correctness: it killed Palantir's *Forward Deployed Software Engineer, New Grad —
US Government*, close to the most on-target posting in the corpus, while reporting a healthy-looking
20% survival rate. `triage_history` still holds its verdicts by `prompt_version`. Do not
reintroduce it; a wrong call at the scorer is a low score at the bottom of a list, and a wrong
call at a triage stage is a deletion nobody sees.

Print the funnel (`total open → title filter → gate → reachable → scored → 60+`) after every run.
Where roles die is the signal for what to tune next.

## COST — HARD CONSTRAINTS, READ FIRST

$26 went out over the first two days of building the original. From here this runs on
pennies a day or it does not run. These are constraints, not preferences. Hit them before
anything else.

**1. HARD CAP: `cost.monthly_cap` in `config.yaml`.** It is the ONLY definition — the
scorer reads it from there and the web meter bakes it from there. If a planned operation
would push past it, **do not run it. Say so and stop.** Check with
`python score_jobs.py cost` first; `score --dry-run` prints the real role and request
counts and the cost from the same selection the run would use, and stops before sending.

**2. Ask before anything over $1.** Print the estimate and *wait for a yes*. **A
threshold the owner gave earlier does not carry forward** — a bar set for one run, in
that context, expired with it.

**3. Never re-score the full corpus again.** It is scored. New roles get scored as they
arrive (~10–30/day). Any prompt or profile change is validated on a **50-role sample**;
if the sample shows it matters, apply it **to new roles going forward, not
retroactively**. A 3× high-effort re-run of the original corpus cost $13.46 and moved the
distribution by 2 points.

**ONE MODEL SCORES EVERYTHING. NO EXCEPTIONS.** Never let two models score
overlapping populations. If the scoring model changes, **everything re-scores or
nothing does** — a partial migration leaves two incomparable scales in one table.

This is not hypothetical. 204 roles were scored on Haiku while 500 stayed on
Sonnet, and the resulting mess took two attempts to clean up. Percentile-within-
model looked like the fix and was worse: it is only valid when both models scored
the same *population*, and they hadn't, so a raw 54 outranked a raw 82. **The
percentile machinery has been DELETED. Ranking is on raw scores, and `score`
refuses outright if the scores table already holds a different model.** Do not
reintroduce percentiles. Resolved by putting all 704 on Haiku for $1.59.

Corollary: **`collect` must take the model from the batch record**, not from the
process default. Collect runs in its own process, where `MODEL` reverts to the
module default — that silently stored 500 Haiku responses as Sonnet. The
`batches` table is the authority on which model produced a response.

**4. Haiku is the default scorer, enforced in code** (`MODEL = os.environ.get("JOBOPS_MODEL",
"claude-haiku-4-5-20251001")`). Validated against Sonnet over 50 roles scored by both:
Spearman **+0.82** overall, **+0.68** across the top 20, and **9/10 top-10 set overlap**.
The ordering holds.

**But Haiku scores ~14 points HIGHER than Sonnet on the same role** (median paired
difference; spread −26 to +34). The scales are NOT interchangeable, which is the
whole reason for the one-model rule above. Never compare raw scores across models,
and never put two models in one table expecting to normalise later — that is the
percentile mistake.

Also: **Haiku rejects `output_config.effort`** outright and errors the whole batch,
and it honours "respond with ONLY JSON" about half the time — `_parse_score` pulls
the first balanced `{...}` block out, which took parsing from 27/50 to 50/50.

**5. Batch API always. Never synchronous.** Synchronous is double the price for the
same result. The one exception is the read-only Ask box, priced and capped below.

**6. Spend is visible.** `score_jobs.py cost` and the UI header both show month-to-date
against the cap. If the owner cannot see it, they cannot control it.

Measured spend by stage on the original corpus: **score $18.90, triage $0.62** (the
deleted stage). Scoring is the entire cost of this system. Everything else — fetching,
gating, the UI, the tracker, outreach drafting — is free.

### Every wait loop needs a deadline and a liveness check

A wait loop must terminate on **three** conditions, not one: success, timeout, and
**the child process dying**. Waiting on an output file alone spins forever when the
producer is gone.

```bash
# WRONG — spun for 4h21m after the fetch it was watching had been killed
until [ $(grep -c '^  \[' /tmp/fetch.log) -ge 30 ]; do sleep 5; done

# RIGHT — success, liveness, and a deadline
deadline=$(( $(date +%s) + 900 ))
until grep -q '^Done\.' /tmp/fetch.log; do
  kill -0 "$PID" 2>/dev/null || { echo "producer died"; break; }
  [ "$(date +%s)" -lt "$deadline" ] || { echo "timed out"; break; }
  sleep 5
done
```

**Why:** a background loop watching `/tmp/fetch3.log` for 30 board lines kept polling
after the python process it was waiting on had been force-killed during an unrelated
debugging step. The log held exactly one line the entire time. Nothing failed loudly;
it just never finished.

Prefer `Bash(run_in_background)` with a command that **exits on its own** over a
`Monitor` with an unbounded condition, and never write a bare `until` on a file that
another process is supposed to be writing.

### Never delete before the replacement is confirmed

**Write new data alongside the old, verify it, then remove the old.** Never clear
existing rows in order to regenerate them.

**Why:** 204 score rows were deleted to queue them for re-scoring, and the batch then
failed on an out-of-credits error. Those roles sat with no score until credits were
topped up. It was recoverable — the jobs survived and re-scoring cost $2.50 — but the
identical pattern in the pack writer or a Postgres migration would not be.

Applies to every destructive operation: DROP, DELETE, overwriting a file, `--reset`,
force-push. If the replacement comes from a network call, an API, or a model, assume
it can fail *after* you have already destroyed the original.

### Never manufacture a connection

Outreach drafts may state only what is literally true about the relationship. This is
the same rule as "never invent resume content", on a different surface — and it
matters more here, because a real person reads it.

**Allowed:** a shared institution stated plainly ("we both went to the same school"),
a role or company fact taken from the public posting, something the owner has genuinely
read or used and can discuss.

**Never:** implied familiarity with their work, "I've been following your work on X"
unless the owner actually has, invented shared experiences, flattery, warmth that has no
basis, or any reference to a talk/post/paper the owner has not read. If the only link is
that both attended the same school, the draft says exactly that and nothing more.

**The ask must be small, specific, and answerable.** "Would you have 15 minutes in the
next couple of weeks to tell me what the deployment strategist work is actually like
day to day?" gets replies. "I'd love to connect and learn more about opportunities"
does not. Bias every draft toward a concrete, low-cost, answerable question.

**Cadence stops at two.** Day 5, day 12, then done — never a third. Two unanswered
messages is an answer; keeping the relationship intact for a future warm intro is
worth more than persistence.

### LinkedIn school `/people/` pages ignore `?keywords=` — do not rebuild that link

Found by the owner clicking, 2026-09-03. Three URLs of the form
`linkedin.com/school/<slug>/people/?keywords=<company>` all loaded successfully —
**no 404, so a fetch or a status check would never have caught it** — and every one
landed on the same unfiltered page of 51,107 alumni with an empty search box. The
page's alumni filter runs on the client after load; no query parameter drives it.
LinkedIn also redirected the hyphenated form of the school's slug to the
concatenated one, so a hand-built school URL may not even be the one that loads.

What the Companies page links to instead, per company row:

- **a plain LinkedIn people search** for the words `<school search term> <company>` —
  `schoolPeopleSearchUrl()` in `web/lib/constants.js`, with the term from
  `profile.json` `owner.school_search_terms[0]`. **This is the workaround, and it
  works**: verified 2026-09-03 by clicking one, 6 of 7 first-page results were genuine
  alumni of the school currently at that company. It is a **keyword match, not an
  alumni filter**, and the label says so — some results are not alumni, or not at that
  company. Never relabel it as a filter;
- **the school's alumni page itself, labelled unfiltered.** It is what it is: every
  alumnus, filtered by hand once open. Never label it as company-scoped.

`SCHOOL_LINKEDIN_ALUMNI` (the school-wide "Find N names" link, from
`owner.school_linkedin_alumni_url`) uses the same `?keywords=` shape and was verified
*filtered* on 2026-08-31 for one school page and unfiltered for another. Either LinkedIn
changed in between or school pages differ; nothing in the repo may fetch either to find
out. If that link ever lands unfiltered, this is why, and the people search is the swap.

**The general rule is the one from board discovery:** a page that loads is not a
page that worked. Verify a generated link by what it *shows*, by a human click, and
say in the label exactly what the page is.

### Fail open, always

**An ambiguous or unparseable verdict passes the role through to the next stage. Never discard
it.** When there was an LLM triage stage, a response that failed `json.loads` was treated as
plausible and marked as such in `triage_reason`; the deterministic gate that replaced it kills
only on things it can prove from the text, and anything it cannot classify goes to the scorer.

**Why:** the two errors are not symmetric. Passing a junk verdict through costs a fraction of a cent
at the next stage. Dropping it silently deletes a real opportunity the owner will never know existed, and
leaves no trace to notice later. **Never invert this tradeoff for cost reasons** — the cost side is
rounding error and the loss side is unrecoverable. The same rule applies to any future stage that
classifies, filters, or ranks.

### Deadlines are the expensive thing to get wrong

`companies.yaml` once carried the note *"MBB full-time window typically closes
mid/late September."* McKinsey's 2027 window actually ran **2026-07-01 to 2026-08-11**.
Acting on that note would have cost an entire recruiting cycle, and nothing else in
this system fails that expensively.

Rules that follow from it:

- **Every date carries a `confidence`**: `verified` (read from the firm's own site),
  `secondary-source` (2+ independent trackers agree), `historical-estimate` (inferred
  from prior years). The UI shows the label on every row. As of 2026-08-24 only
  **1 of 15** is `verified` — the rest are prompts to check, not facts.
- **Every date carries `verified:` and goes stale after 14 days.** Run
  `python verify_deadlines.py` to get the worklist.
- **`verify_deadlines.py` deliberately does not scrape.** These are JS careers sites
  behind custom ATSs; a scraper would produce confident-looking wrong dates, which is
  the exact failure being guarded against. It reports what is stale, unconfirmed, or
  closing soon, and whether source URLs still resolve. A human closes the loop.
- **Consulting, VC, and the primes' rotational programmes are structurally invisible
  to the fetcher** and always will be. Do not try to fix that with more slugs. They
  live in `deadlines:` and surface as the landing panel, never buried in a list.

### Don't ship an analysis the data can't support

The 2027 posting forecast looked ready and wasn't. `first_seen` spans **two days**,
so it carries no signal; Lever reports requisition *creation* (Palantir's evergreen
reqs date to 2017); Greenhouse reports *last edit*. Only Ashby and Rippling give a
real publish date.

The forecast now labels provenance per row, excludes anything older than 18 months as
an evergreen artifact, and says plainly on the page that it needs a season of cron
runs before it means anything. **Prefer a visibly weak answer to a confident wrong
one** — that is the same failure as the McKinsey note, in a different costume.

### The interface is first-class, not a later nicety

The owner will not use a terminal day to day. **Anything built from here forward gets a UI surface in the
same session it gets a script.** A feature that exists only as a CLI command is not finished.

`web/` is a Next.js app reading Neon Postgres through one thin data layer (`web/lib/db.js`,
with `node:sqlite` as the `JOBOPS_LOCAL_DB=1` offline fallback — no native module). The app
reads, and writes **stage, notes, items, actions and contacts only** — it must never call the
Anthropic API **for scoring or for anything that writes**. Scoring stays in the Python scripts,
which remain the backend and run on cron.

**The one exception, and it is the only one: the read-only Ask box, capped at 30 questions a
month.** It answers questions about the owner's own data and can do nothing else — see
`web/lib/ask.js`. The rule above exists so that spend belongs to cron-run Python where it is
predictable, and a hard cap of 30 satisfies that reason rather than dodging it: worst case
well under a dollar a month, and the footer meter shows it alongside everything else.

Four things make it an exception rather than a hole, and `test_ask_isolation.py` fails on any of
them — each proved to fail by mutating the source:

- **`JOBOPS_ANTHROPIC_KEY`, read in exactly one file, with no fallback of any kind.** It must never
  read `ANTHROPIC_API_KEY`, not even as a last resort — that key belongs to the pipeline and could
  one day belong to a different account. Unset, the box renders disabled and names the variable.
- **`api.anthropic.com` appears in exactly one file.** A second endpoint added later cannot bypass
  the cap by calling the API itself, which is exactly the thing that gets added without anyone
  thinking about a counter.
- **The cap is read and compared before the request is sent**, and the counter is a `COUNT(*)` over
  `ask_queries` for the calendar month, never a stored integer that can desync.
- **One writable table, `ask_queries`, written from one module**, and the route imports only read
  functions from shared modules.

It is also **synchronous, which breaks "Batch API always"** — an interactive question cannot wait
minutes for a batch. That doubles the per-token price and costs about 17c/month at the cap.
Priced, stated, accepted.

**Company view is the primary landing view, not Inbox.** For a student with a dated graduation,
every role open today will be filled long before they can start. The inbox's real job is telling
the owner *which companies hire their profile into roles they want* — that is intelligence for
relationship-building. Actual applications happen when the new-grad programs for their class
year open, and most are not posted until then.

### Adaptive thinking counts against max_tokens

Sonnet 5 and Opus 5 run adaptive thinking by default, and **thinking tokens consume `max_tokens`**.
At `max_tokens=900` the scorer's JSON was truncated on 149 of 704 responses (21%) — median 685
characters, some responses empty because thinking used the entire budget. It fails as a JSON parse
error, not as an API error, so it looks like a prompt problem.

Budget generously (3000+ for structured output) and control depth with `output_config.effort`
instead. **It bit again in the pack writer**, which generates far longer output than a score object —
see the `max_tokens` note below.

### Scores are ordinal, not cardinal

Re-scoring the same three roles produced 74→62→68, 68→68→78, 68→72→78. **Run-to-run variance is
roughly ±10 points, and `effort` shifts the whole scale** — `effort: low` suppressed the top of the
distribution enough to make it look like a hard 74 ceiling when the scorer can reach 78+.

Read scores as a ranking, not a measurement. Never treat a 4-point gap as meaningful, and re-score
the full set rather than comparing runs made at different effort levels.

### Judgment vs. reading: which classifier changes are allowed

"Display rules only, don't retune the classifier" means **don't change how a role is
judged**. It does **not** mean leaving a pattern that cannot read input it should.

- **Not allowed:** moving a threshold, reweighting a signal, or adjusting a rule because
  the resulting list looks better. That is chasing scores.
- **Required:** fixing a pattern that is structurally blind to input it was written to
  read. That is a bug, and it is invisible until someone reads the output by hand.

Three real instances, all the same shape:

- Every clearance pattern was sentence-shaped and wanted "active" or "current" beside
  "clearance". Titles write it as a tag, so `(TS/SCI Clearance Required)` read as
  `none_mentioned` and sat in the inbox. Defense boards put it in the title precisely so
  nobody wastes an application.
- The same patterns used `[^.]{0,40}` to stay inside one sentence, and **"U.S." contains
  periods**, so "an active U.S. government security clearance is required" matched
  nothing. A sentence boundary is a period followed by whitespace *not preceded by a
  capital letter*; anything stricter breaks on every abbreviation in defense prose.
- `_CLR_ELIGIBLE` had `eligibilit[a-z]* (for|to)`, which matches "eligibility for" but
  not **"eligible for"** — a different stem. Applied Intuition writes "Must hold or be
  eligible for a U.S. Secret security clearance" on an entry-level role, and it was one
  commit away from being deleted as clearance-required.

**Whenever a classifier reads prose, ask what it does with a title, an abbreviation, a
bullet list, and a line break.** Those four break more patterns here than anything else.
And check both directions: the eligible/required fix looked like a win until the diff
showed it had started deleting a tier-1 target.

**Any such fix must be diffed over the whole corpus before it is accepted** — print every
row whose classification changed, in both directions, and read them. The first version of
the sentence-boundary fix silently reclassified eleven Scale AI roles the wrong way
because it stopped crossing newlines, and the count alone looked fine.

### Every classifier change gets a full-corpus diff, read by hand, before commit

**Any change to a classifier or a detection pattern requires a before/after diff over the
whole corpus, with every reclassified row listed and hand-checked, before it is committed.**
Not a count. Not a sample. The rows, in both directions, read.

A rate tells you how much moved and never what. Twice in one session a change that looked
correct was one commit from deleting a tier-1 target, and the corpus diff is what caught
it both times:

- The **first triage prompt** scored a perfectly reasonable-looking 20% survival rate while
  killing *"Forward Deployed Software Engineer, New Grad — US Government"* at Palantir,
  close to the most on-target posting in the corpus. The headline number looked fine.
- The **clearance sentence-boundary fix** started reading "Must hold **or be eligible for**
  a U.S. Secret security clearance" as a hard requirement, which would have deleted Applied
  Intuition's entry-level *Software Engineer - Defense Physical AI*. `eligibilit[a-z]*`
  matches "eligibility for" but not "eligible for" — a different stem.

Check **both directions every time**. The same fix's first attempt silently lost eleven
Scale AI roles by refusing to cross a newline, and those roles state the requirement in a
bullet list. Gains are easy to notice; losses are invisible unless you look for them.

The diff is cheap — one query joining old and new verdicts — and the loss it prevents is
unrecoverable, because a deleted role is one the owner never learns existed.

### What personal data is in this repo, and what is deliberately not

The repo is **private on GitHub** and contains the owner's own personal data on purpose.
The line is **whose** data it is, not how sensitive it looks.

**In the repo, deliberately** — `profile.json`, `resume_tech.md`, `resume_finance.md`,
the two resume PDFs in `web/public/resume/`, `daily.yaml`. The owner's name, GPA,
employers, education. The reasoning, on the record: *these are things the owner would
hand a recruiter anyway, and the repo is useless without them.*

**Never in the repo** — `contacts.csv` and `outreach/` hold **other people's** names,
roles and contact details, entered by hand from the school's alumni directory. Also out:
`.env`, `jobs.db` and any other database, `voice/`, `logs/`.

**Contacts and outreach live in POSTGRES**, and that is what finally made them work.
`contacts.csv` and `outreach/` were gitignored because of whose information they hold — so
they could never exist on Vercel, and the deployed app could never show a single contact.
The highest-leverage feature in the tool was structurally unable to run: Daily's
"Follow-ups owed" was permanently empty, the ladder's networking tier read an always-empty
source, and Companies' "Start here" queue existed to feed something with nowhere to put its
output. The tables had been created by the initial migration and sat unused for weeks.

`python contacts.py import-csv` moves an existing CSV in once, and **skips loudly when the
file is absent or has no rows** rather than reporting a successful import of nothing.

**The paths stay on the deny list even though nothing writes them any more.** A file that is
no longer produced is not a file that is safe to commit — the old one still has names in it.

**Do not "helpfully" start tracking contacts.csv or outreach/.**

`python test_nothing_private_staged.py` fails if any of those are staged or tracked,
and the pre-commit hook runs it. It also fails if more than one `*.db` exists in the
tree — a stray empty `web/jobs.db` sat there for a day from a path mistake, which is
how you end up reading stale data without knowing.

**A deny list enumerates files; the risk is a CATEGORY.** A debug script wrote
`web/daily.html` — the entire signed-in Daily page — into the repo, and it was staged
before anyone noticed, because a page dump was not on the list. So the test now also
fails on **any `.html` in the tree** (nothing here is authored as a static page; the app
renders through Next.js, so an .html file is something a script left behind) and on any
staged file whose **content** carries an address, a signed session cookie, a
connection string with credentials in it, or an API key. Both were proved to fail
before being trusted.

**Match the VALUE, never the label.** The first version looked for the bare
strings `jobops_session=` and `postgresql://`, and immediately failed on
CLAUDE.md, HOSTING.md and on the test file itself — every one of which discusses
the shape of a secret without holding one. A check that fires on its own
documentation is a check you learn to skip, which is the same failure as a nag
you cannot answer. The patterns now require the token that follows.

.gitignore alone is not enough: `git add -f` overrides it silently, and a file that is
already tracked stays tracked no matter what .gitignore says afterwards.

### A rendered-output diff verifies reads only. Every write needs a manual exercise

The SQLite → Postgres snapshot diff came back **IDENTICAL across 911 rows** — and "Add an
item" was completely broken, because `INSERT OR IGNORE` is SQLite-only. The diff compares
**rendered pages**; a write leaves no trace in one until it succeeds. **No amount of
diffing could have found it.** Only clicking the button did.

So a migration is not done until every write path has been exercised by hand. The list,
from the pass that found it:

**Web** — check off an on-you item · add an item · save a role · hide a role · mark applied
(and confirm the follow-up item appears) · star a company · expand a row and change its
stage.

**CLI** — `fetch_jobs.py fetch` (insert and update jobs, set `closed_at`) ·
`score_jobs.py gate` (classification columns) · `score_jobs.py score` (scores, score_runs,
batches) · `seed_items.py` · `contacts.py` · `outreach.py`.

Confirm the row actually lands, not merely that the command exited 0. **A CLI that
silently fails to write is worse than one that errors**, because the cron will do it
unattended every morning and the freshness stamp will keep saying it ran.

### In a migration diff, "harmless artifact of the new system" usually means "bug in the old one"

The SQLite → Postgres diff came back with **seventeen identical companies in a different
order**. That is the most explainable-away symptom imaginable: same rows, same values, just
a different sequence, obviously because two databases return group rows differently.

It was a real defect that predated the migration. `listCompanies` sorted on `best` then
`at40`, and every company in "Watching" ties on both — so the order was whatever the
database handed back, and **the page could reshuffle on any fetch**. The migration did not
cause it; it revealed it.

**Treat every difference as a defect until you have found its cause**, especially the ones
that look like noise. A difference you can explain in one sentence without looking at the
code has not been explained.

### SQLite's permissive GROUP BY hides wrong answers

`SELECT j.company, a.stage ... GROUP BY j.company` runs happily in SQLite and picks an
**arbitrary** row for `a.stage`. Postgres refuses it outright. That query had been
returning an arbitrary application stage for any company with two applications at
different stages — a wrong answer with no symptom at all.

Audited every `GROUP BY` in `db.js` afterwards: that was the only one. All the rest either
group every selected column or wrap it in `MAX`/`MIN`/`COUNT`/`SUM`, and every one of them
has now executed against Postgres, so anything non-conforming would already have thrown.

**Postgres is the stricter reader and worth keeping as the one that runs.** The value is
not portability, it is that a class of silent wrong answer becomes a loud error.

### Never disable certificate verification to make a connection work

`ssl: { rejectUnauthorized: false }` was written into the first Neon connection check
purely to get it working, and it would have sat there **silently downgrading TLS on
every connection forever**. Neon presents a perfectly valid certificate; nothing was
wrong. The flag was cargo-cult.

**If a certificate fails, find out why.** Expired, wrong hostname, a corporate proxy
intercepting — each has a real fix. Turning verification off is not one of them, and it
is invisible afterwards: everything works, so nobody ever looks again.

Same rule for `verify=False` in `requests`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, and
`sslmode=disable` in a connection string.

### The database is the source of truth for the schema

There is no hand-maintained schema file. `schema.sql` used to be one and it drifted
**twenty columns** behind reality — which made it worse than nothing, because it still
looked authoritative. Building the Postgres migration from it would have silently
dropped every one of those columns.

`migrations/001_initial.sql` is generated from the live SQLite schema, and
`python test_schema_parity.py` fails when the two diverge. Add a column to `jobs` in
`fetch_jobs.db()` and that test tells you the migration needs it too, in the same commit
rather than three weeks later during a data copy.

### Windows text handling has broken this project four times

Four separate bugs, one root cause: **Windows defaults differ from the defaults every
parser here assumes**, and each failure was silent.

1. **cp1252 on output.** Printing a posting containing an en dash raised
   `UnicodeEncodeError: 'charmap' codec can't encode` and killed a validation script
   mid-run. Console output is cp1252, not UTF-8. **Fixed durably 2026-08-25** —
   see the `utf8_stdout()` rule below.
2. **Backslashes through heredocs.** Regexes edited via a shell heredoc had `\b`
   collapse into a literal backspace byte, so the pattern matched nothing and every
   management title was classified entry level.
3. **CRLF line endings.** A script rewrote `companies.yaml` in Python text mode, Windows
   turned every `\n` into `\r\n`, and `lib/deadlines.js` splits on `"\n"` — so every line
   kept a trailing `\r`, every regex matched nothing, and `/about` reported
   "0 windows tracked". Nothing errored; the build was green.
4. **A scripted multi-file edit through a heredoc.** Fixing bug 1 across nine CLIs at
   once, the insertion wrote a literal `0x01` byte into eight of them and landed inside
   two parenthesized multi-line imports. Nine files, one command, none of them parsing.

All four look like data problems and are not.

**Rules that follow:**

- **Every Python write of a file another tool parses passes both:**
  `io.open(path, "w", encoding="utf-8", newline="\n")`. Never bare `open(path, "w")` —
  it inherits the locale encoding AND translates newlines.
- **Every CLI calls `utf8_stdout()` from `console.py` as the first line of `main()`.**
  `-X utf8` was the old rule and it does not work: it depends on whoever types the
  command remembering it, and neither the owner nor cron does. The fix has to live inside
  the script. `test_console_encoding.py` fails if any CLI is missing it, and separately
  proves the crash is real by running an unwrapped child under `PYTHONIOENCODING=cp1252`.

  The mild form of this bug is mojibake — an em dash stored as the single byte `0x97`,
  which looks right in a cp1252 console and turns into a replacement character in a
  file, a pipe, or a UTF-8 terminal. The severe form is `UnicodeEncodeError` on a
  character cp1252 cannot represent at all, and **nothing in the source triggers it —
  only the data does**: a contact named with the Polish barred L, a posting titled with
  a CJK office name, an arrow in a scraped description. It raises at the `print`, after
  the work already succeeded, so it reads as a bug in whatever built the string. Grep
  finds nothing, because the character is not in the repo. That is why it is a test and
  not a convention.
- **Never edit code through a shell heredoc when the replacement text contains a
  backslash.** Not only regexes — this cost real time again on 2026-08-25. An insertion
  whose replacement held a `\1` group reference wrote a literal `0x01` byte into eight
  files at once, and a generated `"C:\Windows"` literal became an invalid `\W` escape.
  Both produce files that look correct in a diff and fail at import. Use the editing
  tools for anything containing a backslash.
- **Hand-written parsers split on `/\r?\n/`, never `"\n"`.** This repo has several
  (deadlines, manual items, company notes) and they are exactly the code that assumes
  one line ending.

`python test_line_endings.py` fails if any tracked text file contains CRLF, and the
pre-commit hook runs it. It caught twelve files on the first run.
`python test_console_encoding.py` covers the encoding half.

**A fourth rule, learned the same day:** when a scripted edit touches more than one or
two files, **parse every file in the same command that made the edit** — `ast.parse` on
each, not a spot check. A regex insertion that assumes each import is one line will land
inside a parenthesized multi-line `from x import (a, b)` and produce a `SyntaxError`
that a diff renders as three innocent-looking lines. Two files broke exactly that way
and were caught only because the whole suite ran afterwards.

### Any user-facing interaction gets a real browser pass before commit

**A passing test and a green build do not tell you what the screen does.** Anything that
changes an interaction — a button, an optimistic write, a row layout — gets opened in a
browser and clicked before it is committed.

The case that set this rule: the optimistic-save rollback was tested by pointing the route
at a forced failure. The button correctly reverted from "Saved" to "Save"… and the error
message was **invisible**, clipped by the width of the actions column. So a failed save
looked exactly like never having clicked — which is the precise lie the rollback path
exists to prevent. Every test passed. The build was green. The API returned a correct 500.
Only clicking it showed the bug.

The same pass caught "Excellent" rendering as "Excellen" and colliding with the company
name, because the fit column was still sized for a two-digit number.

What that pass looks like: build, serve on the verification port, drive it with the
`claude-in-chrome` tools, and **zoom in on the thing you changed**. Screenshot after the
network call resolves, not before — an early screenshot showed no error and was briefly
mistaken for the bug still being present.

### The suite is two gates, and three checks have never run at all

**Fast gate, `git commit`, ~2 min** — python tests, the two generators, the js
tests, and the Ask cap. Everything pure, plus the two that need only a database.

**Slow gate, `git push`, ~3 min** — `next build`, the 1280px overflow sweep,
/resumes, controls-are-named, tour targets.

`.githooks/pre-commit` runs the fast gate and `.githooks/pre-push` the slow one once
`git config core.hooksPath .githooks` is set; `precommit.ps1` (Windows) and
`daily_run.sh` show the same sequence by hand.

**Why push and not commit.** Measured 2026-09-03: overflow 100s, build 36s, tour
28s, controls 23s — 188s of a 5m34s suite, 56%, is the browser stages and the
build that exists only to serve them. A gate that long gets run with
`--no-verify`, and then it is not a gate. A local commit is amendable and
reaches nobody; **a push is what Vercel deploys from**, so the gate proving the
app builds and renders sits where the consequence is. The accepted cost is that
a commit can land on a broken build — it cannot reach anyone until push.

**`test_overflow.mjs` stays whole at 100s.** It is the only thing catching that
class of layout bug — the 331-character location string that put a scrollbar on
the page, the note that overlapped the pay column. Optimising a guard for speed
is how guards stop guarding.

#### THREE CHECKS HAVE NEVER RUN ON THIS MACHINE

They are gated on `JOBOPS_LOCAL_DB=1`, which **is not in `.env`** — deliberately,
because each writes, and doing that against Neon on every commit would put fake
rows through production. The consequence is that they have never executed here,
and this is exactly what that leaves uncovered:

- **`web/test_writes.mjs`** — every write path clicked for real: check off an
  on-you item, add an item, save a role, hide a role, mark applied and see the
  follow-up appear, star a company, expand a row and change its stage. This is
  the test that would have caught `INSERT OR IGNORE` being SQLite-only, which a
  911-row rendered-output diff could not: **a write leaves no trace in a diff
  until it succeeds.**
- **`audit_mutation.mjs`** — the mutation audit. It breaks each hard rule on
  purpose and requires the test guarding it to go red, then restores and
  requires green. **Nothing else in the suite can tell you an assertion is
  LIVE** — the clearance one passed for weeks while matching nothing at all.
- **`web/test_flags.mjs`** — the wrong-cycle flag reaching every list, so a role
  hidden on Daily is not still visible on Inbox.

**To run them:** `JOBOPS_LOCAL_DB=1` in the environment, then both gates, against the
local SQLite database rather than Neon. Worth doing after touching any write
path, any hard-rule guard, or the hide/flag wiring. Until then, treat those
three areas as verified by hand at the time they were built and not since.

### "Renders locally" is not "renders in production" on this project

**The production hostname can serve a build that is not HEAD, and has.** On
2026-09-04 a page showed none of its new work in the owner's browser after a
hard refresh, while every layer checked out:

- the commit was live — the dashboard showed it Ready in Production;
- the rows were in Neon — every record the page should have rendered, and its
  settings row;
- it was the SAME database, proven rather than assumed: `visits` had a row
  written by the deployed app 39 minutes earlier;
- the page is `force-dynamic`, so nothing was frozen at build time;
- `SECTIONS` keys matched the `section` values in the table exactly;
- and serving that same build locally against that same Neon returned HTML
  containing every missing item.

Six layers correct and the page still wrong in one browser and right in another.
**So a local render is evidence about the code, and no evidence at all about
what that hostname is serving.** A stale alias or a cached response looks
identical to a bug, and hours can go into the data layer before anyone asks the
question that separates them.

**When a deployed page disagrees with a local one, establish which build the URL
serves BEFORE diagnosing anything else.** The cheap discriminators, in order:
compare the deployment SHA in the Vercel dashboard against HEAD; then render the
same commit locally against the same database, as above. If those two agree and
the browser still disagrees, the fault is in delivery — alias, cache, CDN — and
no amount of reading the data layer will find it.

**Do not assume a Vercel integration can answer this.** The original's was scoped
to a different team: `list_projects` did not list the project and `get_deployment`
404'd on the hostname, with no hint that anything was withheld. Verify deploys in
the Vercel dashboard — read the deployment SHA there, by a human.

### Never commit without reading the build result

A commit went in on a build that had already failed — a JSX comment in an attribute list,
`BUILD=1` right there in the output, unread.

`.githooks/pre-commit` now refuses the commit: python tests, `web/test_display.mjs`, then
`next build`. Enable it once per clone with `git config core.hooksPath .githooks`; run it
by hand with `precommit.ps1` on Windows or by invoking the hook script directly.
It takes a few seconds.

It builds into `.next-precommit`, and a verification server uses `.next-verify`, because
**a `next build` and a running server sharing an output directory leave a half-written
`.next` and every route 500s** with `Cannot find module './51.js'` — which reads as a code
bug and is not one. `NEXT_DIST_DIR` in `web/next.config.mjs` selects the directory;
unset, as on Vercel and `npm run dev`, it stays `.next`.

### If code can decide it, code decides it

**Never hand a model a fact you already have and ask it to do arithmetic or a comparison on it.**
Extract deterministically, decide deterministically, and tell the model the check is already done.

**Why:** the old LLM triage stage extracted the stated years-of-experience requirement with a regex, then asked Haiku
to compare that integer against a cutoff of 3. It killed 2-year roles as "requires 3+ years" on ~5%
of kills — including at Anduril, a primary target. No prompt wording fixes this; a model asked to
compare integers will be wrong some fraction of the time. Moving the comparison into code took that
error class from 6 occurrences to 0 in the same 150-role sample.

This applies to every stage. In the pack writer and the scorer, anything derivable from structured data —
a date, a count, a threshold, a string match on a field you already store — is a code decision. The
model's job is the part that genuinely requires reading and judgment. Prefer shrinking that job.

**Corollary — a prompt framed as "find a reason to kill" will always find one.** When the closed
disqualifier list forbade free-form "specialist domain" kills, the model started fabricating
"manages a team" instead — claiming it of Saronic Mission Operations Specialist postings whose text
reads *"as both an individual contributor and as a part of your team"* — and killing a Jacksonville,
FL role as "outside the US". Closing one door opens another. The durable fix is to remove the
judgment from the model, not to enumerate more rules for it.

### When an upgrade is forced by one advisory, read what else it fixes

**The blocking issue and the dangerous issue are usually different.** A forced
dependency upgrade arrives with a reason attached, and that reason is whatever the
tooling happened to name — not necessarily the thing that would have hurt you.

Vercel refused a deploy over the Next.js CVE list. The build had succeeded and every
route compiled; the refusal named "vulnerable version of Next.js". Next 15.5.4 was
carrying **29 advisories**, and the one that mattered here was not the headline: **four
were middleware bypasses** — segment-prefetch routes, dynamic route parameter injection,
and two incomplete-fix follow-ups. `web/middleware.js` **is** the password gate. The gate
about to be deployed was bypassable, and nothing in the block message said so.

So: when something forces an upgrade, **read the full advisory list against what this
codebase actually uses**. Ask which of them touch code you rely on for correctness or
access control, and verify those specifically rather than trusting that "upgraded" means
"safe". The same applies to a version bump made for any other reason — a routine upgrade
silently fixes things, and you should know which.

Also worth keeping: **take the smallest version that fixes it.** npm named 15.5.24 as the
non-major fix and 16.3.3 as the breaking one. An upgrade whose job is to unblock a deploy
should not also be a framework migration, because if the deploy then fails you cannot tell
which change did it.

### Testing that auth works is not testing that auth cannot be bypassed

**These are different tests and only the second one finds bypasses.** The password gate
was verified end to end — signed out redirects, wrong password refused, correct password
admits, tampered cookie rejected, expired cookie rejected, rate limit fires — and every
one of those exercises `middleware.js`. A bypass is a request that **never reaches
middleware.js at all**, so no amount of testing it can find one.

`web/test_auth_bypass.mjs` is the actual test. It fires the shapes that skip middleware:

- **RSC and prefetch routes** — `?_rsc=`, `RSC:` and `Next-Router-Prefetch:` headers,
  `.rsc` and `.prefetch.rsc` paths. These are how the segment-prefetch advisories worked.
- **`x-middleware-subrequest` spoofing** (CVE-2025-29927) — a forged internal header that
  convinced Next the request had already been through middleware.
- **Path normalisation** — `//`, `/./`, `%2e%2e`, trailing slashes, case variation.
- **Internal endpoints** — `__nextjs_original-stack-frame` and friends, which sometimes sit
  outside the matcher.
- **Server Actions without a session**, since two write paths are Server Actions rather
  than API routes.
- And the inverse: that `/login` and `/api/login` **stay reachable**, so the gate cannot
  lock the owner out of their own sign-in page.

**Run it after any change to `middleware.js`, to the allow-list, or to Next itself**, and
against the deployed URL as well as localhost — it takes a base URL for exactly that.

Two things learned building it, both general:

- **Judge on content, not status codes.** The first version failed `//` and `/inbox/`
  because they answer 308 to the canonical path; following the chain, both land on
  `/login`. A normalisation redirect is not a bypass. The question is never "did it
  redirect" but **"did app content come back without a session"** — so it follows
  redirects and greps the final body for markers that only appear signed in.
- **Prove it can fail.** Adding `"/"` to the middleware allow-list and re-running turned
  six probes red and exited 1. A security test that has only ever passed is indistinguishable
  from one that cannot fail.

### A test that asserts against a point-in-time snapshot asserts the world hasn't moved

**Prefer self-contained invariants to comparisons against captured external data.** A test
built on a snapshot is correct exactly once — on the day it is written — and then decays
without telling you.

`test_storage_policy.py` compared every stored description length against `jobs.db`. That
passed the day it was written and failed on the very next fetch, on 73 rows: 52 differed by
**exactly one character** (a template edit on Applied Intuition's board) and 21 by hundreds
in both directions. Job descriptions change. Treating a frozen pre-migration snapshot as
ground truth turned normal reality into a test failure, and a test that cries wolf on
correct behaviour gets ignored right before it matters.

The replacement needs no external source and is sharper: `store_description` can only ever
truncate **at** `KEEP_FULL_CHARS`, so a keep-full row sitting at exactly that length is the
signature of the bug. Plus the positive half — 1,611 keep-full rows longer than the limit —
so the suite cannot pass on an empty or uniformly-trimmed table.

**Ask of any assertion: what would make this fail while the code is still correct?** If the
answer is "the outside world changed", it is the wrong assertion. Snapshots are for
diffing a change you are making right now, not for asserting in perpetuity.

### Every verification tool needs a self-check that it measured anything at all

**A tool that silently measures nothing reports success.** This has now happened twice in
this project, and both times the output was a confident green.

1. The snapshot tool was **blind to Inbox and Gate** — it looked for section headings, those
   pages have none, and it recorded them as zero-row pages while diffing clean. Fixed with a
   page-wide row count and a guard that throws when a page has 0 rows *and* 0 sections.
2. After the password gate landed, the same tool would have captured **seven copies of the
   login page** and diffed them as IDENTICAL. Every number matched. Nothing was measured.
   It now signs in first, aborts if that fails, and aborts again if any fetched page turns
   out to be the login page.

The shape of the fix is always the same: **the tool asserts its own preconditions and
refuses to write output when they fail.** Not a warning — a non-zero exit and no file, so
a green run cannot be mistaken for a verified one.

Apply it to anything that verifies: **before trusting a passing check, ask what it would
print if it were pointed at nothing.** If the answer is "the same thing", it is not a check.
`backfill_descriptions.py`, `test_storage_policy.py` and `test_auth_bypass.mjs` each carry a
positive assertion for this reason — that rows were examined, that keep-full rows genuinely
exceed the trim length, that `/login` is still reachable — so passing means something was
looked at rather than that nothing was found.

`web/test_overflow.mjs` is the newest of these. It loads every page headless at 1280px and
fails if `scrollWidth > clientWidth`, then puts the 331-character string that caused the bug
back onto a real row and requires the check to go **red** — because a layout test that has
only ever passed is indistinguishable from one that cannot fail. It also aborts, rather than
skipping, if Chrome is missing, if a page came back as the login form, or if a page rendered
under 200 characters. Seven copies of the sign-in page have no horizontal overflow either.

### Schema isolation works for a script, not for a browser test

**Write tests run in a scratch Postgres schema.** `JOBOPS_PG_SCHEMA` puts that
schema — and *only* that schema, with no `public` fallback — on the connection's
search path, the test creates the tables it needs, and cleanup is one
`DROP SCHEMA CASCADE` that cannot miss a table. `web/test_runhistory.mjs` and
`web/test_applied_db.mjs` work this way. The no-fallback part is the design: a
table the test forgot to create must **error**, not quietly resolve to the
production one.

**`web/test_applied_browser.mjs` is a knowing exception and writes to
production.** It was built on the scratch schema first and 500s, because
redirecting the search path points the **whole app** at it and the layout that
wraps every page reads a dozen tables — jobs, actions, batches, deadlines,
contacts — none of which exist there. `parserOpenTable` on the first render.

So the boundary is: a scratch schema fits a **script** under test, whose whole
surface is one or two tables, and cannot fit a **browser** test, which
necessarily drives every query the app makes.

What makes it safe instead:

- every row it creates carries an employer no company can match
  (`ZZ Browser Test Employer`), so it can never be mistaken for a real
  application and can always be found again;
- `applied_imports` rows are removed **by set difference** against the ids that
  existed before the run, not by content. The first version deleted by content
  and left the *successful* import behind, because `raw` is null on a success by
  design — a cleanup that can only find the rows it thought about is the same
  shape as the one that missed `pipeline_status`;
- and the deletion is **asserted**. That is the part the first
  `test_runhistory.mjs` lacked, which is how a fake run ended up in the digest as
  the most recent one.

### A guard must assert on the invocation, never on the code that builds it

**Match the line that DOES the thing.** A guard satisfied by the setup for the thing it
guards is not a guard — it passes on the machinery being present while the machinery goes
unused, which is the exact state it exists to detect.

Three instances now, in three different kinds of check, which is why it is a rule:

- **A test.** `test_ci_scripts.py` required `$STAGES` to appear in the "Record the run"
  step, to stop the workflow silently reverting to the NULL-stages fallback. Deleting the
  argument from the command left the check **green**, because the three lines that *build*
  `$STAGES` still mention it. It reads the one line containing `recordrun.mjs` now.
- **An audit measurement.** The blocker audit compared `.get("blockers")` against a
  `classify()` that returns `tags`, so it read a field nothing writes and reported 28 of 50
  mismatched. The real answer was 50 of 50. It was measuring its own key name.
- **A classifier check.** `test_nothing_private_staged.py` looked for the bare strings
  `jobops_session=` and `postgresql://` and fired on CLAUDE.md, HOSTING.md and itself —
  every one of which *describes* the shape of a secret without holding one. **Match the
  value, never the label**: the patterns require the token that follows.
- **A query and its consumers.** `runCompleted()` reads `stages`; the digest's query
  selected `day, status` only. So every row arrived with `stages` undefined, took the
  no-stages fallback, and the stage checking written that same day was **inert in the one
  place it runs** — with the whole suite green, because **a test that hands rows in
  directly cannot catch an unselected column.** An unselected column and a null column are
  the same value. It was in two files, not one: `test_runhistory.mjs` had the identical
  omission, found only when the first fix made it throw.

  **A query must select every column the functions downstream of it read, and something
  must assert the query against the field set its consumers use.** `test_notify.mjs` greps
  the real `SELECT` out of `notify.mjs` for exactly the fields `runCompleted()` and
  `hoursSinceCompletedRun()` touch.
- **A guard whose condition nothing can reach.** The board-escalation rule exempts
  `empty_run` from being muted — and `boardAnomalies()` attaches `brokenDays` only to the
  three per-board kinds, so the threshold rejected `empty_run` anyway and the exemption
  never decided anything. The mutation that deleted it stayed green, correctly: there was
  nothing there to break.

  **A limit no test can drive is a limit nobody knows works. If a guard's condition cannot
  be reached by any test, either make it drivable or delete it.** Deleting is the honest
  default; keep it only when it is real defence against a change someone will plausibly
  make, and then hand the test the shape that exists *after* that change — here, an
  `empty_run` carrying a streak. This is the same finding as the `read_alumni.py` idle
  branch, which passed every assertion while deleted outright because nothing ever
  reached it.
- **A test that consumes a real quota.** `test_applied_browser.mjs` pastes text that
  parses to nothing, which reaches the model fallback — a real, billed Haiku call, on
  **every push**. At `extract_monthly_cap = 5` the sub-cap would have been gone inside a
  week, and then the test would have started exercising the **capped** path instead of the
  one it was written for, passing all the way through and looking identical doing it.

  **A test must assert the absence of spend, not assume it.** That one runs its server
  with `JOBOPS_ANTHROPIC_KEY` empty so the fallback refuses before building a request —
  the path is still driven end to end and still puts its reason in the banner — and it
  asserts that **no `ask_queries` row appeared between the test starting and finishing**.
  A successful extraction is a different test's job, with a counting fake.

  Generalise past API calls to anything finite the suite touches: a monthly cap, a rate
  limit, a free tier, a trial, rows in a quota'd table. **Ask of any test what it costs to
  run a thousand times**, and if the answer is not "nothing", assert the cost is zero or
  make it so.

The general form: **ask what the check would say if the mechanism were fully built and never
invoked.** If the answer is "it passes", it is testing for the presence of code rather than
for the behaviour, and the two diverge precisely when someone deletes a call site.

Corollary already learned twice: **judge a mutation audit on the exit code, not on stdout.**
Two mutations in this session first read as MISSED because the detector grepped for
`FAILED:` and the mutation made the test *crash* instead of fail. And a test whose assertion
dereferences a value it just asserted (`missing.subject` after `ok(missing)`) throws rather
than reports — write `missing?.subject`, so a real failure names itself.

### Daily answers one question, and the rules that answer it are code

**Daily's job is "what should I do right now", not "here is some information."** One item,
chosen by `web/lib/today.js`, with the reason and the honest time cost. Everything below it
is reference.

Two ordering principles, both deliberate and both load-bearing:

- **Irreversibility beats urgency.** A closing window is unrecoverable — miss it and the
  cycle is gone. A networking touch or a saved role is not. So a window outranks an on-you
  item outranks outreach, *even when the item is due sooner*. Ranking by soonest date is the
  intuitive rule and it is wrong here.
- **A guess never becomes a command.** 1 of 25 tracked dates is `verified`. So confidence
  governs the **wording**, never the eligibility: an estimated date still reaches tier 1, and
  renders as "closes ~30 Sept, estimated — confirm it" rather than as a countdown. Gating
  eligibility on confidence would have put admin above the only live application path,
  because all four dated open windows are estimates.

**The top item must be completable in the time the owner actually has.** Four minutes on a
Tuesday buys one phone call or five directory searches, and every item on the old page cost
more than the session — which is why the tab got closed. When the chosen item does not fit a
short sitting the page offers the smallest real thing that does, rather than pretending the
big one is quick. `minutes` is a **stated** field on `items` and on `deadlines:` entries: no
model guesses it and nothing infers it from the text.

**Tier 2 — "check one careers page, 10 minutes" — is the tier that looks like admin and
isn't.** 16 of 25 windows have no date at all, nobody is watching them, and a missed one
costs a cycle. It is also the only action that reliably fits four minutes.

**There is no "on track" score and there will not be one.** Nothing in this repository knows
what on track means. The frame line above the ladder is four computed facts — months to
graduation, what closes, what opens, how many have no date — and a number that cannot be
derived is a number that was invented.

### A nag you cannot answer is one you learn to skip

The ladder named the same firm every morning and there was no way to say *"I checked, there is
still no date"* — because the dates live in `companies.yaml` and a deployed app cannot write
to the repo. That is not a small gap: an instruction you cannot dismiss trains you to stop
reading the instruction, which defeats the whole redesign.

So a check is an `actions` row keyed `window:<firm>|<program>`, and `applyChecks()` folds it
over the yaml at read time. The yaml stays the seed; the database records what has happened
since. Two effects, and the distinction between them is the careful part:

- **A check with no date** refreshes recency only. Tier 2 orders by least-recently-checked, so
  answering moves that window to the back of the queue and tomorrow asks about a different
  one. It does **not** touch `confidence` — "I looked and there is still nothing" must never
  become "confirmed".
- **A check carrying a date** sets `closes` and marks the window `verified`, in exactly the
  sense `companies.yaml` means: read from the firm's own site by a human. It is the only route
  by which a window in this system ever becomes verified, and it is how the 16 undated ones
  get dated — ten minutes at a time.

**Every recurring prompt needs an answer that the system accepts and acts on.** If the only
way to make a prompt stop is to do the whole task, it is a nag.

### If a spec's mechanism does not discriminate in the real data, say so

**Check the proposed signal against the corpus before building on it. If it does not
separate the rows, report that and propose what does — do not ship the thing that was
asked for and let the screen show why it failed.** This is the standing expectation, not a
one-off.

Two from one step, both about the same row of the same page:

- **Tier.** The spec said "tier 1 in ink, tier 2 in graphite". `companies.yaml` marks
  **21 of the 22** companies that hire this profile as tier 1, so it would have put nearly
  every row in ink and differentiated nothing — the original complaint with extra steps.
  Reported instead of built.
- **Company depth.** The replacement *did* discriminate, 54 roles down to 1, and it measured
  the wrong thing: it rendered Databricks' *Associate Product Manager, New Grad (2027 Start)*
  — one of the few roles explicitly for the owner's class year at a company that publishes pay — as
  secondary, because Databricks has one reachable role. Meanwhile an open-now req at a
  fifty-role company read as primary.

The lesson in the second is sharper than the first. **A signal that varies is not
automatically the right signal.** Depth of board is a fact about a company's hiring volume,
and it belongs on Companies where the question is "where are there many shots". Daily asks
"is this role worth today", and the answer to that is the role: a programme dated for the
owner's class year that they can actually start, or a top-two band. Ask what question the surface is asking
before choosing what to measure.

### Two numbers on one row must come from one population

**If two figures sit side by side, they are being compared. They have to be drawn from the
same set of rows, or the row invites a conclusion that is not true.** Four instances, all
found by reading a screen rather than by a test:

- The cost meter showed **lifetime spend against a since-reset cap** — $29.88 against a $5.00 cap.
- Companies showed `n2027` counting **every** 2027-dated role next to `reachable40` counting
  only reachable ones. Applied Intuition read "1 role here fit you · 9 dated 2027"; five of
  the nine were titled *New Grad (December 2026)* and carried `class_fit: wrong_year`.
- The fit **band** was `MAX(score)` over all roles while the **title beside it** was the best
  *reachable* role. ICONIQ showed "Strong" against a role the owner cannot take.
- The **"40+" sort button** sorted on `at40` while the **"40+" column** displayed
  `reachable40`. They disagree for 10 of the 22 companies that hire this profile, so clicking
  the header reordered the page by an invisible number.

**When adding a count to a row, name the population out loud and check it against its
neighbours.** If one is filtered and the other is not, either filter both or move the wider
one to a tooltip where it is answering a different question and says so.

### A queue that refills itself will occupy whatever slot it holds, forever

Tier 2 offered one undated window a day. A check that finds no date resets that window's
recency, so **the queue never empties** — and while it outranked the on-you items it owned
the top of Daily permanently. Simulated against real data: from 1 October it was selected
every single day, and tiers 3, 4 and 5 were never reached once, with four overdue
commitments sitting below it.

Two fixes, and the second is the general one:

- **A cooldown makes it finite.** A window checked inside 14 days is not offered. Sixteen
  windows over a fortnight is about one a day, and once they are all fresh the tier goes
  quiet and the work below it surfaces.
- **Rank on the strength of the claim, not the category.** "Irreversibility beats urgency"
  is why a *closing* window outranks a commitment. An *undated* window is not closing, it is
  unknown — the argument does not transfer, and applying it anyway put admin above a promise
  the owner made to themselves.

**Ask of any recurring prompt: what makes it stop?** If the answer is "nothing", it is not a
queue, it is a permanent occupant.

### A tier that fires only when nothing else does will never fire

Networking surfaced only when no window and no item did — which after the consulting windows
close means never, and networking is the tier that decides whether this tool is worth opening
in December. It competes on being **behind five new contacts a week** now: a fact about the
week, not a fact about how quiet the page happens to be.

**A backstop is not a priority.** Anything that matters on its own schedule needs its own
condition, or it is decoration that renders once during setup and never again.

### An always-empty source and an always-zero count are the same bug

Reading `contacts.csv` on Vercel returned an empty list forever, and nothing said so — the
page rendered "None owed" and looked like a quiet day. Fixing it exposed the identical shape
one layer down: the weekly cadence counted `first_touch >= cutoff`, and `first_touch` is when
the first MESSAGE went out, not when the name was ADDED. A contact entered today has no
first_touch, so the count was permanently zero and the networking tier would have fired
forever while appearing to measure something. `created_at` is a separate column now.

**When a feature reads a source, ask what it returns when the feature is working correctly
and the answer is genuinely nothing — then ask whether you could tell that apart from the
source being unreachable, or from the wrong column.** If those three look the same on screen,
the reading is not instrumented.

### A negative observation records that you looked, never what you found

**"I checked and there is still nothing" must never be stored as a fact about the world.**
It is a fact about the checking.

Pressing "checked it" with no date refreshes `verified` and moves the window down the queue.
It does **not** touch `confidence`, and it does not change `status`. Only a date — read off
the firm's own site and typed in — sets `closes` and marks the window `verified`. The two are
different kinds of claim and the schema has to keep them different, because collapsing them
turns an absence of evidence into evidence of absence across the whole tracker, and that is
precisely what the McKinsey miss cost: a note that read "typically mid/late September" for a
window that had already shut on 11 August.

Generalises past deadlines. Any "no result" — a search that found nothing, a board that
returned no roles, a check that came back empty — records the attempt and its time, never a
conclusion. **If the only thing you learned is that you looked, that is the only thing to
store.**

Corollary, learned by doing it: **delete your own test rows.** Verifying the check feature
wrote two real `checked` rows against real firms, one with a made-up close date. Sunk
verification effort is not a reason to keep fabricated data — a wrong date on a real firm in
the deadline tracker is worse than an untested feature.

### What software can and cannot do about an item that is rotting

**Software can only make the next action smaller than the resistance, never lie about state,
and get out of the way.**

That is the whole of it. None of this makes the owner call career services. What follows are the
three things that are actually within reach, and the reason each one is not a nag:

- **Count up, not down.** After the due date the honest reading is "2 days overdue · added 12
  days ago · never touched". A countdown implies progress that is not happening.
- **Ask once, with a handle.** Anything the owner cannot answer in one click is a nag, and a nag
  they cannot answer trains them to close the tab — which is exactly what was happening.
- **Split from pre-authored steps, never generated ones.** "Pull 15 alumni names" becomes
  three × "pull 5" from a `steps:` list. Deterministic and free; a model-generated split
  would cost money to do worse.

Corollary already applied: **an empty section must not look like a quiet day.** "Nothing
saved yet", "None owed" and "Nothing closing inside 21 days" all read as *nothing to do* and
all three actually meant *this feature has never been used* or *the horizon is wrong*. A
section backed by a never-populated table renders as its own setup action, or not at all.

### A warning horizon shorter than the task cannot do its job

Daily said **"Nothing closing inside 21 days"** while, three sections above, the owner's own
on-you item said **"Apply to Accenture, Deloitte Consulting, EY-Parthenon — the Aug-Sep
window is open NOW."** Both came out of this repository and they contradicted each other. The
nearest open window closes in **33 days**.

`WINDOW_HORIZON_DAYS = 45`, and it is chosen from the task rather than from taste: a
consulting application is a week of work, so a horizon of 21 days was shorter than the thing
it was warning about. It lives in `web/lib/display.js` — not `deadlines.js`, which imports
`node:fs` and therefore cannot be pulled into a client component — and the nav badge, the
accent rule and the section all read that one constant so they cannot drift apart.

**Generalise it:** whenever a threshold decides whether to warn, check it against how long
the response takes. A three-day warning on a two-week job is decoration.

### A constant prevents drift only where it is read, and prose is not read

`WINDOW_HORIZON_DAYS` exists so the section, the accent rule and the nav badge cannot
disagree. They disagreed anyway: `Nav.js` carried
`title="application windows closing inside 21 days"` as a **string literal**, so after the
horizon moved to 45 the badge counted one thing and described another. Every test passed and
the build was green; reading the deployed HTML is what found it.

**Any user-facing number that also appears in a sentence needs a test that greps for the
literal.** `test_today.mjs` strips comments from every file under `app/` and `lib/` and fails
on any surviving `inside N days` where N is not the constant — comments are stripped because
several files legitimately explain the old behaviour and that history is worth keeping. Prove
it fails by putting the literal back; it names the file.

Apply the same shape whenever a threshold, a cap or a count gets prose next to it.

### Every sort ends in a unique tie-break, or the page reshuffles on its own

Third occurrence in this project, so it is now a rule rather than an observation:

- `listCompanies` sorted on `best` then `at40`, and every company in "Watching" ties on both.
- `bestRole`'s `ROW_NUMBER() OVER (PARTITION BY company ORDER BY score DESC)` picked an
  arbitrary row among equals.
- `networking_targets.py` ran `ORDER BY s.score DESC` with no tie-break, and Palantir and
  Saronic — both 92 — swapped places between two runs of the daily cron. It showed up as an
  unexplained 151-line diff in the working tree.

**A comparator that can return 0 for two distinct rows is not finished.** End every one in
something unique: `key` for jobs, `name` (the slug, not `display_name`) for companies, `id`
for items, `firm` + `program` for windows. Same for SQL — an `ORDER BY` whose columns can tie
must name a unique column last, and a `GROUP BY ... ORDER BY count DESC` must break the tie on
the grouped column.

Swept the whole repository in one pass rather than fixing them one discovery at a time; the
survivors are the ones already ending in a unique column. The symptom is always the same and
always dismissible: identical rows in a different order.

### A value that must reach production cannot travel by filesystem

The deployed cost meter read **$29.88 / $5.00 OVER CAP** (the cap at the time), in red, on every page, while the
same code read **$3.17** locally. `cost.js` read `../config.yaml` at request time; that file
is not in the Vercel bundle; a bare `catch {}` swallowed the ENOENT; and the `"1970-01-01"`
fallback made every batch ever submitted count as this month's spend. The number the owner checks
before deciding whether they can afford to score anything was wrong, in production only, and
looked authoritative.

What makes it worth writing down is **why only that one read failed**. Five other modules read
repo-root files exactly the same way — `deadlines.js`, `manual.js`, `companyNotes.js`,
`contacts.js`, `profile.js` — and all of them work on the deployed site, verified by finding
their content in the served HTML. The entire difference is one line of shape:

```js
const YAML = path.join(process.cwd(), "..", "companies.yaml");    // module-level:   TRACED
fs.readFileSync(path.join(process.cwd(), "..", "config.yaml"));   // inside a fn: NOT traced
```

The build tracer statically evaluates a module-level const and copies that file into the
bundle. It cannot follow the same expression built inside a function body. So whether a file
ships at all depends on whether a constant happened to be hoisted — a distinction nobody
refactoring `cost.js` would ever guess was load-bearing.

- **A value production needs is baked in at BUILD time**, into a module that `import` traces
  like any other code. `web/lib/genconfig.mjs` reads `config.yaml` during `prebuild` and
  writes the gitignored `web/lib/config.generated.js`. If it cannot read or parse it, the
  **build fails** — there is no default left to fall back to, which is the point.
- **`npm run build`, never `npx next build`.** The prebuild step is where the value is
  generated; skipping it verifies something other than what ships. The pre-commit hook was
  changed for this reason.
- **The five remaining request-time reads work by accident of that same static analysis**, and
  are one refactor away from silently emptying the deadlines panel, the Companies notes, or
  the Daily manual items. Convert each to the same build-time bake when it is next touched.
- **A default that changes what a number MEANS is worse than a crash.** `"1970-01-01"` looks
  harmless. It silently converted "this month" into "all time" on a meter whose whole job is
  telling the owner whether they are over a hard cap.

### One posting can list many cities, and the row has to survive it

`groupRoles` collapsed several ROWS of the same role into one. It never handled the other
shape: **one row whose location field already holds every city**, joined with `"; "` by
`fetch_jobs.py:538`. Greenhouse gives Anduril's *2027 Early Career Software Engineer* nine of
them in a single 331-character string; Rippling's support roles carry thirteen remote states.
`.loc` is `white-space: nowrap`, so the Daily row ran **1270 pixels past the viewport** and
put a horizontal scrollbar on the page.

`splitLocations()` splits on the semicolon and nothing else — a comma is not a separator,
because "Costa Mesa, California, United States" is one place. It splits for **display only**:
`groupKeyOf` still hashes the raw field, since that key is the identity every Save, Hide and
Applied is stored against, and changing what it hashes would orphan the lot.

**Assume any field a board fills in can arrive as a list.** Title, location, department — the
single-value case is the one that happens to be in front of you.

### A rule enforced by a document is a rule waiting to be missed

**If a rule matters, the default must enforce it.** A rule that depends on someone
remembering a flag, an env var, or a line in this file is enforced by discipline, and
discipline fails silently — usually in the direction of spending money or corrupting data.

This is not hypothetical. CLAUDE.md recorded "Haiku is the default scorer, validated
2026-08-25" while `score_jobs.py` said `MODEL = os.environ.get("JOBOPS_MODEL",
"claude-sonnet-5")` the entire time, and `.env` set nothing. The owner's standing "score only
program or entry" rule sat behind an opt-in `--reachable-only`. A run estimated at $0.07
ran on the wrong model over six times the roles and cost **$1.19**. Both rules were
written down. Neither was enforced.

**When a rule is added here, ask what makes it true in the code.** If the answer is
"whoever runs it remembers", convert it:

- the safe behaviour is the DEFAULT; the dangerous one takes an explicit flag that prints
  what it is about to do and its cost first;
- the guard sits in the code path that acts, not in the caller;
- a violation *refuses and exits non-zero* rather than warning.

Converted so far: model default is Haiku; program/entry-only is the default with
`--include-experienced` to override; the `config.yaml` cap refuses before both the batch and
sync paths; `score` refuses outright if the scores table already holds a different model.

Still enforced by discipline, and worth converting when touched: "never delete before the
replacement is verified" and the clearance phrasing rules outside `clearance.js`. "Never
emit a bracket" is enforced in the pack writer and the critic.

Enforced by construction, which is the strongest form and needs nothing: there is no code
that submits an application, and none that scrapes anybody.

### An estimate that can disagree with the run is decoration

**Any cost or size estimate must come from the same code path the real run uses.** Not a
query written by hand that describes what you believe the command does.

The $1.19 overrun was a hand-written `SELECT` that assumed a model the code did not use
and a filter the code did not apply. It was a confident, specific, wrong number, and it
was approved *because* it was specific.

The same mistake immediately recurred one layer down: the replacement estimate priced
`len(rows)` **roles** when the batch submits `len(rows) * SCORE_SAMPLES` **requests** —
three samples per role — under-reporting by 3x. Reading the submission code is what
caught it, not reasoning about it.

`score --dry-run` prints the model, the exact role and request counts, and the cost, using
the real selection and stopping before it sends. Every run prints the same block whether
or not `--dry-run` is passed, so the numbers are on screen before anything is spent.

**Corollary: the cost meter under-reports.** It prices stored request counts against mean
token shapes and ignores cache-write tokens; the one batch measured against real API usage
came to $1.19 against the meter's ~$0.78. Treat the meter as a floor, and measure from
`messages.batches.results()` usage when a number actually matters.

### Sunk API spend is never a reason to ingest bad data

**Money already spent is gone whatever you do next. It is not an argument for keeping the
results.**

115 of 123 requests succeeded before a mis-issued Sonnet batch could be cancelled — $1.19,
unrecoverable the moment they completed. Ingesting them would have put 115 Sonnet scores
into a table of 736 Haiku ones, and Haiku scores ~14 points higher on the same role, so
the top of every ranking would have gone to whichever model inflates more. The $1.19 was
already spent; ingesting would have bought nothing back and cost the integrity of every
ranking in the tool.

The results were discarded and the batch row marked `collected_at = '... CANCELLED-...'`
so no later `collect` can pick it up. **Discard, record why, and re-run correctly.** The
pull to "use it since we paid for it" is strongest exactly when the data is most wrong.

### Never ship a prompt change without eyeballing a held-out sample

**Any change to the scoring prompt, or to any classifier that gates, requires re-running a held-out
sample and reading the kills by hand before a full run.** Prompt changes are not safe by default.
Compare against the previous run's verdicts on the *same* roles — `triage_history` kept every
verdict by `prompt_version` for exactly this when the LLM triage stage existed, and the same
before/after query works for the gate — and look at three things: what flipped kill→pass, what
flipped pass→kill (should be near zero unless you intended it), and whether the survival rate
moved for the reason you expected.

**Why:** the first LLM triage prompt scored a perfectly reasonable-looking 20% survival rate while
killing *"Forward Deployed Software Engineer, New Grad — US Government"* at Palantir, which is
close to the single most on-target posting in the corpus. The headline rate looked fine. Only
reading the kill list caught it. A rate tells you how much got through, never what.

Corollary: when a verdict depends on a fact extracted from the posting (years of experience, remote
eligibility), **verify the extraction against the raw text** before trusting the verdict. Checking
the year counts against the actual postings is what surfaced both that `strip_html` was leaving 17%
raw markup in every Greenhouse description and that "preferred qualifications" were being read as
hard requirements.

### Verified model IDs (checked 2026-08-24)

Run `python score_jobs.py verify-models` to re-check; it makes one 1-token call per ID.

| ID | Status | Notes |
|---|---|---|
| `claude-haiku-4-5-20251001` | works | **Pinned default scorer** (`JOBOPS_MODEL` default in `score_jobs.py`). |
| `claude-haiku-4-5` | works | Alias; currently resolves to the snapshot above. |
| `claude-sonnet-5` | works | Used for the calibration comparison only. |

**Prefer dated snapshots over bare aliases.** An alias can be repointed to a later model without
notice, which would silently change scoring behaviour mid-pipeline.

### No deadline urgency

There is **no external deadline on the scoring pipeline.** A model-pricing date once appeared in
the git history as if it mattered; scoring runs on Haiku, and the difference on a full pass is a
few dollars on a bill in the single digits. **Verify carefully rather than rushing.** Real
deadlines in this project are recruiting application windows, which live in `companies.yaml`
under `deadlines:` — not model pricing.

### Emphasis tags

Every evidence item carries an `emphasis` array drawn from exactly four values: `product`,
`consulting`, `defense`, `finance`. Items may carry several. The pack writer selects and orders bullets
by the emphasis matching the role. Other descriptors (`growth`, `0-to-1`, etc.) belong in `signals`,
which is free text — do not add new values to `emphasis`.

### Never emit a bracket

No square-bracket placeholder reaches any output file — not a missing number, not an
ASK-THE-OWNER marker, not a stale bracket copied out of an old draft. If a number is missing,
cut the clause. Working notes may carry such markers internally; a pack never does.

### Network transfer is a cost class, and nothing was counting it

Neon's 5 GB monthly allowance ran out at 11:57 pm on a day nothing else was
wrong, and the first anyone knew was an email from Neon. Every page still
rendered; the CLI just stopped connecting, with `53000 Your project has exceeded
the data transfer quota` — a Postgres error, not a socket one, so it looked
nothing like the VPN outage that preceded it.

Two causes, and the smaller one is the recurring one:

- **A storage change quietly became a transfer change.** Keeping full
  description text for every tracked board raised the mean stored description
  from 2,656 to 6,358 characters, which took the nightly fetch from 34 MB to
  77 MB — **1.02 GB/month to 2.30 GB**. Storage was quantified at the time.
  Transfer was not.
- **Ad-hoc corpus probes.** 1.07 GB in one session: a full re-fetch, five
  blocker backfills, eight `SELECT`s over the whole corpus to answer questions
  that `transfer_budget.py` now answers with no database at all.

**Quantify transfer for any change touching more than 1,000 rows**, and print
the row payload in the job that does it. `fetch_jobs` prints
`~2.4 MB of row payload sent (rewriting every row would have been ~66 MB)` on
every run for this reason. The `content_hash` column is what makes the
difference: a row whose hash is unchanged gets a touch of a few dozen bytes
instead of its whole description. Measured after the fix: **77.8 MB on the
migration run, 2.4 MB the next night, 11,164 rows unchanged.**

**`transfer_budget.py` takes NO database connection, deliberately.** A tool for
diagnosing an exhausted allowance must not be another consumer of it.

Corollary: **the allowance is a fact about the plan, so it lives in
`config.yaml`.** It was hardcoded to the free tier's 5 GB, survived the upgrade
to Launch (500 GB), and would have made every percentage wrong by 100× — firing
"ALLOWANCE EXHAUSTED, nothing should run against the database" at 1% of the real
budget, every morning, until the owner learned to ignore the one line that matters
the month it runs out.

### A secret in Actions is not an environment variable on the runner

The digest reported **"Neon transfer: not being read"** every night while
`NEON_API_KEY` sat in the repository's Actions secrets. Secrets are exposed only
to steps that **map** them, and nobody had. `lib/neonusage.mjs` read
`process.env.NEON_API_KEY`, found nothing, and returned its no-key state — which
is correct behaviour and indistinguishable from a missing secret.

`test_ci_scripts.py` now walks each workflow script's imports and requires every
env var it reads to be mapped. Three attempts, and the first two are the lesson:

- It collected modules with `needs_generated()`, which **returns early** the
  moment it finds its target. The walk was truncated — 6 modules instead of 31 —
  and never reached the file that reads the key. The positive assertion
  `len(seen) >= 1` was satisfied by the truncated walk. **A count is not evidence
  that the right things were counted.**
- It then compared against the raw workflow text, which contains the **comment
  explaining why the key must be mapped**. The check was satisfied by its own
  documentation. It reads the parsed `env:` blocks now.

Also: the regex matched only `process.env.NAME`, and `driver.js` — the module
that reads every connection variable in the project — spells it
`const env = { ...process.env }` then `env.DATABASE_URL_UNPOOLED`. **A guard
blind to the dominant spelling in the code it guards is not a guard.**

### Prompt caching costs MORE at parallel batch shapes

The pack batch ran with `cache_control` on the system block, on the model that
it would be "written once and read at a tenth of the price for the other 140."
The run recorded **813,888 cache-creation tokens against 587,808 cache-read** —
about 104 writes and 75 reads across 124 requests, not 1 and 123. Batch requests
run in parallel, so every worker that starts before the cache is warm writes the
prefix itself, and the ephemeral cache expires while a forty-minute batch is
still running. Measured at **11% MORE** than not caching.

`CACHE` is off, and the dry-run prints both figures every time so the comparison
is on screen if the batch shape ever changes.

### `max_tokens` is a ceiling on thinking plus output, and prose blows it

`3000` was quoted in this file as a floor for a structured **score object** and
was read as a ceiling for anything. The first pack batch hit
`stop_reason=max_tokens` on **all 124 responses**, and 87 of them stored nothing
usable: 50 came back empty and 37 unparseable. It fails as a JSON parse error,
not an API error, so it reads as a prompt problem.

`MAX_TOKENS = 8000` with `effort: low` — roughly three times the largest real
answer. After the change: **84 of 87 parsed, 96.6%**, measured output 1,049
tokens per role against an assumed 1,800.

### A slug match is not an identity

`discover` reported EON as found because a Greenhouse board answered on the slug
`eon` — an unrelated company. The same shape hid Shield AI's real Lever board
behind a public *demo* Greenhouse board on the slug `shield`, and Mistral was
only resolved by reading its careers page for a link to `ashbyhq.com` rather than
by guessing.

**Resolve the slug from a link on the company's own careers page, then verify
identity from a real posting's own text.** Never from the slug matching the name,
and never from a 200 — Ashby returns HTTP 200 with a JS shell for any slug
whatsoever.

### A requirement screen reads bullets, never the document

Screening for "years of experience" over the whole description matched the
sentence in a *preferred qualifications* block and killed roles whose hard
requirements the owner meets. The same shape made a clearance pattern read
`(TS/SCI Clearance Required)` in a title as `none_mentioned`, because every
pattern was sentence-shaped and expected "active" or "current" beside
"clearance".

**Match per bullet and per line, not per document**, and ask of any classifier
that reads prose what it does with a title, an abbreviation, a bullet list and a
line break. Those four break more patterns here than anything else.

### A forbidden-claim guard must test the PERMITTED phrasings too

`forbiddenClaim` flagged three sentences CLAUDE.md explicitly permits:

```
"I have no active clearance and no prior deployment experience."   FLAGGED
"I hold no active clearance."                                      FLAGGED
"I do not have a current clearance."                               FLAGGED
```

The first is verbatim from the top-scoring Palantir cover note. The pattern
matched the noun phrase without looking at the word in front of it, and
`clearance.js`'s own header warned about exactly this failure — its permitted
list tested short fragments, never the first-person negations a model actually
writes. A write-time guard using it would have refused correct packs forever,
paying each time to regenerate text that was already right.

Possession phrases are excusable by an adjacent denial; flat assertions
("is cleared", "cleared to TS/SCI") never are, so negation cannot become a hole
in the half of the rule that matters. **Every guard over generated prose needs
both halves: every phrasing that must be caught, and every phrasing that must
not.**

### Two populations in one row must not share a counter

Fourth instance, so it is a standing rule rather than an observation. The newest:
the outreach role picker offers **12 reachable** Palantir roles while the company
has **310 open**, and the reason line says "best fit of 12 reachable roles here"
rather than "best of 310" — a claim about a list that was never considered.

**Name the population out loud in the sentence that carries the number.**

### A generator must not import the module it writes

Wiring `transfer.js` to the baked allowance closed a build-time cycle:

```
genconfig -> notify.js -> transfer.js -> config.generated.js
     ^                                          |
     +------------- which genconfig WRITES -----+
```

It ran perfectly on a laptop where a previous build had left the file on disk,
and would have died with `ERR_MODULE_NOT_FOUND` on a fresh clone and on the
Actions runner. `test_config.mjs` caught it, because its fixture builds a
throwaway tree **without** the generated file.

`TRIGGERS` moved to `lib/triggers.js`, a module with no imports of its own.
`test_ci_scripts.py` fails if either generator reaches the module it writes.

### Neon scales to zero, so the first query of the day pays a cold start

On the Launch plan the compute suspends after five minutes idle and the first
connection wakes it. That is a **connect** delay, not a query delay, and it lands
on whatever runs first — usually the fetch, occasionally a browser test, which
then reads as a flaky test rather than as a sleeping database.

`pgdb.connect()` sets an explicit `CONNECT_TIMEOUT` and retries **once**, and
only when `is_connection_error()` says the failure was the transport — the same
predicate `with_reconnect()` uses. Not a retry loop: a wrong password or a
missing database will not be right the second time, and retrying it turns a
clear error into a slow one. `browser_test` retries once and says so out loud
for the same reason.

The explicit timeout is the part worth keeping. Without one, pg8000 inherits the
OS socket timeout — minutes on some paths, immediate on others — so cold-start
behaviour depended on which machine was asking.

### Never mistake a page that loads for a page that worked — the watcher edition

`watch_pages.py` rejected Atlassian's and Adobe's real careers pages — HTTP 200,
85 and 75 lines of genuine content — because both load reCAPTCHA for their apply
form and the word "captcha" appears in a `<script src>`. Bot markers were being
matched against the **raw** HTML.

A watcher that reports every healthy page as blocked is worse than no watcher: it
fills the health line with false alarms until the section is ignored, which is
the failure the watcher exists to prevent.

And the mirror of it: **WINDOW OPENED fired on the baseline run**, for 4 of 15
seeded pages, because `last_status_hit` defaults to 0 and the page already said
"applications are open" on the night it was added. The "a first sighting is not a
change" rule had been applied to the hash and forgotten for the regex — putting a
false emergency at the top of the digest, the one place a false alarm costs most.

**Both halves of a change detector need the first-sight rule.**

## Extending it

The original roadmap is complete: boards, gate, scorer, tracker, people, outreach drafts,
packs, the critic, interview prep, the watcher, the digest, and the web app all exist. What
is left is the owner's own cycle. When adding something:

- **One phase at a time, with the owner's go before each.** Report after each: what was
  done (3–6 bullets), open uncertainties, the exact commands to see the result, and what's
  next. Then stop and wait.
- **A feature is not finished until it has a UI surface and a test that can fail.** The
  rules above about guards, snapshots and self-checks are the standard; a mutation audit
  (`audit_mutation.mjs`) is how you prove a new guard is live.
- **Every new model call prints its cost first and runs on the Batch API.** The Ask box is
  the only synchronous exception and it is capped.
- **Every new personal fact goes through `profile.json` → `owner.py` / `OWNER`**, never a
  literal. Every new preference goes in `config.yaml` and is baked by `genconfig.mjs`.
- **Every new classifier change gets a full-corpus diff, read by hand, in both directions.**
- **Deadlines and dates are typed in by a human from the firm's own page**, with a
  confidence label. Nothing scrapes a date.

Good next additions, if the owner wants them: more boards (verify each slug with `discover`
and `resolve`, never by name), a second school's alumni search term, and converting the
remaining request-time file reads (`deadlines.js`, `manual.js`, `companyNotes.js`) to the
build-time bake.

## Conventions

- Small commits, one feature each. Test before committing.
- **Ask before adding any dependency** beyond `requests`, `pyyaml`, `anthropic`,
  `python-dotenv`, `pg8000`. On the web side: `next`, `pg`, `react`, and one dev
  dependency, `puppeteer-core`, which `test_overflow.mjs` uses to drive the Chrome
  already installed rather than downloading its own — on the original's ARM64 laptop a
  bundled Chromium would have been an x64 build under emulation.
- **`pg8000`, not `psycopg`, and the same one everywhere.** `psycopg[binary]` had no
  `win_arm64` wheel and plain `psycopg` found no libpq on the original machine, so it
  could not run there. `pg8000` is pure Python, which means every developer machine and
  the Linux x64 Actions runner execute the *identical* code path. Two client libraries
  against one database is a bug that only shows up in one of them.
- Print concise summaries, not walls of text.
- Report after each phase: what was done (3–6 bullets), open uncertainties, the exact commands
  the owner should run to see the result, and what's next. Then stop and wait for a go.
