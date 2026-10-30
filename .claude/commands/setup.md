Set up this JobOps clone for the person you are talking to. Follow `setup/SETUP.md` literally,
in order, and stop where it says to stop.

Procedure:
1. Read `setup/SETUP.md`, then `CLAUDE.md` (its hard rules bind you), then `profile.example.json`.
2. If `setup/inputs.yaml` does not exist, write it in the shape of `setup/inputs.example.yaml`
   from what the person has told you in this conversation, show it to them, and ask only about
   fields that are missing or ambiguous. Confirm `setup/resume.pdf` (or `resume-tech.pdf` and
   `resume-finance.pdf`) and `setup/cover_letter_example.*` are present; if not, ask for them.
3. Run `python setup/apply_inputs.py --check`, then `python setup/apply_inputs.py`. It writes
   config.yaml, the profile skeleton, the resume files and the cover letter sample
   deterministically. Fix whatever it refuses and run it again.
4. Do SETUP.md step 1's judgment half: replace the `_todo` key in `profile.json` with real
   `evidence`, `skills`, `activities`, `interests`, `voice_notes` from the resume. Never invent a
   number, employer, title or outcome. Then steps 3 (projects.md), 4 (companies.yaml: prune by
   industry, `discover` each target company, rewrite title filters, look up program windows with
   sources), and 6 (daily.yaml).
5. Run every check in SETUP.md step 7 and show the results. `python setup/check_setup.py` must
   say "ready". Fix, do not skip.
6. Print the HUMAN checklist from SETUP.md and stop. Do not create accounts, repositories,
   databases or deployments, and run nothing that spends money.

Arguments: $ARGUMENTS
