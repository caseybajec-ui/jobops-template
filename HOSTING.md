# Hosting — a link, not a dev server

Vercel for the app, **Neon** Postgres for the data, the daily job on GitHub Actions.

*(The original instance started on Supabase and moved to Neon because its free tier
allows many projects per account. It is plain Postgres either way — only the host
changes.)*

Work through the steps in order; each one says where to click, what to copy, and how
you'll know it worked. The local SQLite mode (`JOBOPS_LOCAL_DB=1`) keeps working
throughout, so nothing here is a one-way door until you retire it in the last step.

---

## What goes to GitHub, and what never does

The repo is **private** and contains your own personal data **on purpose**. The line
is *whose* data it is.

**In, deliberately:** `profile.json`, `resume_tech.md`, `resume_finance.md`, the
resume PDFs under `web/public/resume/`, `daily.yaml` — your name, GPA, employers,
education. These are things you would hand a recruiter anyway, and the repo is useless
without them.

**Out, always:** `contacts.csv` and `outreach/` contain **other people's** names and
contact details. Also `.env`, `web/.env.local`, `jobs.db` and any other database,
`voice/`, `logs/`.

Do not start tracking `contacts.csv` or `outreach/` for convenience. Contacts and
outreach live in Postgres and are read from there.

`python test_nothing_private_staged.py` enforces this and runs in the pre-commit hook.
.gitignore alone is not enough: `git add -f` overrides it silently, and an
already-tracked file stays tracked whatever .gitignore says afterwards.

---

## The one rule about order

**The secrets audit is step 1 and nothing goes to GitHub before it passes.** Every
other step is reversible. That one is not: once a key is in a public or even a
private repo's history, the only fix is rotating the key.

Before the first push, scan **every commit in history**, not just the current tree,
for `.env`, `jobs.db`, `contacts.csv`, `outreach/`, and for content shaped like a
secret: `sk-ant-`, `postgres://`, `postgresql://` with credentials, `NEON_`,
`re_` (Resend), and anything shaped like a bearer token. If anything is found, rotate
the key first; the repo can wait ten minutes.

---

# Step 1 — the repo

1. Go to <https://github.com/new>.
2. Name it. Select **Private**. Do **not** tick "Add a README", "Add .gitignore", or
   "Choose a license" — the repo already has all three and a pre-filled repo will
   refuse the first push.
3. Click **Create repository**, add it as `origin`, push `main`.
4. Confirm the pushed file list contains no ignored file.

**How you'll know it worked:** the repo page shows your files and no `.env`, no
`*.db`, no `contacts.csv`.

---

# Step 2 — Neon project and schema

1. Go to <https://neon.com> and sign up with GitHub. No card required on the Free plan.
2. **Create a project.** For region, pick the US region nearest you — you are one user
   and this is not latency-sensitive.
3. Neon creates a database called `neondb` by default. Keep it; the name doesn't matter.
4. On the project dashboard, click **Connect**. You will see a connection string with a
   **Connection pooling** toggle. **You need both versions, so do this twice:**
   - Toggle **on** → copy it. This is the **pooled** string; its host contains
     `-pooler`.
   - Toggle **off** → copy it. This is the **direct** string; same host, no `-pooler`.
5. Open `.env` in the repo root and add both:
   ```
   DATABASE_URL=<the POOLED one, with -pooler in the host>
   DATABASE_URL_UNPOOLED=<the DIRECT one, no -pooler>
   ```
6. Never paste the values into a chat, an issue, or a commit. Report whether they
   loaded as booleans, never as strings.

**Why two.** Neon puts PgBouncer in front of the pooled endpoint in transaction mode,
which is right for serverless — Vercel opens a connection per request — but it does not
support `SET`/`RESET`, `LISTEN`/`NOTIFY`, SQL-level `PREPARE`, temporary tables, or
session advisory locks. The schema migration and the Python CLI do DDL and long-running
work, so they use the direct string. The app uses the pooled one. This is Neon's own
recommendation and it is the same split Vercel's Neon integration sets up automatically.

7. Apply the schema: `node web/lib/runsql.mjs migrations/001_initial.sql` against the
   direct connection. `pg` is pure JavaScript and installs anywhere. The file is
   idempotent (`CREATE TABLE IF NOT EXISTS` throughout); running it twice changes
   nothing. Every later migration applies itself from the daily workflow.

**How you'll know it worked:** `python -c "import pgdb; print(pgdb.using_pg())"`
prints `True`, and Neon console → **Tables** lists `jobs`, `scores`, `batches`,
`items`, `actions`, `contacts` and the rest.

If you ever want to look at the data: Neon console → the project → **SQL Editor**.

---

# Step 3 — deploy to Vercel

1. <https://vercel.com/new>. Sign in with GitHub.
2. **Import** the repo. Grant access to that one repo only.
3. **Root Directory: `web`.** Click Edit next to Root Directory and select it.
4. Framework Preset should auto-detect **Next.js**. Leave build settings alone. The
   build command is `npm run build`, never `npx next build` — the `prebuild` step is
   where `config.yaml` and `profile.json` get baked into the bundle.
5. Before deploying, open **Environment Variables** and add:
   - `DATABASE_URL` — the **pooled** string from Step 2 (the one with `-pooler`)
   - `JOBOPS_PASSWORD` — pick one now, save it in your password manager

   Vercel only needs the pooled one; nothing deployed runs DDL.
   Set both for **Production, Preview, and Development**.
6. Click **Deploy**. Takes ~2 minutes.
7. Note your Vercel project URL. **Write it down in this file**, here, under this
   step. The reason: a Claude session's Vercel integration may be scoped to a
   different team and simply not list the project — with no error and no hint that
   anything was withheld — so an agent checking "did it deploy" will conclude the
   project does not exist rather than that it cannot see it. This file is the source
   of truth for where the thing is; the API is not. Verify a deploy in the Vercel
   dashboard, or by loading the site.

**How you'll know it worked:** the URL loads a password prompt, and the right password
gets you to Daily with real data.

### Password: middleware, not Vercel's own protection

**Vercel's Deployment Protection cannot protect a production deployment on the Hobby
(free) plan.** Vercel Authentication covers *preview* deployments on Hobby; protecting
production requires Pro. Password Protection is Pro/Enterprise only. So on the free
plan the choice isn't between two systems — it's middleware or nothing.

One system, not two: `JOBOPS_PASSWORD` + a signed 30-day cookie, rate-limited, in
`web/middleware.js`. `web/test_auth_bypass.mjs` fires the known bypass shapes at it;
run that against the deployed URL after any change to the middleware or to Next.

**Confirm this yourself when you're on the settings page** — Vercel moves features
between tiers. Go to **Project → Settings → Deployment Protection**. If *Password
Protection* is available on your plan at no cost, theirs is strictly better because it
is zero code.

### The branch is `main`

The template's default branch is `main`. `.github/workflows/daily.yml` has no branch
filter, and Vercel's Production Branch defaults to the repo's default branch, so
nothing needs editing — but if you rename the branch, update GitHub's default branch,
Vercel's production branch and any workflow filter together, as its own change with
nothing else in flight. **Two names in play is a class of bug where everything looks
configured and nothing ever triggers.**

### Next.js is pinned to the 15.5 line, and why not 16

Vercel refused the original's first deploy outright — the build succeeded and every
route compiled, then "Vulnerable version of Next.js detected". The pinned version was
carrying **29 advisories**, several rated critical.

**The fix was the latest 15.5.x, and deliberately not 16.** npm's own resolution
called it the non-breaking fix (`isSemVerMajor: false`); 16 is a major version. Same
minor line means no intentional breaking changes, which is what you want in an upgrade
that exists to unblock a deploy rather than to gain features.

**The advisory that mattered was not the one Vercel blocked on.** Four of the 29 were
*middleware bypasses* — segment-prefetch routes, dynamic route parameter injection, and
two incomplete-fix follow-ups. `middleware.js` **is** the password gate, so on the old
version the gate was bypassable. That is a better reason to upgrade than the deploy
block, and it is why the verification includes firing known bypass shapes at it rather
than only checking that pages still render.

**`sharp` was removed, not upgraded.** It arrived as an optional dependency of Next for
`next/image` optimisation, carrying inherited libvips CVEs. This app renders no images,
so it was pure attack surface and build weight. Vercel does its own image optimisation
anyway, so nothing needs it back unless the app starts showing pictures.

---

# The Ask box's key — how to add it in Vercel

The read-only Ask box on Pulse needs one environment variable. Until it is set the box
renders disabled and names the variable; nothing else changes, and no other part of
the app is affected.

**It is a key for this project only.** The variable is called `JOBOPS_ANTHROPIC_KEY`
rather than `ANTHROPIC_API_KEY` precisely so it can never be confused with the
pipeline's key (or with any other project's), and `web/lib/ask.js` reads that name and
no other — there is no fallback of any kind, which `test_ask_isolation.py` enforces.

1. **Make the key.** console.anthropic.com → the account you want billed for this
   (check the account switcher in the top left if you have more than one) →
   **API keys** → **Create key**. Name it `jobops-ask` so it can be found and
   revoked on its own. Copy it — the console shows it once.
2. **Add it to Vercel.** vercel.com → your project → **Settings** →
   **Environment Variables** → **Add New**.
   - Key: `JOBOPS_ANTHROPIC_KEY`
   - Value: the key from step 1
   - Environments: tick **Production**, **Preview** and **Development**
   - Leave "Sensitive" on, which is the default for a secret.
3. **Redeploy.** Environment variables are read at build and run time, so an
   existing deployment does not pick it up. **Deployments** → the top one → the
   ⋯ menu → **Redeploy**.
4. **Check it.** Open `/pulse`. The heading should read "Ask about this data —
   30 of 30 questions left this month". If it still shows the disabled message,
   the variable did not reach the running deployment: confirm the name has no
   typo and that step 3 actually redeployed.

**Locally the variable goes in `web/.env.local`, NOT the repo-root `.env`.** The
repo-root `.env` reaches the app through `readEnv()` in `web/lib/pgcheck.mjs`, which
reads `cwd/../.env` off disk and is how `DATABASE_URL` gets to the local dev server.
**`web/lib/ask.js` does not use that path** — it reads
`process.env.JOBOPS_ANTHROPIC_KEY` as a literal, deliberately, because
`test_ask_isolation.py` greps for the literal read and an indirection buys a blind
spot. Next.js loads `web/.env.local` into `process.env` automatically, so that is the
channel `ask.js` can actually see.

`web/.env.local` is gitignored via the `.env.local` pattern in the root `.gitignore`
— the bare `.env` pattern matches only that exact filename and left the Next-convention
path uncovered until this was found.

**To turn it off**, delete the variable and redeploy. The box goes back to its
disabled state and no other page changes.

**The cap** is 30 questions per calendar month, counted as rows in `ask_queries`
and enforced before any request is sent. Spend appears in the footer meter with
everything else. At the cap the worst case is well under a dollar a month.

---

# Step 4 — the daily run on GitHub Actions

`.github/workflows/daily.yml` does: checkout, Python, pip install, bake the config,
apply migrations, then fetch → gate → score (reachable only) → watch pages → verify
deadlines → digest, with the spend cap enforced inside `score_jobs.py` rather than
duplicated in the workflow. A concurrency group so two runs can't overlap, and
`workflow_dispatch` so you can trigger it by hand.

**Schedule: `10 14 * * *` (14:10 UTC).** GitHub cron has no timezone, so a fixed UTC
time drifts by an hour twice a year wherever you are. An hour either way does not
matter for job boards that update overnight; change the hour if you want it earlier.

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**.
2. Add `ANTHROPIC_API_KEY` (the value from your local `.env`).
3. Add `DATABASE_URL_UNPOOLED` (the **direct** string from Step 2). The workflow runs
   the Python CLI, which does DDL on startup and cannot use the pooled endpoint.
4. Add `RESEND_API_KEY` if you want the digest emailed, and `NEON_API_KEY` if you want
   the transfer-allowance line in it. **A secret is not an environment variable until
   a step maps it** — the workflow already maps these; if you add a new script that
   reads a new variable, `test_ci_scripts.py` fails until the workflow maps it too.
5. Go to the **Actions** tab, select **daily**, click **Run workflow** to test it now
   rather than waiting for tomorrow.

**How you'll know it worked:** the run goes green, and the freshness stamp on Daily
reads "Updated just now".

---

# Step 5 — retire the local copy

**Only after the deployed URL is verified.** The point is **one source of truth**. Two
live databases where you cannot tell which is real is worse than either one alone,
because you will read stale data and not know.

- Rename any `jobs.db` → `jobs.db.retired-YYYY-MM-DD`. Renamed, not deleted: it is
  the rollback. The gitignore pattern is `jobs.db*` for exactly this file.
- The local dev server **refuses to start against SQLite** unless you pass
  `JOBOPS_LOCAL_DB=1`. Without `DATABASE_URL`, `npm run dev` exits with a message
  naming the flag rather than quietly serving a stale database. There is no
  configuration in which it silently serves the old file.
- `test_nothing_private_staged.py` fails if more than one `*.db` exists in the tree.

---

# What I expect to break

Not a risk register — these are the things that actually cost time in the original.

### 0. Page latency, as a characteristic rather than a todo

Daily and Inbox render in roughly **0.85–1.1 seconds** against Neon, against effectively
instant on local SQLite. That is the honest cost of a network database, and it is fast
enough: correctness matters more and this is not being optimised further.

Independent queries were already parallelised where it was free — Daily went from eight
sequential round trips to three stages, which bought about 150ms. The rest is transferring
large result sets, not round-trip count, so the next lever would be selecting fewer
columns. **Not worth doing.** Recorded here so a future session does not rediscover it and
assume it is a regression.

### 0b. The daily fetch: an atomicity problem wearing a performance costume

**Measured: about 3 minutes**, end to end, for ~40 boards and ~10,000 rows. Roughly two
and a half minutes of it is polling other people's boards; the database write is the
small part.

Read the history here before changing any of it, because the obvious reading of it is
wrong.

The fetch used to write ~9,900 rows one statement at a time. In-process on SQLite that
was instant; against Neon every row is a network round trip. The first version was worse
still — a SELECT to check existence and THEN an INSERT or an UPDATE, about 19,800 round
trips — and collapsing that to a single atomic upsert halved it and removed the window
between check and write.

It was **left unbatched on purpose**, on the reasoning that nobody waits on a morning
cron and a few minutes of a 2,000-minute allowance is noise. That reasoning was sound and
the conclusion was still wrong, because it assumed the run completes.

**Everything landed in ONE transaction that committed at the very end.** Under the
job timeout, a run that overran was killed mid-transaction, Postgres rolled back the
lot, and the morning produced *nothing* — not slow data, not partial data, no error row,
just an empty run that would repeat every day with nothing to notice it. Two runs died
that way during the original migration, having written zero rows.

**So this was never a latency question. It was an atomicity question, and a
single-transaction write under a timeout fails closed and silent** — the worst
combination, because "fails closed" hides it and "silent" means nobody looks.

The fix is therefore not "make it faster" but **commit as you go**:

- **250 rows per multi-row `INSERT ... ON CONFLICT`, committed per batch.** ~40 round
  trips instead of ~9,900. 4,000 bound parameters per batch, inside both backends' limits
  (Postgres 65,535, SQLite 32,766).
- A killed run now leaves the boards it already finished, instead of nothing.
- Batching adds one failure the per-row loop could not have: a single
  `INSERT ... ON CONFLICT` may not touch the same row twice, and a paginated board can
  return one posting on two pages. Postgres raises SQLSTATE 21000 and takes the whole
  batch with it. The fetch dedupes within each batch; `test_batch_upsert.py` proves both
  that the dedupe works and that Postgres genuinely refuses without it.

**Closed-detection is scoped to boards that answered**, and that was a live bug, not a
consequence of batching. A failed board contributes nothing to `seen_keys`, and the old
test asked only whether the key's *ATS* was one we poll — true for every row on that ATS.
One transient 500 from a large board closed all of that company's roles for a day. It
healed on the next successful fetch, since the upsert clears `closed_at`, so it was a
day of silent wrongness rather than data loss — still the wrong direction to fail in.
Scoping is per board rather than a global all-succeeded flag, so one dead board does
not suppress closed-detection for the other forty, and nothing is ever closed on
evidence we do not have. If a run dies before that step, nothing is closed at all.

The Actions workflow caps the job so a hung fetch cannot burn the allowance silently,
and the cap is survivable rather than fatal, because an overrun loses the unfinished
tail instead of the whole run.

### 0c. The whole chain, measured

`fetch` → `gate` → `score`, one after the other, on the original's corpus. Every stage
exit 0.

| stage | time | what it did |
|---|---|---|
| fetch | 2m12s | 41 boards, 9,842 rows written, 42 new, 66 closed |
| gate | 13s | 1,566 read, **19 classification + 18 verdict rows written** |
| score | 3m11s | 7 new program/entry roles, 21 requests, Haiku, $0.07 |
| **total** | **5m36s** | **against the job cap: ample margin** |

**The gate number is the interesting one.** It was 544s and wrote ~3,100 rows every run;
it now reads all candidates — it must, because the seniority threshold is per-company
and relative — and writes only the rows whose values actually moved. Every one of those
~3,100 writes had been overwriting a value with itself, at one Neon round trip each.

Most of `score` is waiting on the Batch API in 60-second polls, not work. It is also the
only stage that can spend money, and the only one whose duration depends on Anthropic
rather than on us.

**What would eat the margin:** many more boards, or a day when a large number of postings
genuinely change (the gate writes in proportion to what moved, so a board-wide template
edit is a slow day by design). Re-measure after any change to board count, and put the
real number here rather than an estimate.

### 1. Every data-layer function is async

`node:sqlite`'s `DatabaseSync` is synchronous. Every Postgres client is not. So all
exported functions in `db.js` are `async`, and every caller must `await`. A missed
`await` renders as a blank section rather than an error, which is why every data-layer
function carries a guard that throws if a rendered value is a Promise.

### 2. Files read from disk at request time

The app reads `companies.yaml` (deadlines and company notes) and `daily.yaml` from the
repo at request time. With Root Directory set to `web`, **Vercel bundles files outside
it only when the build tracer can statically see the path** — a module-level `const`
is traced, the same expression inside a function body is not. `config.yaml` and
`profile.json` are therefore baked at build time by `web/lib/genconfig.mjs` instead,
and the build fails if either cannot be read. Convert the remaining request-time reads
the same way when they are next touched.

### 3. SQL that is SQLite-flavoured

`INSERT OR REPLACE` / `INSERT OR IGNORE` became `ON CONFLICT`; `AUTOINCREMENT` became
`GENERATED ALWAYS AS IDENTITY`; `PRAGMA table_info` became `information_schema.columns`.
Date columns are `text`, deliberately, because `substr(posted_at, 1, 10)` depends on it.

Postgres also refuses SQLite's permissive `GROUP BY`, which is a feature: one such
query had been returning an arbitrary application stage for any company with two
applications, with no symptom at all.

### 4. Two writers, one database

The cron job and the app can genuinely write at once. Low risk — the app writes only
actions, items and notes, and the cron writes only jobs and scores — but it stops being
*impossible* and starts being *unlikely*.

### 5. Two connection strings, and using the wrong one

The app must use the **pooled** endpoint and the Python CLI must use the **direct** one.
Get it backwards and the failure is not obvious: the app on a direct connection works
fine until enough serverless invocations pile up and then starts refusing connections,
and the CLI on the pooled endpoint fails the moment it runs DDL or a session-level
statement, because PgBouncer in transaction mode does not support them.

Each entry point asserts which string it got — the pooled host contains `-pooler`, so
it is checkable — and fails loudly on the wrong one rather than working until it
doesn't. The `pg` client is configured `max: 1` in the app, since each serverless
invocation is its own process.

### 6. Neon scales to zero

The compute suspends after five minutes idle and the first connection wakes it. That is
a **connect** delay, not a query delay, and it lands on whatever runs first — usually
the fetch, occasionally a browser test, which then reads as a flaky test rather than as
a sleeping database. `pgdb.connect()` sets an explicit timeout and retries **once**,
only on a transport error. Free-plan users cannot turn suspension off, and there is no
reason to want to: unlike a paused Supabase project, it needs no manual restore.

### 7. Network transfer is a cost class

Neon's free tier has a monthly data-transfer allowance, and the original ran out of it
mid-month after a storage change quietly doubled the nightly fetch payload. The fix was
a `content_hash` column so an unchanged row costs a few dozen bytes instead of its
whole description; the lesson is in `config.yaml`'s `database:` block and in CLAUDE.md.
`transfer_budget.py` estimates the nightly payload with **no database connection**,
deliberately — a tool for diagnosing an exhausted allowance must not be another
consumer of it.

---

# Cost

All three free tiers hold, with one to watch.

| | free allowance | typical usage | what breaks it |
|---|---|---|---|
| **Neon** | 0.5 GB storage per project, a monthly compute and transfer allowance | tens of MB after trimming non-candidate descriptions | Transfer, if a change doubles the nightly payload — see above. |
| **Vercel** | 100 GB bandwidth, 1M requests | one user, a few page loads a day | Nothing realistically. |
| **GitHub Actions** | 2,000 min/month on private repos | ~5 min/day = **~150 min/month** | Nothing, at 7.5% of the allowance. |

**The cost meter in the app header tracks Anthropic spend only.** It says nothing about
Neon. If the site is down and the Anthropic meter looks fine, check the Neon dashboard's
usage page before assuming a bug.

**Vercel Hobby is for non-commercial use.** A personal job search qualifies.

---

# The resume PDFs — where they live and how to replace one

Both resumes are static files served by the app:

```
web/public/resume/resume-tech.pdf       defense, product & tech
web/public/resume/resume-finance.pdf    consulting, VC & growth
```

Next serves `web/public/` at the site root, so they are at `/resume/<file>.pdf`
and the profile card links to exactly those paths. **They are behind the password
gate**: `middleware.js`'s matcher exempts only `_next/static`, `_next/image` and
the favicon, so a signed-out request for a resume gets the login page like any
other route. That is deliberate — these are your own documents, and while you
would hand either to a recruiter, an unauthenticated public URL is a different
thing from a document you chose to send.

**They are committed to the repo**, which is the same call as `profile.json`: your
own data, in a private repo, and the app is useless without them. The rule is
whose data it is, not how sensitive it looks.

## To drop in a replacement

1. **Keep the filenames.** They are referenced by `web/lib/variant.js` and rendered as
   the download name; changing them means editing that file too, and there is no
   reason to.
2. **Let the tool do the copy**, so the identity checks run BEFORE anything is
   overwritten:

   ```
   python resume_from_pdf.py install ~/Downloads/whatever-you-exported.pdf tech \
       --expect-contains "Python" --expect-contains "some phrase only this variant has"
   ```

   It refuses, copies nothing, and exits 2 if the file is the other variant, is
   not a resume, or is byte-identical to what is already there. Add an
   `--expect-contains` for whatever you just changed. **This is the recommended
   route** — in the original, three replacement attempts in a row went to the
   wrong file, and each would have converted cleanly.

3. **If you copied by hand instead, re-run the converter** so the markdown the
   tool reasons from matches the document you now send:
   ```
   python resume_from_pdf.py web/public/resume/resume-tech.pdf resume_tech.md
   python resume_from_pdf.py web/public/resume/resume-finance.pdf resume_finance.md
   ```
4. **Commit both the PDF and the regenerated markdown together.** The pre-commit
   hook runs `test_resume_parity.py`, which fails if a PDF changed and its
   markdown did not — that check exists precisely so a new resume cannot be
   deployed while every talking point still quotes the old one.

**Never hand-edit `resume_tech.md` or `resume_finance.md`.** They are generated;
an edit is lost on the next conversion and fails parity in the meantime. If the
wording is wrong, fix the PDF — it is the document that actually gets read.

Extraction uses `pdftotext -layout` from poppler. On macOS `brew install poppler`; on
Debian/Ubuntu `apt install poppler-utils`; on Windows it ships with Git Bash. It is not
a Python dependency.
