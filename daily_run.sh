#!/usr/bin/env bash
# Daily loop, by hand. The scheduled one runs on GitHub Actions now
# (.github/workflows/daily.yml) so it does not need this laptop to be awake.
#
# Fetch and gate are free; only newly-gated roles get scored.
# Projected: ~$1.91/month at 20 new roles/day (Haiku, Batch API, 1 sample).
#
# The cap check that used to live here has been DELETED, not moved. It was a
# second, hand-written implementation of the cost estimate — it priced a
# calendar month while the meter prices from cap_reset, and it could disagree
# with the run it was guarding. `score_jobs.py score` refuses on its own, in the
# code that actually spends, and prints the same block whether or not it sends.
# An estimate that can disagree with the run is decoration.
set -euo pipefail
cd "$(dirname "$0")"

python fetch_jobs.py fetch
python score_jobs.py gate

python score_jobs.py score --model claude-haiku-4-5-20251001 --samples 1
python verify_deadlines.py | head -20
