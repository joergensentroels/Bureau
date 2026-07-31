# Start Bureau with the right posture for THIS machine's deployment.
#
# Why this script exists: Bureau is served on the tailnet permanently (`tailscale serve` proxies
# https://<host>.ts.net:8443 -> 127.0.0.1:4173), which means the control surface is ALWAYS remotely
# reachable. BUREAU_REMOTE is the guard for that, and it was living only in whatever shell happened to
# start the process — so `node server.mjs` by hand silently produced an unguarded server on a live public
# hostname. A safety posture that disappears on restart, without saying so, is the failure mode this
# whole codebase keeps trying to eliminate.
#
# So: remote mode is the DEFAULT here, and turning it off is the thing you have to type.
#
#   .\Start-Bureau.ps1              # remote-safe (BUREAU_REMOTE=1) — hard-floor actions must be
#                                   # approved in Latch/Compass, not from Bureau's UI. Denying still works.
#   .\Start-Bureau.ps1 -Local       # no remote guard. Only for a machine that is NOT reachable off-host.
#   .\Start-Bureau.ps1 -Foreground  # run in this window instead of detached (Ctrl+C to stop)
[CmdletBinding()]
param(
  [switch]$Local,
  [switch]$Foreground,
  [int]$Port = 4173
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Refuse to start a second one rather than fail confusingly on EADDRINUSE.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $owner = Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue
  Write-Host "Port $Port is already served by pid $($busy.OwningProcess) ($($owner.ProcessName)). Stop it first:" -ForegroundColor Yellow
  Write-Host "  Stop-Process -Id $($busy.OwningProcess) -Force"
  exit 1
}

if ($Local) {
  Remove-Item Env:\BUREAU_REMOTE -ErrorAction SilentlyContinue
} else {
  $env:BUREAU_REMOTE = "1"
}
$env:BUREAU_PORT = "$Port"

# Say plainly whether this machine is exposing Bureau, and whether the guard matches. Getting this pair
# wrong is the only way this script can hurt you, so it is reported rather than assumed.
$tsExe = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tsExe) { $tsExe = "C:\Program Files\Tailscale\tailscale.exe" }
$served = $false
if (Test-Path $tsExe) {
  $serveTxt = (& $tsExe serve status 2>&1) -join "`n"
  $served = $serveTxt -match "127\.0\.0\.1:$Port"
  if ($served) {
    $host_ = ((& $tsExe status --json 2>$null | ConvertFrom-Json).Self.DNSName).TrimEnd(".")
    Write-Host "Reachable off this machine at https://${host_}:8443 (tailnet only)" -ForegroundColor Cyan
  }
}

if ($Local -and $served) {
  Write-Host "WARNING: -Local disables the remote guard, but tailscale IS serving this port." -ForegroundColor Red
  Write-Host "         Anyone on the tailnet with the operator token could approve shell/api_call from the UI." -ForegroundColor Red
  Write-Host "         Re-run without -Local unless you have a specific reason." -ForegroundColor Red
} elseif ($Local) {
  Write-Host "Remote guard OFF (-Local). Not tailnet-served, so loopback only." -ForegroundColor Yellow
} else {
  Write-Host "Remote guard ON: hard-floor actions must be decided in Latch/Compass. Denying works from Bureau." -ForegroundColor Green
}

if ($Foreground) {
  & node (Join-Path $here "server.mjs")
} else {
  $log = Join-Path $here "bureau.log"
  # `server.mjs` relative, NOT the absolute path: this repo lives under "Documents\LLM server", and
  # Start-Process splits -ArgumentList on the space, so the absolute form launched node with
  # "C:\Users\troel\Documents\LLM" and it died with MODULE_NOT_FOUND. -WorkingDirectory makes the relative
  # name unambiguous and sidesteps quoting entirely. (Redirect paths are values, not command lines, so
  # spaces are fine there.)
  $p = Start-Process -FilePath "node" -ArgumentList "server.mjs" `
    -WorkingDirectory $here -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
    -PassThru -WindowStyle Hidden
  Start-Sleep -Seconds 3
  Write-Host "Bureau started (pid $($p.Id)) -> http://127.0.0.1:$Port   log: $log"
  Write-Host "Stop it with:  Stop-Process -Id $($p.Id) -Force"
}
