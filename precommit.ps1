param([switch]$Full)

# Run the same checks the git hooks run, by hand.
#
# The hooks are the real gates (git config core.hooksPath .githooks). This is
# here for when you want to check before staging, or to see why one refused.
#
#   .\precommit.ps1          the FAST gate only — what runs on commit (~2 min)
#   .\precommit.ps1 -Full    fast AND slow — what runs on commit and on PUSH (~5.5 min)
#
# THE SUITE IS SPLIT because 56% of its time was the browser stages and the
# build that exists only to serve them. Measured 2026-09-03: overflow 100s,
# build 36s, tour 28s, controls 23s against 2m6s for everything else. Push is
# the boundary, because a push is what Vercel deploys from.
#
# One implementation, in .githooks/, so this and the hooks can never drift.
#
# WHY IT LOOKS FOR sh INSTEAD OF JUST CALLING IT. This script used to be a bare
# `& sh .githooks/pre-commit`, and from a plain PowerShell prompt — the shell
# CLAUDE.md names as primary — that has never once run:
#
#   The term 'sh' is not recognized as the name of a cmdlet ...
#
# Git for Windows does not put its sh.exe on PATH. `git commit` finds it because
# git invokes hooks through its own bundled shell; nothing else does. So the
# gate worked and the documented way to run the gate by hand did not, which is
# the worst arrangement of the two: the only way to run the checks was to
# attempt the commit and let it be refused.
#
# It is resolved from the git executable rather than hardcoded, because a
# hardcoded "C:\Program Files\Git\bin\sh.exe" is right on this laptop and wrong
# on a machine with git installed anywhere else — and it would fail with the
# same unhelpful message.

$ErrorActionPreference = "Stop"

$git = (Get-Command git -ErrorAction SilentlyContinue)
if (-not $git) {
    Write-Host "git is not on PATH, so I cannot find the shell its hooks run in." -ForegroundColor Red
    exit 1
}

# C:\Program Files\Git\cmd\git.exe -> C:\Program Files\Git
$gitRoot = Split-Path (Split-Path $git.Source)
$sh = $null
foreach ($c in @(
    (Join-Path $gitRoot "bin\sh.exe"),
    (Join-Path $gitRoot "usr\bin\sh.exe"),
    (Join-Path $gitRoot "bin\bash.exe")
)) {
    if (Test-Path $c) { $sh = $c; break }
}
# A `sh` already on PATH (WSL, MSYS, Cygwin) is fine too, and is tried last so
# the shell git itself uses wins — the hook is written against that one.
if (-not $sh) {
    $onPath = (Get-Command sh -ErrorAction SilentlyContinue)
    if ($onPath) { $sh = $onPath.Source }
}
if (-not $sh) {
    Write-Host "No POSIX shell found. Looked under $gitRoot and on PATH." -ForegroundColor Red
    Write-Host "The hook is a /bin/sh script; without a shell it cannot be run by hand." -ForegroundColor Red
    exit 1
}

& $sh ".githooks/pre-commit"
if ($LASTEXITCODE -eq 0 -and $Full) {
    Write-Host ""
    & $sh ".githooks/pre-push"
}
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "checks failed - do not commit" -ForegroundColor Red
    exit $LASTEXITCODE
}
Write-Host ""
Write-Host "all checks passed" -ForegroundColor Green
