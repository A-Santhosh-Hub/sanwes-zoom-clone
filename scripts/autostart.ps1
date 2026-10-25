# Makes SanWe's start by itself when this Windows account signs in (hidden: no windows), and can wake the computer for a class.
#   autostart.ps1 install [-Studio] [-Tunnel] [-WakeAt 04:15]     autostart.ps1 remove     autostart.ps1 status
#   -Studio  start the SanWe's Studio app in class mode instead of the plain launcher: it opens the class window by itself and records it.
# It uses a Windows scheduled task for the signed-in user, so no administrator password is needed.
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.
param([string]$Action = 'status', [switch]$Studio, [switch]$Tunnel, [string]$WakeAt = '')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Name = 'SanWes Auto Start'
$Me = "$env:USERDOMAIN\$env:USERNAME"
$StudioExe = Join-Path $Root 'desktop\dist\SanWes Studio-win32-x64\SanWes Studio.exe'

function Show-Status {
  $t = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "Auto start is OFF. SanWe's only starts when you double-click start-sanwes.bat." -ForegroundColor Yellow; return }
  $info = Get-ScheduledTaskInfo -TaskName $Name
  Write-Host "Auto start is ON for $Me." -ForegroundColor Green
  if ($t.Actions[0].Execute -match 'SanWes Studio') { Write-Host "  Starts: SanWe's Studio in class mode, when you sign in to Windows (about 30 seconds later)." }
  else { Write-Host "  Starts: when you sign in to Windows (about 30 seconds later), with no windows." }
  $wake = $t.Triggers | Where-Object { $_.CimClass.CimClassName -match 'Daily' }
  if ($wake) { Write-Host "  Also wakes the computer every day at $(([datetime]$wake.StartBoundary).ToString('HH:mm'))." }
  Write-Host "  Command: $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
  if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { Write-Host "  Last run: $($info.LastRunTime)" }
}

switch ($Action) {
  'install' {
    $logDir = Join-Path $Root 'data\logs'; New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    if ($Studio) {
      if (-not (Test-Path $StudioExe)) { throw "SanWe's Studio is not built yet. Double-click build-sanwes-studio.bat first." }
      $studioArgs = '--class-mode' + $(if ($Tunnel) { ' --tunnel' } else { '' })
      $act = New-ScheduledTaskAction -Execute $StudioExe -Argument $studioArgs -WorkingDirectory (Split-Path -Parent $StudioExe)
    } else {
      $script = Join-Path $Root 'scripts\sanwes.ps1'
      $opts = 'start nobrowser hidden' + $(if ($Tunnel) { ' tunnel' } else { '' })
      $cmd = "& '$script' $opts *> '$(Join-Path $logDir 'autostart.log')'"
      $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`"" -WorkingDirectory $Root
    }
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $Me
    $logon.Delay = 'PT30S'   # give the network a moment to come up
    $triggers = @($logon)
    $wakeSetting = $false
    if ($WakeAt) {
      try { $at = [datetime]::ParseExact($WakeAt, 'HH:mm', $null) } catch { throw "Use the time like 04:15 (24-hour)." }
      $triggers += New-ScheduledTaskTrigger -Daily -At $at
      $wakeSetting = $true
    }
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    if ($wakeSetting) { $set.WakeToRun = $true }
    $prin = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $Name -Action $act -Trigger $triggers -Settings $set -Principal $prin -Description "Starts SanWe's so scheduled classes can run by themselves." -Force | Out-Null
    Write-Host "Done. SanWe's will now start by itself every time $Me signs in to Windows." -ForegroundColor Green
    if ($Studio) { Write-Host "It starts SanWe's Studio in class mode: the class window opens by itself and is recorded with its sound." }
    if ($WakeAt) { Write-Host "The computer will also wake from sleep at $WakeAt every day (it cannot wake from a full shutdown)." }
    Write-Host ''
    Show-Status
  }
  'remove' {
    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $Name -Confirm:$false; Write-Host 'Auto start removed.' -ForegroundColor Green }
    else { Write-Host 'Auto start was not on.' }
  }
  default { Show-Status }
}
