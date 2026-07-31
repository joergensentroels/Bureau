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
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path        # ...\bureau
$root    = Split-Path -Parent $here                              # ...\LLM server
$latch   = Join-Path $root "openclaw-command-center"
$prefix  = "LLMServer-"
$tasks   = @("$prefix`Ollama", "$prefix`Latch", "$prefix`Bureau")

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIfPreference) {
  Write-Host "This needs an elevated shell (SYSTEM tasks and boot triggers are admin-only)." -ForegroundColor Yellow
  Write-Host "Right-click PowerShell -> Run as administrator, then:" -ForegroundColor Yellow
  Write-Host "  cd `"$here`"; .\Install-Autostart.ps1"
  Write-Host ""
  Write-Host "Or preview without elevation:  .\Install-Autostart.ps1 -WhatIf"
  exit 1
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

function New-BootTask {
  param([string]$Name, [string]$Command, [string]$WorkDir, [int]$DelaySeconds = 0)
  $ps = (Get-Command powershell.exe).Source
  $inner = "$sysEnv $Command"
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

if ($ollama) { New-BootTask -Name "$prefix`Ollama" -Command "& '$ollama' serve" -WorkDir (Split-Path -Parent $ollama) -DelaySeconds 0 }
New-BootTask -Name "$prefix`Latch"  -Command "& '$node' server.js" -WorkDir $latch -DelaySeconds 20
# Bureau through its own launcher so the remote-guard default and LATCH_DATA logic stay in ONE place.
New-BootTask -Name "$prefix`Bureau" -Command "& '$here\Start-Bureau.ps1' -Foreground" -WorkDir $here -DelaySeconds 40

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
