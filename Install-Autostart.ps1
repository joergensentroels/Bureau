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
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<this path>" -Verify      # post-reboot checklist
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<this path>" -Verify -Quick   # ...without loading a model
#
# -Verify GENERATES a token with the real model rather than pinging /api/tags. That distinction is the whole
# point: on 2026-08-01 a rolled-back Ollama update deleted llama-server.exe, and the port, the task state and
# the model list all stayed green while every inference returned 500 for nine hours. -Quick skips it when you
# only want the structural checks and do not want to spend ~25s loading 5 GB into VRAM.
#
# The boot tasks this creates already pass -ExecutionPolicy Bypass themselves, so Restricted does not
# affect them at startup — it only gets in the way of running this installer by hand.
[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$Uninstall, [switch]$Verify, [switch]$Quick)

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
  # ACTUALLY GENERATE SOMETHING. This is the check that would have caught the 2026-08-01 outage in seconds.
  #
  # A failed auto-update deleted lib\ollama\llama-server.exe while the server kept running. The port
  # listened, the task said Running, /api/tags returned both models correctly - and every inference returned
  # 500 for nine hours with nothing reporting it. Every check here pinged a port; none asked the service to
  # do its job. A liveness probe that only proves a process is LISTENING cannot detect a service that has
  # lost the ability to function.
  #
  # It also fixes the GPU check, which used to report "unknown" whenever nothing happened to be loaded -
  # the common case, and an absence of evidence dressed up as a result. Generating loads the model, so
  # size_vram is readable immediately afterwards by construction.
  if ($Quick) {
    Write-Host "  -Quick: skipped the inference probe (it loads the model, ~25s cold)" -ForegroundColor DarkYellow
    $unproven += "inference not probed (-Quick)"
  } else {
    # The model Bureau actually routes to, not whatever happens to be first in the list.
    $probeModel = ""
    try {
      $raw = [System.IO.File]::ReadAllText((Join-Path $latch "data\llm-provider.json")) -replace "^$([char]0xFEFF)", ""
      $probeModel = ($raw | ConvertFrom-Json).model
    } catch { }
    if (-not $probeModel -and $tags -and $tags.models.Count -gt 0) { $probeModel = $tags.models[0].name }

    if (-not $probeModel) {
      Write-Host "  no model to probe with" -ForegroundColor Red; $fail += "no model available to probe"
    } else {
      Write-Host "  probing inference with $probeModel (loads it; up to ~30s cold)..." -ForegroundColor Cyan
      $body = @{ model = $probeModel; prompt = "Reply with the single word: ok"; stream = $false;
                 think = $false; options = @{ num_predict = 8 } } | ConvertTo-Json -Depth 4
      try {
        $t0 = Get-Date
        $gen = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:11434/api/generate" -Body $body `
                 -ContentType "application/json" -TimeoutSec 180
        $secs = ((Get-Date) - $t0).TotalSeconds
        # Print tok/s ONLY when the sample can support it. The probe prompt yields ~2 tokens, where fixed
        # overhead dominates the per-token math: the same run measured 44 tok/s here against 122-124 on
        # real generations, which reads as a 3x regression and is nothing of the kind. A decorative number
        # that will be misread is worse than no number - this check is "does it work", not a benchmark.
        $tps = if ($gen.eval_count -and $gen.eval_duration) { $gen.eval_count / ($gen.eval_duration / 1e9) } else { 0 }
        $rate = if ($gen.eval_count -ge 20) { "{0:N0} tok/s" -f $tps } else { "too few tokens to time - this is a liveness check, not a benchmark" }
        Write-Host ("  INFERENCE WORKS: {0} tokens in {1:N1}s wall ({2})" -f $gen.eval_count, $secs, $rate) -ForegroundColor Green

        # Now that a model IS resident, size_vram means something.
        try {
          $ps = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/ps" -TimeoutSec 10
          foreach ($m in $ps.models) {
            $vram = [int64]$m.size_vram; $tot = [int64]$m.size
            $pct = if ($tot -gt 0) { 100.0 * $vram / $tot } else { 0 }
            $verdict = if ($vram -le 0) { "CPU ONLY" } elseif ($pct -gt 95) { "FULLY ON GPU" } else { "PARTIAL OFFLOAD" }
            Write-Host ("  {0}: {1:N2} of {2:N2} GB in VRAM ({3:N0}%) -> {4}" -f $m.name, ($vram/1GB), ($tot/1GB), $pct, $verdict) `
              -ForegroundColor $(if ($vram -le 0) { "Red" } elseif ($pct -gt 95) { "Green" } else { "Yellow" })
            if ($vram -le 0) { $fail += "$($m.name) is on CPU only" }
          }
          # Ollama probes the Ryzen's INTEGRATED graphics first and logs "AMD driver is too old" before
          # selecting CUDA. Said here because reading that line as the answer inverts the conclusion.
          if ($ps.models.Count -eq 0) { $unproven += "model unloaded before /api/ps could read it" }
        } catch { $unproven += "GPU split unread (/api/ps: $($_.Exception.Message))" }
      } catch {
        # THE case this block exists for. Report the server's own message: "llama-server binary not found"
        # is a broken install, not a configuration problem, and the two need different fixes.
        # Three sources, in order, because none of them is reliable alone and an EMPTY diagnosis is the one
        # outcome this check cannot afford. ErrorDetails.Message is where Invoke-RestMethod puts the response
        # body in PS 5.1; the raw stream is often already consumed by the time we get here (a bare
        # GetResponseStream().ReadToEnd() returned "" on a live 404, printing a failure with no reason);
        # Exception.Message always exists as a last resort.
        $detail = "$($_.ErrorDetails.Message)".Trim()
        if (-not $detail) { try { $detail = (New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd().Trim() } catch { } }
        if (-not $detail) { $detail = "$($_.Exception.Message)".Trim() }
        if (-not $detail) { $detail = "(the server gave no reason at all)" }
        Write-Host "  INFERENCE FAILED - the server is listening but cannot run a model:" -ForegroundColor Red
        Write-Host ("    " + $detail.Substring(0, [Math]::Min(300, $detail.Length))) -ForegroundColor Red
        if ($detail -match "llama-server") {
          Write-Host "    That is a BROKEN INSTALL, almost certainly a rolled-back auto-update." -ForegroundColor Red
          Write-Host "    Repair: Stop-ScheduledTask $prefix`Ollama (elevated), run OllamaSetup.exe UN-elevated," -ForegroundColor Red
          Write-Host "    quit the tray icon, re-disable the Ollama.lnk it restores, Start-ScheduledTask." -ForegroundColor Red
        }
        $fail += "Ollama cannot run a model"
      }
    }
  }
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
  Write-Host "PROVEN - all three run as SYSTEM after boot, the model generates on the GPU, token resolved." -ForegroundColor Green
  $su = [Environment]::GetFolderPath('Startup')
  $live = Get-ChildItem $su -Filter "*.lnk" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @("Start Bureau.lnk", "Start Latch.lnk", "Ollama.lnk") }
  if ($live) {
    # Ollama.lnk is NOT merely redundant like the other two - it is actively dangerous. It launches the tray
    # app, which is the auto-updater, which cannot replace files held by a SYSTEM-owned server and rolls
    # back BY UNINSTALLING. That is what deleted llama-server.exe on 2026-08-01. Every Ollama install puts
    # this shortcut back, so this check runs every time rather than being a one-off cleanup instruction.
    Write-Host "`nStartup shortcuts still present - disable them (rename, so it is reversible):" -ForegroundColor Yellow
    foreach ($s in $live) {
      $why = if ($s.Name -eq "Ollama.lnk") { "  <-- the auto-updater. It WILL break the install again." } else { "" }
      Write-Host ("  Rename-Item `"{0}`" `"{1}.disabled`"{2}" -f $s.FullName, $s.Name, $why) -ForegroundColor $(if ($why) { "Red" } else { "Yellow" })
    }
  } else {
    Write-Host "Startup folder is clear - nothing will duplicate or auto-update these at logon." -ForegroundColor Green
  }
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
#   stream 2 (errors)   -> boot.err.log   PowerShell failures, and a native crash node dies too fast to log
#   stream 6 (Write-Host) -> boot.log     the launcher's own messages, e.g. "Port 4173 is already served by
#                                         pid ..." — the boot refusal you would otherwise have no record of
#
# TWO FILES, and this is not cosmetic. The first version sent both streams to ONE boot.log, and PowerShell
# opens a redirection target per redirection: the second open fails with "The process cannot access the file
# because it is being used by another process", the statement dies with exit 1, and that error goes to the
# console — which a scheduled task discards. So both servers failed to start, leaving a 0-byte boot.log and
# no trace anywhere. The change made to improve failure visibility is the one that broke the boot, silently.
# (`6>&2` would be the obvious single-file fix and does NOT parse: PS 5.1 calls it "reserved for future use".)
#
# Stream 1 is deliberately NOT redirected: that is the servers' normal chatter, already captured WITH
# rotation by the in-process tee, and duplicating it here would grow a second file without bound.
# Ollama gets the same treatment mainly for its GPU-vs-CPU decision, which it reports on stderr.
#
# Rotated at task start rather than appended forever — one previous generation is kept, which is what
# you want after a restart loop. SilentlyContinue because a locked log must never stop a server booting.
$logRot = "foreach(`$f in 'boot.log','boot.err.log'){if((Test-Path `$f) -and (Get-Item `$f).Length -gt 1mb){Move-Item `$f (`$f + '.1') -Force -ErrorAction SilentlyContinue}};"

function New-BootTask {
  param([string]$Name, [string]$Command, [string]$WorkDir, [int]$DelaySeconds = 0)
  $ps = (Get-Command powershell.exe).Source
  # boot.log RELATIVE, resolved against -WorkingDirectory: this repo lives under "LLM server", and a
  # quoted absolute path nested inside an already-quoted -Command is how the MODULE_NOT_FOUND bug in
  # Start-Bureau.ps1 happened. Relative sidesteps the quoting entirely.
  $inner = "$logRot $sysEnv $Command 2>>boot.err.log 6>>boot.log"
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
  # START THEM AND CHECK, rather than printing "registered" and hoping.
  #
  # An install that registers a task whose command line cannot run looks identical to a good one: four
  # green "registered" lines. That happened - two redirections to one boot.log made both servers exit 1
  # instantly, with the error going to a console the task discards - and it was only noticed because a
  # human went looking. A registration is a claim; a listening port is evidence.
  #
  # Waiting for the port to FREE before starting matters too: Stop-ScheduledTask returns immediately while
  # termination is asynchronous, and -MultipleInstances IgnoreNew silently drops a start that overlaps a
  # still-dying instance.
  Write-Host "`nStarting them now to prove the command lines actually run..." -ForegroundColor Cyan
  $checks = @(@{ Task = "$prefix`Latch"; Port = 8787 }, @{ Task = "$prefix`Bureau"; Port = 4173 })
  foreach ($c in $checks) { Stop-ScheduledTask -TaskName $c.Task -ErrorAction SilentlyContinue }
  foreach ($c in $checks) {
    $n = 0
    while ((Get-NetTCPConnection -LocalPort $c.Port -State Listen -ErrorAction SilentlyContinue) -and $n -lt 30) { Start-Sleep -Milliseconds 500; $n++ }
  }
  $bad = @()
  foreach ($c in $checks) {
    Start-ScheduledTask -TaskName $c.Task
    $n = 0
    while (-not (Get-NetTCPConnection -LocalPort $c.Port -State Listen -ErrorAction SilentlyContinue) -and $n -lt 40) { Start-Sleep -Milliseconds 500; $n++ }
    if (Get-NetTCPConnection -LocalPort $c.Port -State Listen -ErrorAction SilentlyContinue) {
      Write-Host ("  OK   {0} is listening on :{1} after {2}s" -f $c.Task, $c.Port, [int]($n * 0.5)) -ForegroundColor Green
    } else {
      $res = (Get-ScheduledTask -TaskName $c.Task | Get-ScheduledTaskInfo).LastTaskResult
      Write-Host ("  FAIL {0} did NOT bind :{1} (LastTaskResult={2})" -f $c.Task, $c.Port, $res) -ForegroundColor Red
      $bad += $c.Task
    }
  }
  if ($bad.Count) {
    Write-Host "`n$($bad -join ' and ') failed to start. Look here, in this order:" -ForegroundColor Red
    Write-Host "  1. boot.err.log / boot.log in the task's working directory (PowerShell-level failures)"
    Write-Host "  2. bureau.log / latch.log (the server's own output, if it got far enough to start)"
    Write-Host "  3. If ALL of those are empty, the command line itself failed before any redirect could"
    Write-Host "     open - run the task's -Command string by hand in a console to see the real error."
    exit 1
  }
  Write-Host "`nRegistered AND verified listening. Re-check any time with:"
  Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$here\Install-Autostart.ps1`" -Verify   (elevated)"
  Write-Host "`nGPU under SYSTEM in session 0: PROVEN 2026-08-01. qwen3:8b loaded with size_vram = size" -ForegroundColor Green
  Write-Host "(100% resident in VRAM, CUDA, ~75 tok/s warm). Session 0 does NOT cost you the GPU, so the old"
  Write-Host "advice to move Ollama back to the Startup folder if models feel slow is withdrawn - see below."
  Write-Host "`nKEEP THE OLLAMA TRAY APP OUT OF STARTUP." -ForegroundColor Yellow
  Write-Host "The tray app is also the auto-updater, and it CANNOT coexist with Ollama running as a SYSTEM task."
  Write-Host "On 2026-08-01 it destroyed the installation: the boot task had ollama.exe open, the updater could not"
  Write-Host "replace a file held by a process it lacks the rights to stop (DeleteFile failed; code 5), and it"
  Write-Host "rolled back BY UNINSTALLING - deleting lib\ollama\llama-server.exe. The server kept answering"
  Write-Host "/api/tags from memory, so every health check looked fine while every inference returned 500."
  Write-Host "`nSo updating Ollama is now a deliberate operator action, in this order:"
  Write-Host "  Stop-ScheduledTask -TaskName $prefix`Ollama      # elevated: releases the lock on ollama.exe"
  Write-Host "  & `"`$env:LOCALAPPDATA\Ollama\OllamaSetup.exe`"    # NOT elevated: Ollama installs per-user"
  Write-Host "  # quit the tray icon it launches, and re-disable the Ollama.lnk the installer puts back"
  Write-Host "  Start-ScheduledTask -TaskName $prefix`Ollama"
}
