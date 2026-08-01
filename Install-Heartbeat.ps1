# Register the dead-man's switch as a repeating SYSTEM scheduled task.
#
# What this covers that nothing else does: Bureau's notify.webhook only fires from inside a finishing
# run, so a crashed server, a failed boot or a dead Ollama sends NOTHING -- and that silence looks
# exactly like "no runs happened". tools\heartbeat.mjs proves the model can still produce a token and
# reports that outward; if the reports stop, the external watcher is what alerts you.
#
#   .\Install-Heartbeat.ps1 -Url https://hc-ping.com/<uuid>    # writes the config, registers the task
#   .\Install-Heartbeat.ps1 -Verify                            # run it once now and show the result
#   .\Install-Heartbeat.ps1 -Uninstall
#
# Must run ELEVATED: a standard user cannot register (or even enumerate) a SYSTEM task.
#
# If it fails with UnauthorizedAccess, this machine's LocalMachine execution policy is Restricted, which
# blocks every .ps1 regardless of signing. Use a per-process bypass -- it does not change machine policy:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<this path>"
#
# NOTE this file is deliberately pure ASCII. PS 5.1 reads a BOM-less .ps1 as CP1252, so a UTF-8 dash
# decodes to three characters ending in 0x94 -- a right double quote -- which closes whatever string it
# is in and spills the rest of the line out as code.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Url,
  [int]$EveryMinutes = 15,
  [switch]$Verify,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$latch = Join-Path (Split-Path -Parent $here) "openclaw-command-center"
$taskName = "LLMServer-Heartbeat"
$cfgPath = Join-Path $here "heartbeat.local.json"

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Uninstall) {
  if (-not (Test-Elevated)) { Write-Host "Run elevated to unregister a SYSTEM task." -ForegroundColor Yellow; exit 1 }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    if ($PSCmdlet.ShouldProcess($taskName, "Unregister")) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      Write-Host "  unregistered $taskName"
    }
  } else { Write-Host "  $taskName was not registered" }
  Write-Host "  $cfgPath left in place (delete it yourself to remove the ping URL)."
  exit 0
}

if ($Verify) {
  if (-not (Test-Path $cfgPath)) { Write-Host "No $cfgPath -- run with -Url first." -ForegroundColor Yellow; exit 1 }
  Write-Host "Running the heartbeat once, in the foreground:" -ForegroundColor Cyan
  $env:LATCH_DATA = Join-Path $latch "data"
  & node (Join-Path $here "tools\heartbeat.mjs")
  $code = $LASTEXITCODE
  Write-Host ""
  switch ($code) {
    0 { Write-Host "  exit 0 -- HEALTHY, success ping sent. Confirm the watcher shows it as up." -ForegroundColor Green }
    1 { Write-Host "  exit 1 -- UNHEALTHY. A /fail was sent, so the watcher should be alerting now." -ForegroundColor Yellow }
    2 { Write-Host "  exit 2 -- could not report at all. The URL or outbound network is the problem." -ForegroundColor Red }
    default { Write-Host "  exit $code -- unexpected." -ForegroundColor Red }
  }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    $info = Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo
    Write-Host ""
    Write-Host ("  task: last={0} result={1} next={2}" -f $info.LastRunTime, $info.LastTaskResult, $info.NextRunTime)
    if ($info.LastRunTime.Year -le 1999) { Write-Host "  the TASK has never run -- only the foreground check above is proven." -ForegroundColor Yellow }
  } else {
    Write-Host "  task $taskName is NOT registered -- nothing is running this on a schedule yet." -ForegroundColor Yellow
  }
  exit $code
}

if (-not $Url) { Write-Host "Usage: .\Install-Heartbeat.ps1 -Url https://hc-ping.com/<uuid>" -ForegroundColor Yellow; exit 1 }
if ($Url -notmatch '^https?://') { Write-Host "Url must be an http(s) URL." -ForegroundColor Red; exit 1 }
if (-not (Test-Elevated)) { Write-Host "Run elevated: a standard user cannot register a SYSTEM task." -ForegroundColor Yellow; exit 1 }

# Write the config WITHOUT a BOM. Set-Content/Out-File add a UTF-8 BOM in PS 5.1 and JSON.parse rejects a
# leading U+FEFF -- that is exactly why Latch silently ignored notifications.json for weeks.
$json = (@{ url = $Url } | ConvertTo-Json -Compress)
if ($PSCmdlet.ShouldProcess($cfgPath, "Write ping URL (gitignored)")) {
  [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  wrote $cfgPath (gitignored -- the ping URL is a bearer secret)"
}

$ps = (Get-Command powershell.exe).Source
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { Write-Host "node.exe is not on PATH for this shell; the task needs it." -ForegroundColor Red; exit 1 }

# Same explicit-env reasoning as Install-Autostart.ps1: a SYSTEM account's homedir is
# C:\Windows\system32\config\systemprofile, so LATCH_DATA must be passed or the token cannot be found.
$sysEnv = "`$env:LATCH_DATA='$latch\data';"
# Rotate at 1 MB, keep one generation. SilentlyContinue: a locked log must never stop the check running.
$rot = "if((Test-Path heartbeat.log) -and (Get-Item heartbeat.log).Length -gt 1mb){Move-Item heartbeat.log heartbeat.log.1 -Force -ErrorAction SilentlyContinue};"
# All streams to ONE file is safe here because it is a single *>> redirection. Two separate redirections
# to the same file (2>>x 6>>x) fail -- PowerShell opens a handle per redirection and the second hits the
# first's lock, exiting 1 BEFORE the command runs. That took both servers down once, leaving a 0-byte log.
$inner = "$rot $sysEnv node tools\heartbeat.mjs *>>heartbeat.log"

$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$inner`"" -WorkingDirectory $here
# Repeat forever from now. Also fire at startup, so a reboot does not wait out the interval.
$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$t2 = New-ScheduledTaskTrigger -AtStartup
$t2.Delay = "PT90S"   # let Ollama/Latch/Bureau (0s/20s/40s) come up first, else the first check fails spuriously
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
# A FINITE job, so the settings mirror the daily backup rather than the servers: a short execution limit
# (a hung check should be killed) and NO restart-on-failure -- the next interval IS the retry, and an
# unhealthy result is a legitimate non-zero exit, not something to retry five times.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

if ($PSCmdlet.ShouldProcess($taskName, "Register repeating task as SYSTEM every $EveryMinutes min")) {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($t1, $t2) -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "  registered $taskName (every $EveryMinutes min, +90s after boot, as SYSTEM)"
  Write-Host ""
  Write-Host "Now prove it end to end -- registering is not evidence:" -ForegroundColor Cyan
  Write-Host "  .\Install-Heartbeat.ps1 -Verify"
  Write-Host "  Start-ScheduledTask -TaskName $taskName    # then check the watcher shows a ping"
  Write-Host ""
  Write-Host "Set the watcher's expected period LONGER than $EveryMinutes min (e.g. $($EveryMinutes*2) min) or" -ForegroundColor Yellow
  Write-Host "one slow check will page you for nothing." -ForegroundColor Yellow
}
