# Make Bureau, Latch and Ollama survive an unattended reboot.
#
# THE PROBLEM this fixes: all three live in the per-user Startup folder, which only fires after an
# INTERACTIVE logon. This machine has no auto-login, so a reboot stops at the lock screen and all three
# stay down — unreachable remotely, with no way to start them remotely either. Tailscale is a real service
# and keeps running, so the symptom is a 502 from a hostname that resolves fine, which looks like an app
# crash rather than "nothing ever started".
#
# THE FIX: Scheduled Tasks with an At-Startup trigger running as SYSTEM. SYSTEM needs no stored password
# and does not need anyone logged in.
#
# DELIBERATELY NOT auto-login. That is the other way to solve this and it means putting the account
# password in the registry (or an LSA secret) and leaving the desktop unlocked on boot — a physical-security
# trade for a remote-availability gain. That is the operator's call to make knowingly, not a default, and
# handling the password is not something this script will do.
#
# RUN IT LIKE THIS. This machine's LocalMachine execution policy is Restricted, which blocks every .ps1
# regardless of signing, so `.\Install-Autostart.ps1` fails with UnauthorizedAccess. The -ExecutionPolicy
# flag is per-process — it does NOT change the machine's policy, which is the point: a persistent policy
# change is a security decision and this script does not need one.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<this path>"              # install (ELEVATED shell)
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<this path>" -WhatIf      # preview, change nothing
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<this path>" -Uninstall   # remove the tasks
#
# The boot tasks this creates already pass -ExecutionPolicy Bypass themselves, so Restricted does not
# affect them at startup — it only gets in the way of running this installer by hand.
[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$Uninstall, [switch]$Verify)

$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path        # ...\bureau
$root    = Split-Path -Parent $here                              # ...\LLM server
$latch   = Join-Path $root "openclaw-command-center"
$prefix  = "LLMServer-"
$tasks   = @("$prefix`Ollama", "$prefix`Latch", "$prefix`Bureau", "$prefix`Backup")

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIfPreference) {
  # Print the invocation that WORKS. This used to print `.\Install-Autostart.ps1`, which is exactly the
  # form that fails on this machine (LocalMachine policy is Restricted) — a failure message handing back
  # the broken command. The header comment had the right form, but nobody reads a header while looking at
  # an error.
  # Echo back the mode that was ACTUALLY asked for. This message used to always print the install form, so
  # someone who ran -Verify or -Uninstall unelevated was handed a command that INSTALLS — a failure message
  # that talks you into a different action than the one you attempted.
  $self = $MyInvocation.MyCommand.Path
  $mode = if ($Verify) { " -Verify" } elseif ($Uninstall) { " -Uninstall" } else { "" }
  $what = if ($Verify) { "reading SYSTEM tasks" } elseif ($Uninstall) { "removing SYSTEM tasks" } else { "SYSTEM tasks and boot triggers" }
  Write-Host "This needs an elevated shell ($what is admin-only)." -ForegroundColor Yellow
  Write-Host "Right-click PowerShell -> Run as administrator, then paste:" -ForegroundColor Yellow
  Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`"$mode"
  if (-not $mode) {
    Write-Host ""
    Write-Host "Preview without elevation:" -ForegroundColor DarkGray
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$self`" -WhatIf" -ForegroundColor DarkGray
  }
  Write-Host "(-ExecutionPolicy is per-process; it does not change this machine's policy.)" -ForegroundColor DarkGray
  exit 1
}

# -Verify is the POST-REBOOT checklist. A standard user cannot even enumerate a task that runs as SYSTEM
# (Get-ScheduledTask returns nothing, Start-ScheduledTask says Access denied), so this has to run elevated
# — which is also why the install cannot be checked from an unprivileged session.
#
# The check that actually matters is the PROCESS OWNER. If node is owned by SYSTEM, the task started it; if
# it is owned by troel, the Startup shortcut did, and the reboot proved nothing.
if ($Verify) {
  # THREE outcomes, not two. The first version tracked only pass/fail and printed "ALL GOOD" while every
  # process-owner line was a warning — a green verdict that contradicted its own checks, in the script whose
  # only job is to say whether this worked. Before a reboot, processes owned by a logged-on user are EXPECTED,
  # so that is neither a pass nor a failure: it is NOT YET PROVEN. Conflating "nothing is broken" with
  # "the thing I was built to demonstrate has been demonstrated" is how a checklist becomes decoration.
  $fail = @(); $unproven = @()
  Write-Host "--- tasks ---"
  $found = Get-ScheduledTask "$prefix*" -ErrorAction SilentlyContinue
  if (-not $found) { Write-Host "  none visible. Either they are not installed, or this shell is not elevated." -ForegroundColor Red; $fail += "no tasks visible" }
  # $tasks.Count, not a literal: this check sat two lines from the list it counts and would have gone
  # stale the moment a fourth task was added — which is exactly what then happened.
  if ($found.Count -lt $tasks.Count) { $fail += "expected $($tasks.Count) tasks, found $($found.Count)" }
  foreach ($t in $found) {
    $i = $t | Get-ScheduledTaskInfo
    # LastTaskResult 267009 = "currently running", which is the healthy steady state for a server.
    $res = switch ($i.LastTaskResult) { 0 { "ok" } 267009 { "running" } 267011 { "not yet run" } default { "result=$($i.LastTaskResult)" } }
    Write-Host ("  {0,-20} {1,-8} as={2,-8} lastRun={3,-9} {4}" -f $t.TaskName, $t.State, $t.Principal.UserId,
      $(if ($i.LastRunTime.Year -gt 1999) { $i.LastRunTime.ToString("HH:mm:ss") } else { "never" }), $res)
    if ($i.LastRunTime.Year -le 1999) { $unproven += "$($t.TaskName) has never run" }
    if ($t.State -eq "Disabled") { $fail += "$($t.TaskName) is disabled" }
  }
  Write-Host "`n--- who owns the running processes? (SYSTEM = the task started it; you = the Startup shortcut did) ---"
  foreach ($port in 11434, 8787, 4173) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { Write-Host ("  :{0,-6} NOT LISTENING" -f $port) -ForegroundColor Red; $fail += "port $port not listening"; continue }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
    $owner = try { $o = Invoke-CimMethod -InputObject $proc -MethodName GetOwner; "$($o.Domain)\$($o.User)" } catch { "?" }
    $isSystem = $owner -match "SYSTEM"
    Write-Host ("  :{0,-6} pid={1,-7} {2,-14} owner={3}" -f $port, $conn.OwningProcess, $proc.Name, $owner) -ForegroundColor $(if ($isSystem) { "Green" } else { "Yellow" })
    # Not a failure BEFORE a reboot — it is the expected state, and precisely what a reboot is meant to change.
    if (-not $isSystem) { Write-Host "         ^ started by a logged-on user, not the boot task" -ForegroundColor Yellow; $unproven += "port $port is owned by $owner, not SYSTEM" }
  }
  Write-Host "`n--- the two things a SYSTEM account gets wrong by default ---"
  try {
    $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 10
    $names = ($tags.models | ForEach-Object { $_.name }) -join ", "
    if ($tags.models.Count -gt 0) { Write-Host "  OLLAMA_MODELS resolved: $($tags.models.Count) model(s) - $names" -ForegroundColor Green }
    else { Write-Host "  Ollama is up but reports NO models - OLLAMA_MODELS is wrong for this account" -ForegroundColor Red; $fail += "Ollama reports no models" }
  } catch { Write-Host "  could not reach Ollama: $($_.Exception.Message)" -ForegroundColor Red; $fail += "Ollama unreachable" }
  try {
    $ps = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/ps" -TimeoutSec 10
    if (-not $ps.models -or $ps.models.Count -eq 0) {
      Write-Host "  no model loaded right now, so GPU use is unknown - run something, then re-check /api/ps" -ForegroundColor DarkYellow
      $unproven += "GPU use unverified (no model loaded)"
    }
    else { foreach ($m in $ps.models) {
        $vram = [int64]$m.size_vram
        Write-Host ("  {0}: size_vram={1:N0} bytes -> {2}" -f $m.name, $vram, $(if ($vram -gt 0) { "ON GPU" } else { "CPU ONLY (session-0 GPU problem)" })) -ForegroundColor $(if ($vram -gt 0) { "Green" } else { "Red" })
        if ($vram -le 0) { $fail += "$($m.name) is on CPU only" }
    } }
  } catch { Write-Host "  /api/ps unavailable: $($_.Exception.Message)" -ForegroundColor DarkYellow; $unproven += "GPU use unverified (/api/ps unavailable)" }
  $authPath = Join-Path $latch "data\auth.json"
  try {
    $t = (Get-Content $authPath -Raw | ConvertFrom-Json).operatorToken
    $w = Invoke-RestMethod -Uri "http://127.0.0.1:4173/api/whoami" -Headers @{ Authorization = "Bearer $t" } -TimeoutSec 10
    Write-Host "  LATCH_DATA resolved: Bureau authenticated (role=$($w.role), remote=$($w.remote))" -ForegroundColor Green
    if (-not $w.remote) { Write-Host "         ^ remote guard is OFF while the tailnet serves this port" -ForegroundColor Yellow }
  } catch { Write-Host "  Bureau did not authenticate - LATCH_DATA likely wrong for the account it runs as" -ForegroundColor Red; $fail += "Bureau did not authenticate" }

  Write-Host ""
  if ($fail.Count) {
    Write-Host "FAILED - these are real problems:" -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host "`n-Uninstall reverts to the Startup shortcuts." -ForegroundColor Red
    exit 1
  }
  if ($unproven.Count) {
    Write-Host "NOT YET PROVEN - nothing is broken, but the boot path has not been demonstrated:" -ForegroundColor Yellow
    $unproven | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host "`nThis is the expected state BEFORE a reboot: the tasks exist and are Ready, but the running" -ForegroundColor Yellow
    Write-Host "processes are still the ones your logon started. REBOOT, then run -Verify again." -ForegroundColor Yellow
    Write-Host "Do NOT delete the Startup shortcuts until every process shows owner=SYSTEM." -ForegroundColor Yellow
    exit 0   # not an error - just not evidence yet
  }
  Write-Host "PROVEN - all three run as SYSTEM after boot, models and token resolved." -ForegroundColor Green
  Write-Host "Safe to delete the Startup shortcuts now:" -ForegroundColor Green
  Write-Host "  Remove-Item `"$([Environment]::GetFolderPath('Startup'))\Start Bureau.lnk`",`"$([Environment]::GetFolderPath('Startup'))\Start Latch.lnk`",`"$([Environment]::GetFolderPath('Startup'))\Ollama.lnk`""
  exit 0
}

if ($Uninstall) {
  foreach ($t in $tasks) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      if ($PSCmdlet.ShouldProcess($t, "Unregister scheduled task")) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Host "  removed $t"
      }
    } else { Write-Host "  $t not present" }
  }
  Write-Host "`nDone. The per-user Startup shortcuts are untouched, so an interactive logon still starts everything."
  exit 0
}

# Sanity-check the layout before creating anything that claims to launch it.
$checks = @{
  "Bureau server.mjs"  = Join-Path $here "server.mjs"
  "Bureau launcher"    = Join-Path $here "Start-Bureau.ps1"
  "Latch server.js"    = Join-Path $latch "server.js"
  "Latch auth.json"    = Join-Path $latch "data\auth.json"
}
$missing = $checks.GetEnumerator() | Where-Object { -not (Test-Path $_.Value) }
if ($missing) {
  Write-Host "Refusing to install - these are missing:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  $($_.Key): $($_.Value)" -ForegroundColor Red }
  exit 1
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "node is not on PATH for this shell; a SYSTEM task needs its full path." -ForegroundColor Red; exit 1 }
$ollama = @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe", "$env:ProgramFiles\Ollama\ollama.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

Write-Host "node   : $node"
Write-Host "bureau : $here"
Write-Host "latch  : $latch"
Write-Host "ollama : $(if ($ollama) { $ollama } else { '(not found - skipping, see note below)' })`n"

# Everything a SYSTEM account cannot infer is passed EXPLICITLY. Both of these default to a path under
# os.homedir(), which for SYSTEM is C:\Windows\system32\config\systemprofile — so without them Bureau
# cannot find Latch's token (exits 1) and Ollama reports no models. This is the whole reason a naive
# "just make it a service" attempt fails on this machine.
$sysEnv = "`$env:LATCH_DATA='$latch\data'; `$env:OLLAMA_MODELS='$env:USERPROFILE\.ollama\models'; `$env:OLLAMA_HOST='127.0.0.1:11434';"

# A scheduled task captures NOTHING by default, which is why a 3am crash-and-restart left no trace. The
# servers now tee their own stdout to a rotating log, so what is redirected here is only what an
# in-process tee can never see:
#
#   stream 2 (errors)      PowerShell failures, and a native crash node dies too fast to log itself
#   stream 6 (Write-Host)  the launcher's own messages — "Port 4173 is already served by pid ...", the
#                          exact boot refusal you would otherwise have zero record of
#
# Stream 1 is deliberately NOT redirected: that is the servers' normal chatter, already captured WITH
# rotation by the in-process tee, and duplicating it here would grow a second file without bound.
# Ollama gets the same treatment mainly for its GPU-vs-CPU decision, which it reports on stderr.
#
# Rotated at task start rather than appended forever — one previous generation is kept, which is what
# you want after a restart loop. SilentlyContinue because a locked log must never stop a server booting.
$logRot = "if((Test-Path boot.log) -and (Get-Item boot.log).Length -gt 1mb){Move-Item boot.log boot.log.1 -Force -ErrorAction SilentlyContinue};"

function New-BootTask {
  param([string]$Name, [string]$Command, [string]$WorkDir, [int]$DelaySeconds = 0)
  $ps = (Get-Command powershell.exe).Source
  # boot.log RELATIVE, resolved against -WorkingDirectory: this repo lives under "LLM server", and a
  # quoted absolute path nested inside an already-quoted -Command is how the MODULE_NOT_FOUND bug in
  # Start-Bureau.ps1 happened. Relative sidesteps the quoting entirely.
  $inner = "$logRot $sysEnv $Command 2>>boot.log 6>>boot.log"
  $action  = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$inner`"" -WorkingDirectory $WorkDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  if ($DelaySeconds -gt 0) { $trigger.Delay = "PT$($DelaySeconds)S" }   # crude ordering: Ollama, then Latch, then Bureau
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  # Restart on failure and NO execution time limit: these are long-lived servers, and the default
  # 3-day limit would silently kill them. Restart matters because a boot-time start can lose a race with
  # disk/network readiness, and a task that fails once and stays dead is the bug we are fixing.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew
  if ($PSCmdlet.ShouldProcess($Name, "Register At-Startup task as SYSTEM")) {
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "  registered $Name"
  } else {
    Write-Host "  WOULD register $Name" -ForegroundColor Cyan
    Write-Host "      $ps -NoProfile -ExecutionPolicy Bypass -Command `"$inner`"" -ForegroundColor DarkGray
    Write-Host "      workdir=$WorkDir  as=SYSTEM  trigger=AtStartup$(if($DelaySeconds){" +${DelaySeconds}s"})" -ForegroundColor DarkGray
  }
}

# The backup is a FINITE job, so its settings are deliberately the opposite of the servers' on both
# counts: a one-hour execution limit (a hung backup should be killed, whereas killing a server is the
# bug we fixed), and no restart-on-failure (tomorrow's run is the retry; retrying a failing backup five
# times against a full disk just fills the log). Daily rather than hourly because the snapshot is 27 MB
# and the thing it protects against — a bad write, a wrong answer to "are you sure" — is not hourly.
#
# StartWhenAvailable matters on a laptop: a machine asleep at 03:30 would otherwise simply skip the day.
#
# All streams redirected here, unlike the servers: for a job that runs and exits, stdout IS the record —
# which snapshot was written, what it verified, what got pruned. Ten lines a day, rotated at 1 MB.
function New-DailyTask {
  param([string]$Name, [string]$Command, [string]$WorkDir, [string]$At)
  $ps = (Get-Command powershell.exe).Source
  $rot = "if((Test-Path backup.log) -and (Get-Item backup.log).Length -gt 1mb){Move-Item backup.log backup.log.1 -Force -ErrorAction SilentlyContinue};"
  $inner = "$rot $sysEnv $Command *>>backup.log"
  $action  = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$inner`"" -WorkingDirectory $WorkDir
  $trigger = New-ScheduledTaskTrigger -Daily -At $At
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  if ($PSCmdlet.ShouldProcess($Name, "Register daily task as SYSTEM at $At")) {
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Write-Host "  registered $Name (daily $At)"
  } else {
    Write-Host "  WOULD register $Name (daily $At)" -ForegroundColor Cyan
    Write-Host "      $ps -NoProfile -ExecutionPolicy Bypass -Command `"$inner`"" -ForegroundColor DarkGray
    Write-Host "      workdir=$WorkDir  as=SYSTEM" -ForegroundColor DarkGray
  }
}

if ($ollama) { New-BootTask -Name "$prefix`Ollama" -Command "& '$ollama' serve" -WorkDir (Split-Path -Parent $ollama) -DelaySeconds 0 }
New-BootTask -Name "$prefix`Latch"  -Command "& '$node' server.js" -WorkDir $latch -DelaySeconds 20
# Bureau through its own launcher so the remote-guard default and LATCH_DATA logic stay in ONE place.
New-BootTask -Name "$prefix`Bureau" -Command "& '$here\Start-Bureau.ps1' -Foreground" -WorkDir $here -DelaySeconds 40
New-DailyTask -Name "$prefix`Backup" -Command "& '$node' tools\backup.mjs" -WorkDir $here -At "03:30"

if (-not $WhatIfPreference) {
  Write-Host "`nRegistered. Verify without rebooting:"
  Write-Host "  Get-ScheduledTask $prefix* | Select TaskName,State"
  Write-Host "  Start-ScheduledTask $prefix`Bureau     # then check http://127.0.0.1:4173/api/whoami"
  Write-Host "`nThe per-user Startup shortcuts still exist. Remove them once a real reboot proves these work,"
  Write-Host "or you will get a second copy of each on interactive logon (the port guard refuses the duplicate,"
  Write-Host "so it is noisy rather than harmful)."
  Write-Host "`nSTILL UNVERIFIED until you actually reboot: whether Ollama is happy under SYSTEM in session 0."
  Write-Host "GPU acceleration is the thing to check - if models get slow, run Ollama from the Startup folder"
  Write-Host "instead and leave only Latch+Bureau as tasks. Bureau degrades honestly when the model is gone."
}
