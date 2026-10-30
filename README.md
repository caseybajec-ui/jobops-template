# JobOps

A daily briefing for one job search. It polls the public job boards of the companies you
name, filters and scores what it finds against a profile of you, tracks the application
windows no board exposes (consulting, VC, big-tech APM programmes), and hands you one
thing to do each morning. It drafts; you apply. It never submits an application, never
scrapes a site whose terms forbid it, and never emails anyone but you. Steady-state cost
is cents a month: fetching, gating, the UI and the tracker are free, and the only model
call is a Haiku batch over the handful of new roles each day.

```
cd web && npm run dev      →  http://localhost:3311
```

**New here? Read `setup/SETUP.md`.** It is a one-shot setup with Claude Code: it builds
`profile.json` from your resume, drops your two resume PDFs in, re-tunes the title
filters for your job types, and writes your own numbers into `config.yaml`. Nothing in
this repo carries a personal fact as a literal — `owner.py` (Python) and the `OWNER`
export of `web/lib/config.generated.js` (web) read everything from `profile.json`.

---

# The views

| View | What it is for |
|---|---|
| **Daily** (`/`) | The only screen to open daily. What to do today, in priority order. Manual items first, because the tool's blind spots outrank what it can see. Carries a freshness stamp. |
| **Companies** (`/companies`) | Where to build relationships. Two bands: companies that hire your profile, and companies being watched. The primary view for anything that can't start until you graduate. |
| **Inbox** (`/inbox`) | Everything out there, ranked. Defaults to roles a new grad can get; experienced roles are behind a toggle as networking intelligence. |
| **Forecast** (`/forecast`) | When each company posts dated roles. **Deliberately weak** — only Ashby and Rippling give real publish dates, and there is little observation history. It becomes meaningful after a season of cron runs. |

---

# The daily loop

`.github/workflows/daily.yml` runs every morning on GitHub Actions: bake the config,
apply migrations, fetch every board, run the deterministic gate, score the new
reachable roles, check the watched careers pages, verify deadlines, and send the
digest. It needs two repository secrets — `DATABASE_URL_UNPOOLED` (the DIRECT Neon
string) and `ANTHROPIC_API_KEY` — plus `RESEND_API_KEY` if you want the email. Trigger
it by hand from the Actions tab the first time rather than waiting for tomorrow.

Because the failure mode is *silently old data*, **Daily shows a freshness stamp** —
grey when current, red reading "LAST UPDATED n DAYS AGO" when the run has not fired.
Stale data that looks live is the worst outcome here.

Manual, when needed:

```
python fetch_jobs.py fetch        # poll every board (free)
python score_jobs.py gate         # deterministic filters (free)
python score_jobs.py score --dry-run   # what a scoring run would cost, before it spends
python score_jobs.py score        # Haiku, Batch API, reachable roles only
python score_jobs.py cost         # spend against the cap
python verify_deadlines.py        # what needs a human
python gap_themes.py --min 40     # what to fix, not what to click
python contacts.py due            # who needs a touch
```

---

# Cost rules

**The monthly cap is `cost.monthly_cap` in `config.yaml`**, and it is read from there by
both the scorer (which refuses before submitting a batch that would pass it) and the
meter in the app header. Set `cost.cap_reset` to the day you deploy.

1. **Never re-score the corpus.** It is scored. New arrivals only. Validate any prompt
   change on a 50-role sample and apply it going forward.
2. **Ask before anything over $1.** `score --dry-run` prints the real number first.
3. **One model scores everything.** If the model changes, everything re-scores or
   nothing does — two models over overlapping populations produced two incomparable
   scales and a ranking that put a 54 above an 82. The scorer refuses to mix them.
4. **Haiku is the scorer.** Validated against Sonnet: Spearman +0.82 overall, 9/10
   top-10 overlap, at a fraction of the price.
5. **Batch API always.** Synchronous is double for the same result. The one exception
   is the read-only Ask box, capped at 30 questions a month.

Fetching, gating, the UI, the tracker, outreach drafting, networking targets and gap
analysis are all **free**. Scoring is the only line item.

---

# Why things are the way they are

Short version; `CLAUDE.md` has the full reasoning and the rules that came out of it.

- **No LLM triage stage.** The original had one. It saved about a dollar and deleted
  real opportunities permanently. A deterministic gate kills only on things it can
  prove; everything else goes to the scorer, where a wrong call is a low score at the
  bottom of a list rather than a deletion.
- **Fail open, always.** An ambiguous verdict passes to the next stage. Passing junk
  costs a fraction of a cent; dropping a real role costs the role.
- **If code can decide it, code decides it.** Handing a model an integer and asking it
  to compare against a constant got 2 ≥ 3 wrong on 5% of kills.
- **Never delete before the replacement is confirmed.** A re-score that failed after
  the old rows were cleared left 204 roles unscored.
- **Deadlines carry a confidence label, and a tracker's date is a prompt to check.**
  A note that said MBB "typically closes mid/late September" was wrong by six weeks and
  would have cost a cycle. Every row in `deadlines:` ships unconfirmed until you read
  the firm's own page.
- **Colour means urgency and nothing else.** Scores are grey bars whose length carries
  the magnitude. If the accent appears, something needs doing.
- **Never manufacture a connection.** Outreach drafts state only what is literally
  true about the relationship. Cadence stops at two.
- **Never claim clearance eligibility.** An adjudicator decides that, not a candidate.

# Files

`fetch_jobs.py` boards → Neon Postgres · `classify.py` deterministic classification ·
`score_jobs.py` gate, score, rank, cost · `companies.yaml` boards + title filters +
deadlines · `profile.json` source of truth for every claim about you · `projects.md`
what you have built · `web/public/resume/resume-tech.pdf` and `resume-finance.pdf` the
two resumes, converted to `resume_tech.md` / `resume_finance.md` by `resume_from_pdf.py`
(never hand-edit the markdown) · `contacts.py` / `outreach.py` people · `daily.yaml` seed
items · `manual_jobs.yaml` roles no board exposes · `config.yaml` cap, plan, targets,
preferences, notifications · `web/` the interface · `test_filters.py` run before
committing any filter change · `HOSTING.md` Neon + Vercel + Actions walkthrough ·
`setup/SETUP.md` the one-shot setup.
