# Restart Bureau, and prove it restarted.
#
# WHY THIS EXISTS. The obvious sequence does not work on this machine, and it fails quietly:
#
#     Stop-ScheduledTask -TaskName LLMServer-Bureau
#     Start-ScheduledTask -TaskName LLMServer-Bureau
#
# The task runs `powershell.exe -File Start-Bureau.ps1 -Foreground`, which runs node in the FOREGROUND of
# that PowerShell. Ending the task kills the wrapper and ORPHANS the node child, which keeps holding
# :4173. Start-Bureau.ps1's port guard then finds the port busy and exits 1, so the start is refused and
# the OLD process carries on serving. Measured twice on 2026-08-21: boot.log recorded
# "Port 4173 is already served by pid 17736" on two consecutive attempts while the operator believed
# Bureau had been restarted, and it ran two-day-old code through both.
#
# Install-Autostart.ps1 already warns about the adjacent half of this -- "Stop-ScheduledTask returns
# immediately while termination is asynchronous" -- so the ordering knowledge existed as prose and did not
# stop the mistake. Hence a script.
#
# So: stop the PROCESS holding the port, wait for the port to actually free, then start the task. And then
# verify, because "I ran two commands" is not the same claim as "a new process is serving" -- which is
# exactly the gap the two failed attempts fell into.
#
# ELEVATED. The running Bureau belongs to the S4U task in session 0, so an unprivileged shell gets
# "Access is denied" from Stop-Process and cannot see the task at all.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\Restart-Bureau.ps1
#
# LocalMachine execution policy is Restricted here, which blocks every .ps1 regardless of signing; the
# -ExecutionPolicy flag above is per-process and does not change machine policy.
[CmdletBinding()]
param(
    [int]$Port = 4173,
    [string]$TaskName = "LLMServer-Bureau",
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"

function Get-PortHolder {
    param([int]$Port)
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { return $null }
    return $c.OwningProcess
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "This needs an elevated shell: the running Bureau belongs to the S4U task in session 0," -ForegroundColor Yellow
    Write-Host "so Stop-Process returns 'Access is denied' and the scheduled task is not even visible." -ForegroundColor Yellow
    Write-Host "Right-click PowerShell -> Run as administrator, then paste:" -ForegroundColor Yellow
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    exit 1
}

$before = Get-PortHolder -Port $Port
if ($before) {
    Write-Host "stopping pid $before (holding :$Port)"
    try { Stop-Process -Id $before -Force -ErrorAction Stop }
    catch { Write-Host "could not stop pid ${before}: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
} else {
    Write-Host "nothing is serving :$Port -- starting rather than restarting" -ForegroundColor DarkGray
}

# WAIT FOR THE PORT, not for the process object. Termination is asynchronous, and a start that overlaps a
# still-dying instance is refused by Start-Bureau.ps1's port guard -- which is the failure this whole file
# is about. Polling the port asks the question that actually decides whether the next step can work.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-PortHolder -Port $Port) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
$still = Get-PortHolder -Port $Port
if ($still) {
    Write-Host "port :$Port is STILL held by pid $still after ${TimeoutSeconds}s -- not starting," -ForegroundColor Red
    Write-Host "because the start would be refused by the port guard and this would report success." -ForegroundColor Red
    exit 1
}

Write-Host "starting scheduled task $TaskName"
Start-ScheduledTask -TaskName $TaskName

# VERIFY. A restart that cannot be shown to have happened is the thing that went wrong twice, so this waits
# for a listener and refuses to report success on the OLD pid.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$after = $null
while (-not $after -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $after = Get-PortHolder -Port $Port
}

if (-not $after) {
    Write-Host "nothing came back on :$Port within ${TimeoutSeconds}s." -ForegroundColor Red
    Write-Host "Look at boot.log and boot.err.log in this directory -- the task captures the launcher's" -ForegroundColor Red
    Write-Host "output there, and a refused start says so in boot.log." -ForegroundColor Red
    exit 1
}
if ($before -and $after -eq $before) {
    # Belt and braces: this should be impossible after the port-free wait above, and it is the exact false
    # success the two failed attempts produced, so it is checked rather than assumed.
    Write-Host "pid $after is the SAME process as before -- the restart did not take." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Bureau restarted: pid $before -> $after on :$Port" -ForegroundColor Green
Write-Host "Confirm the code it is running from its own boot banner:" -ForegroundColor DarkGray
Write-Host "  Select-String -Path bureau.log -Pattern 'Bureau starting' | Select-Object -Last 1"
