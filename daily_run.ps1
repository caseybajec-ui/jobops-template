<#
    daily_run.ps1 — the whole daily loop. Registered with Windows Task Scheduler.

    Designed to FAIL QUIETLY. A laptop asleep at 07:00, or no network, or an
    already-running copy, must all end in "skip and try tomorrow" — never a
    dialog, never a double-run, never a half-written database.

    Verify it is firing:
        Get-ScheduledTaskInfo -TaskName JobOpsDaily     # LastRunTime, LastTaskResult
        Get-Content $HOME\OneDrive\Desktop\jobops\logs\daily.log -Tail 30

    LastTaskResult 0 means the script ran to completion. A skip is also 0 — the
    log says which, and Daily shows a "last updated" stamp so stale data cannot
    masquerade as fresh.
#>

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log  = Join-Path $logDir "daily.log"
$lock = Join-Path $PSScriptRoot ".daily.lock"

function Write-Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
}

# --- single instance ------------------------------------------------------
# A stale lock from a killed run would block every future run, so a lock older
# than three hours is treated as abandoned rather than respected forever.
if (Test-Path $lock) {
    $age = (Get-Date) - (Get-Item $lock).LastWriteTime
    if ($age.TotalHours -lt 3) {
        Write-Log "SKIP: another run started $([int]$age.TotalMinutes)m ago"
        exit 0
    }
    Write-Log "WARN: clearing a stale lock ($([int]$age.TotalHours)h old)"
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType File -Path $lock -Force | Out-Null

try {
    # --- network ----------------------------------------------------------
    # No network is the normal case for a laptop that woke up on a train. Skip.
    $up = $false
    try {
        $up = Test-Connection -ComputerName "boards-api.greenhouse.io" -Count 1 -Quiet -ErrorAction SilentlyContinue
    } catch { $up = $false }
    if (-not $up) {
        try {
            $null = Invoke-WebRequest -Uri "https://boards-api.greenhouse.io" -Method Head -TimeoutSec 15 -UseBasicParsing
            $up = $true
        } catch { $up = $false }
    }
    if (-not $up) {
        Write-Log "SKIP: no network"
        exit 0
    }

    Write-Log "START"

    # --- fetch + gate: always free ---------------------------------------
    & python fetch_jobs.py fetch 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Log "fetch  | $_" }
    & python score_jobs.py gate   2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Log "gate   | $_" }

    # --- score: reachable roles only, and only inside the cap ------------
    # The cap check lives in Python so there is one implementation, not two.
    $capOk = & python -c @"
import sys
sys.path.insert(0, '.')
import re, sqlite3
from score_jobs import est_cost, MONTHLY_CAP
from fetch_jobs import db
con = db(); con.row_factory = sqlite3.Row
since = '1970-01-01'
try:
    with open('config.yaml', encoding='utf-8') as f:
        m = re.search(r\"cap_reset:\s*'?([0-9T:+\-]{10,})'?\", f.read())
    if m: since = m.group(1)
except OSError:
    pass
SHAPE = {'triage': (1080, 30), 'score': (4100, 455)}
spent = sum(est_cost(b['model'], b['n'], *SHAPE.get(b['stage'], (2000, 300)), batch=True)
            for b in con.execute('SELECT * FROM batches')
            if (b['submitted_at'] or '') >= since)
print('OVER' if spent >= MONTHLY_CAP else 'OK')
print('%.2f' % spent)
"@ 2>&1

    if ($capOk -match "OVER") {
        Write-Log "SKIP scoring: at the monthly cap. Fetch and gate already ran and cost nothing."
    } else {
        & python score_jobs.py score --model claude-haiku-4-5-20251001 --samples 1 --reachable-only 2>&1 |
            Select-Object -Last 4 | ForEach-Object { Write-Log "score  | $_" }
    }

    # --- free upkeep ------------------------------------------------------
    Write-Log "DONE"
}
catch {
    # Quietly. A failure here is tomorrow's problem, not a dialog box today.
    Write-Log ("ERROR: " + $_.Exception.Message)
    exit 0
}
finally {
    Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
