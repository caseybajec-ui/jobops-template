# SETUP — turn this template into one person's JobOps

These are instructions for the Claude Code session doing the setup, written so
it can run with no other context. A person reads them too; the parts that need
a human are marked **HUMAN**. Follow the steps in order and stop where it says
stop.

The template is a complete, tested job-search system built for one person and
then stripped of everything personal. Setup puts one person back in: their
resume, their targets, their cities, their pay floor, their school. Nothing
else changes. **Do not invent a single fact about the person.** Every claim in
`profile.json` must come from their resume or their inputs, in their words.

## 0. What you need before starting

Files in `setup/` (the person provides these; ask for any that are missing,
then wait):

- `setup/inputs.yaml` — copy of `setup/inputs.example.yaml`, filled in. If the
  person gave the answers in chat instead, write the file from what they said
  and show it to them before going on.
- `setup/resume.pdf` — one resume, **or** `setup/resume-tech.pdf` and
  `setup/resume-finance.pdf` if they keep two framings (tech/product vs
  finance/consulting). One is fine; it is copied into both slots.
- `setup/cover_letter_example.md` (or `.txt`/`.pdf`) — a cover letter they
  wrote. It is the voice sample the pack writer imitates. Optional but
  strongly recommended.

Tools on the machine: Python 3.12+, Node 22+, git, and `pdftotext` (poppler;
`brew install poppler` / `apt install poppler-utils` / on Windows it ships with
Git Bash). Then:

```bash
pip install -r requirements.txt
cd web && npm ci && cd ..
```

Do not create any account for the person. Do not run anything that spends
money (`score_jobs.py score`, `apply_packs.py submit`, `pack_critic.py check`,
`prep_pack.py build`) during setup.

## 1. profile.json

Copy `profile.example.json` to `profile.json` and rewrite every field from the
resume and `setup/inputs.yaml`:

- `name`, `graduation`, `school` (one line: school, degree, GPA if given),
  and the whole `owner` block (`first_name`, `email`, `school_short`,
  `school_search_terms`, `school_linkedin_alumni_url`, `class_label`,
  `degree`, `home_city`). These are read by code; a missing `owner.email`
  or empty `school_search_terms` fails the build on purpose.
- `location_preferences`: the metros from inputs, as sentences.
- `target_start`: the `start` line from inputs.
- `targets.tier_1` / `tier_2`: the job types and industries, as two sentences.
- `hard_no`: the `excluded` list.
- `citizenship`, `clearance`: the `work_authorization` and `clearance` lines
  **verbatim**. Never upgrade clearance wording ("eligible", "cleared") — see
  CLAUDE.md.
- `evidence`: one item per real accomplishment on the resume (aim for 6–12).
  `id` is a short slug; `text` is the claim in one or two sentences with its
  real numbers; `emphasis` is drawn from exactly `product`, `consulting`,
  `defense`, `finance` (several allowed; it decides which bullets a pack
  leads with); `signals` is free text. If a resume bullet has no number, the
  evidence text has no number either.
- `skills.engineering` / `skills.analysis`: from the resume's skills line.
- `activities`, `interests`, `voice_notes`: from the resume and inputs;
  `voice_notes` should describe how they write (from the cover letter).

Delete the `_readme` key. Keep the file valid JSON.

## 2. The resumes

Put the PDF(s) where the app serves them and generate the markdown the tool
reasons from. Filenames are fixed; `web/lib/variant.js` and the build read
them.

```bash
cp setup/resume.pdf web/public/resume/resume-tech.pdf       # or resume-tech.pdf
cp setup/resume.pdf web/public/resume/resume-finance.pdf    # or resume-finance.pdf
python resume_from_pdf.py web/public/resume/resume-tech.pdf resume_tech.md
python resume_from_pdf.py web/public/resume/resume-finance.pdf resume_finance.md
python test_resume_parity.py
```

The converter checks that the person's name (from `profile.json`) appears in
the PDF text; if it does not, the PDF is not theirs or the name is spelled
differently — ask, do not guess. Never hand-edit `resume_*.md`; they are
generated.

If `setup/cover_letter_example.*` exists, convert it to plain text and save it
as `cover_letter_example.md` at the repo root (a heading plus the letter).
`apply_packs.py` and `prep_pack.py` include it in their system prompt as a
voice sample, with an instruction to imitate the voice and never reuse its
claims.

## 3. projects.md

Replace the three example entries with the person's real projects (from the
resume, the cover letter, and anything they told you), in the same shape. If
they have none, write "No standalone projects yet." under the heading and
nothing else. The pack critic needs profile + projects + resumes to total
8,000 characters; say so if they are under it.

## 4. companies.yaml

The template ships a verified list of ~60 company job boards grouped by ATS,
title-filter lists tuned over months, and a `deadlines:` block of well-known
programs with no dates. Three edits:

1. **Companies.** Keep every board whose company fits the person's
   `industries`; move the rest under a `retired:` note rather than deleting
   (the slug is still worth keeping). For each name in `target_companies`
   that is not already listed, run `python fetch_jobs.py discover "<name>"`,
   read the output, and add the board it found under the right group with
   `display_name`, `tier`, `category` (one of `defense`, `product`,
   `consulting`, `vc` — this decides which resume variant the person is shown
   for that company) and a one-line `note`. A board with exactly one role is
   suspect; a Greenhouse hit on a generic slug may be a demo board. Never add
   a board you did not see return real postings.
2. **Title filters.** Rewrite `title_include` from `job_types` (topic words,
   word-boundary matched), `title_exclude` from `excluded`, and leave
   `title_senior`, `title_level` and `title_protect` as they are unless a
   job type needs a protected phrase (e.g. "Chief of Staff" contains
   `staff`). Run `python test_filters.py` after every change and keep it
   green; add a test for each new include/exclude term.
3. **Deadlines.** For each entry in `programs`, search the firm's own site for
   the current cycle's window and fill `opens`, `closes`, `status`,
   `confidence` (`verified` only if read from the firm's site today;
   otherwise `secondary-source` or `historical-estimate`), `source` (the URL
   you read), `verified` (today's date) and `class_year` (from
   `graduation`). Keep at least ten entries. Set `rolling: true` on any
   program that is open until filled; those become the daily
   "consulting_open" nag until something is submitted. Delete example
   entries the person does not care about only if ten remain.

## 5. config.yaml

- `cost.cap_reset`: today's date-time in ISO 8601 with timezone.
- `cost.monthly_cap`: what the person said; `10.00` if they did not.
- `preferences`: `graduation_year` from `graduation`; `preferred_metros`,
  `home_metro`, `remote_acceptable`, `salary_min` from inputs. Metro codes
  must exist in `web/lib/geo.js` `METROS`; add a metro there (code, label,
  city keywords) if theirs is missing, and run `node test_prefs.mjs` from
  `web/` afterwards.
- `notifications.from`: an address on a domain they have verified in Resend,
  or leave the placeholder and set `notifications.enabled: false` until they
  have one. The recipient is never configured here; it is `owner.email`.
- Everything else stays.

Also update `web/lib/constants.js` `USER_TZ` if `timezone` is not
`America/Los_Angeles`.

## 6. daily.yaml

Replace the starter items with three to five things this person should do in
their first week, in the same shape (`text`, `why`, `due`, `minutes`,
`steps`). Due dates are real dates within 14 days.

## 7. Verify, then stop

```bash
python setup/check_setup.py          # no placeholders, every required field, counts
python test_filters.py
python test_resume_parity.py
python test_class_year.py
python test_nothing_private_staged.py
cd web && npm run build && cd ..     # prebuild bakes profile/config into the bundle
```

All green means the person's instance is ready to be deployed. **STOP HERE
and print the HUMAN checklist below.** Do not create repos, databases or
accounts on their behalf, and do not push anything.

## HUMAN — the four things only you can do

1. **GitHub.** Create a **private** repository (the template is public; your
   copy must not be — it holds your resume). Push this folder to it. The
   default branch is `main`.
2. **Neon.** Create a project; copy both connection strings (pooled, host
   contains `-pooler`, and direct). Put them in `.env` as `DATABASE_URL` and
   `DATABASE_URL_UNPOOLED`. See HOSTING.md.
3. **Vercel.** Import the repo, Root Directory `web`, add env vars
   `DATABASE_URL` (pooled), `JOBOPS_PASSWORD` (pick one), optionally
   `JOBOPS_ANTHROPIC_KEY` (Ask box) and `JOBOPS_IMPORT_TOKEN` (for a bot).
   Deploy.
4. **GitHub Actions secrets** on your repo: `DATABASE_URL_UNPOOLED`,
   `ANTHROPIC_API_KEY`; optionally `RESEND_API_KEY`, `NEON_API_KEY`. Add a
   repository **variable** `JOBOPS_BASE_URL` = your Vercel URL. Then Actions
   → daily → Run workflow. Green run + "Updated just now" on the Daily page
   means it works.

After that, tell Claude Code "deployed" and it will walk you through the
first week: running the first scoring batch under the cap, confirming your
application windows, and adding the first five contacts.
