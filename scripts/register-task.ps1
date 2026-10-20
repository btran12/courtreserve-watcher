#Requires -Version 5.1
<#
.SYNOPSIS
  Registers (or removes) the scheduled task that polls the CourtReserve calendar.

.DESCRIPTION
  The task is registered with LogonType=Interactive, so it runs only while you
  are signed in. That is deliberate: desktop toasts need an interactive session,
  and it avoids storing your password in Task Scheduler.

  node.exe is resolved to an absolute path at registration time, because the
  task runs with a minimal environment where PATH may not include Node.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -IntervalMinutes 10
  powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Remove
#>
[CmdletBinding()]
param(
  [string]$TaskName = 'CourtReserveWatcher',
  [int]$IntervalMinutes = 0,   # 0 = take the value from config.json
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task named '$TaskName' exists."
  }
  return
}

$scriptPath = Join-Path $root 'src\index.js'
$configPath = Join-Path $root 'config.json'
if (-not (Test-Path $scriptPath)) { throw "Missing $scriptPath" }

$config = Get-Content $configPath -Raw | ConvertFrom-Json
if ($IntervalMinutes -le 0) { $IntervalMinutes = [int]$config.poll.intervalMinutes }
if ($IntervalMinutes -lt 5) {
  Write-Warning "IntervalMinutes=$IntervalMinutes is aggressive for a third-party site; using 5."
  $IntervalMinutes = 5
}

$node = (Get-Command node -ErrorAction Stop).Source
Write-Host "node    : $node"
Write-Host "script  : $scriptPath"
Write-Host "every   : $IntervalMinutes minutes (only while signed in)"

$action = New-ScheduledTaskAction `
  -Execute $node `
  -Argument "`"$scriptPath`" --quiet" `
  -WorkingDirectory $root

# First run one minute from now, then repeating indefinitely.
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

$description = "Polls the public $(( $config.org ).name) CourtReserve calendar for $($config.match.weekdays -join '/') " +
               "open play sessions starting at or after $($config.match.startAtOrAfterHour):00, and records who joins or leaves."

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description $description `
  -Force | Out-Null

Write-Host ''
Write-Host "Registered '$TaskName'." -ForegroundColor Green
Write-Host '  run it now : Start-ScheduledTask -TaskName ' $TaskName
Write-Host '  see status : Get-ScheduledTaskInfo -TaskName ' $TaskName
Write-Host '  remove     : powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Remove'
