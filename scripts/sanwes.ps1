# SanWe's launcher: start / stop / status, with a self-check. Used by start-sanwes.bat, stop-sanwes.bat, status-sanwes.bat.
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.
param([string]$Action = 'start')

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Tunnel = $args -contains 'tunnel'
$NoBrowser = $args -contains 'nobrowser'
$Rebuild = $args -contains 'rebuild'
$Hidden = $args -contains 'hidden'   # started by Windows at sign-in: no windows at all
$Win = if ($Hidden) { 'Hidden' } else { 'Minimized' }
$StopTunnel = $args -contains 'tunnel'
$Failed = 0

function Ok($m)   { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[ !! ] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[FAIL] $m" -ForegroundColor Red; $script:Failed++ }
function Info($m) { Write-Host "       $m" -ForegroundColor Gray }

function Test-Http($url, $timeout = 4) {
  try { $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeout; return $r.StatusCode } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return 0 }
  }
}
function Wait-Http($url, $seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) { if ((Test-Http $url 2) -eq 200) { return $true }; Start-Sleep -Milliseconds 700 }
  return $false
}
function Get-LanIp {
  try { (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } | Select-Object -First 1).IPv4Address.IPAddress } catch { $null }
}
function Get-ListenerPid($port) {
  try { (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess } catch { $null }
}
function Read-EnvValue($key) {
  $line = Get-Content (Join-Path $Root '.env') -ErrorAction SilentlyContinue | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$key=", '').Trim() } else { return $null }
}

# ------------------------------------------------------------------ first start on a new computer
function New-FirstRunConfig {
  Warn 'first start on this computer: creating its own media-server keys (.env and livekit.yaml)'
  $bytes = New-Object byte[] 32
  (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
  $secret = ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $yaml = [IO.File]::ReadAllText((Join-Path $Root 'livekit.yaml'))
  $yaml = [regex]::Replace($yaml, '(?m)^(\s+sanwes:\s*)\S+\s*$', "`${1}$secret")
  [IO.File]::WriteAllText((Join-Path $Root 'livekit.yaml'), $yaml, $utf8)
  $ip = Get-LanIp; if (-not $ip) { $ip = 'localhost' }
  $envText = [IO.File]::ReadAllText((Join-Path $Root '.env.example'))
  $envText = $envText -replace '(?m)^LIVEKIT_API_SECRET=.*$', "LIVEKIT_API_SECRET=$secret"
  $envText = $envText -replace '(?m)^LIVEKIT_URL=.*$', "LIVEKIT_URL=ws://${ip}:7880"
  [IO.File]::WriteAllText((Join-Path $Root '.env'), $envText, $utf8)
  Ok 'keys created. The first account you create on this computer will be its administrator.'
}

# ------------------------------------------------------------------ stop
function Stop-All {
  Write-Host "Stopping SanWe's..." -ForegroundColor Cyan
  $stopped = 0
  # app: whatever node process listens on 3000 and runs server/index.js (also catches copies started by hand)
  $appPid = Get-ListenerPid 3000
  if ($appPid) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$appPid" -ErrorAction SilentlyContinue
    if ($p -and $p.Name -match '^node' -and $p.CommandLine -match 'server[\\/]index\.js') { Stop-Process -Id $appPid -Force; $stopped++; Ok "app stopped (pid $appPid)" }
    elseif ($p) { Warn "port 3000 is used by '$($p.Name)', not by SanWe's: left alone" }
  }
  foreach ($p in Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue) {
    if ($p.CommandLine -match 'sanwes-app') { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $stopped++; Ok "app stopped (pid $($p.ProcessId))" }
  }
  # media server: only the copy from this project's bin folder
  $lkPath = (Join-Path $Root 'bin\livekit-server.exe')
  foreach ($p in Get-Process livekit-server -ErrorAction SilentlyContinue) {
    if (-not $p.Path -or $p.Path -ieq $lkPath) { Stop-Process -Id $p.Id -Force; $stopped++; Ok "media server stopped (pid $($p.Id))" }
  }
  # tunnel: only the one this launcher started, unless you ask for all of them with:  stop-sanwes.bat tunnel
  $pidFile = Join-Path $env:TEMP 'sanwes-tunnel.pid'
  if (Test-Path $pidFile) {
    $tp = [int](Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $proc = Get-Process -Id $tp -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'cloudflared') { Stop-Process -Id $tp -Force; $stopped++; Ok "tunnel started by this launcher stopped (pid $tp)" }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
  }
  foreach ($p in Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue) {
    if ($p.CommandLine -notmatch 'localhost:3000') { continue }
    if ($StopTunnel) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $stopped++; Ok "tunnel stopped (pid $($p.ProcessId))" }
    else { Info "a tunnel to this app (pid $($p.ProcessId)) was left running. Its address stays valid and reconnects when the app starts again. To stop it too: stop-sanwes.bat tunnel" }
  }
  if ($stopped -eq 0) { Info 'nothing was running.' }
}

# ------------------------------------------------------------------ checks (used by start and status)
function Run-Checks {
  Write-Host "`nChecking..." -ForegroundColor Cyan
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { Ok "Node.js $(& node -v)" } else { Fail 'Node.js is not installed or not on PATH' }

  if ((Test-Http 'http://127.0.0.1:7880') -eq 200) { Ok 'media server (LiveKit) answers on port 7880' } else { Fail 'media server (LiveKit) does not answer on port 7880' }
  if ((Test-Http 'http://localhost:3000') -eq 200) { Ok 'app answers on http://localhost:3000' } else { Fail 'app does not answer on http://localhost:3000' }

  try {
    $h = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 5
    if ($h.media) { Ok "app can talk to the media server (accounts on this computer: $($h.accounts))" } else { Fail 'app cannot reach the media server' }
  } catch { Fail 'app cannot reach the media server (api/health failed)' }

  try {
    # joining needs a signed-in account, so a request without one must be refused with 401
    Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/token' -ContentType 'application/json' -Body '{"room":"self-check"}' -TimeoutSec 5 | Out-Null
    Fail 'a join request without signing in was accepted (accounts are not enforced)'
  } catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
    if ($code -eq 401) { Ok 'sign-in is required before anyone can join (accounts are on)' }
    elseif ($code -eq 429) { Warn 'token check skipped: rate limit reached (run again in a minute)' }
    else { Fail "token check failed (HTTP $code)" }
  }

  $ip = Get-LanIp
  if ($ip) {
    if ((Test-Http "http://${ip}:3000") -eq 200) { Ok "reachable on your network at http://${ip}:3000" } else { Warn "not reachable at http://${ip}:3000 (firewall? another network?)" }
  } else { Warn 'no network connection found: only this PC can use the app' }
}

function Show-Summary {
  $ip = Get-LanIp
  Write-Host ''
  if ($script:Failed -eq 0) { Write-Host '=== ALL CHECKS PASSED ===' -ForegroundColor Green } else { Write-Host "=== $($script:Failed) CHECK(S) FAILED: see the [FAIL] lines above ===" -ForegroundColor Red }
  Write-Host "  This PC : http://localhost:3000"
  if ($ip) { Write-Host "  Network : http://${ip}:3000   (other devices on the same Wi-Fi; needs the browser flag for camera/mic, see README)" }
  if ($script:TunnelUrl) { Write-Host "  Internet: $($script:TunnelUrl)   (changes every time the tunnel starts)" }
  Write-Host '  Stop    : stop-sanwes.bat'
}

# ------------------------------------------------------------------ start
function Start-All {
  Write-Host "Starting SanWe's from $Root" -ForegroundColor Cyan

  # --- preflight
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. Install it from https://nodejs.org and run this again.'; return }
  if (-not (Test-Path '.env')) {
    # first start on a new computer (for example a copy made by make-copy-for-another-pc.bat): make this computer's own keys
    if ((Test-Path 'livekit.yaml') -and (Test-Path '.env.example')) { New-FirstRunConfig } else { Fail ".env is missing. Copy .env.example to .env and put the LiveKit secret from livekit.yaml into it."; return }
  }
  if (-not (Test-Path 'bin\livekit-server.exe')) { Fail 'bin\livekit-server.exe is missing (the LiveKit media server).'; return }
  if (-not (Test-Path 'node_modules') -or -not (Test-Path 'client\node_modules')) {
    Warn 'dependencies are missing: running npm run setup (first start only)...'
    & npm run setup
    if ($LASTEXITCODE -ne 0) { Fail 'npm run setup failed'; return }
  }
  if ($Rebuild -or -not (Test-Path 'client\dist\index.html')) {
    Warn 'building the web client...'
    & npm run build
    if ($LASTEXITCODE -ne 0) { Fail 'building the client failed'; return }
  }

  # --- your network address changes after a restart; LIVEKIT_URL must follow it or other devices cannot connect
  $envChanged = $false
  $lkUrl = Read-EnvValue 'LIVEKIT_URL'
  $ip = Get-LanIp
  if ($lkUrl -and $ip -and $lkUrl -match '^(wss?://)(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)[\d.]+(:\d+.*)$' -and $lkUrl -notmatch [regex]::Escape("//$ip")) {
    $new = $lkUrl -replace '^(wss?://)[\d.]+', "`${1}$ip"
    Copy-Item '.env' '.env.bak' -Force
    (Get-Content '.env') -replace '^LIVEKIT_URL=.*', "LIVEKIT_URL=$new" | Set-Content '.env' -Encoding ascii
    $envChanged = $true
    Warn "your network address changed: LIVEKIT_URL updated  $lkUrl  ->  $new   (old .env saved as .env.bak)"
  }

  # --- media server
  if (Get-ListenerPid 7880) { Ok 'media server already running' }
  else {
    Start-Process -FilePath (Join-Path $Root 'bin\livekit-server.exe') -ArgumentList '--config', 'livekit.yaml' -WorkingDirectory $Root -WindowStyle $Win | Out-Null
    Write-Host 'starting media server (takes a few seconds)...'
    if (Wait-Http 'http://127.0.0.1:7880' 40) { Ok 'media server started' } else { Fail 'media server did not come up within 40 s'; return }
  }

  # --- app (extra "sanwes-app" argument only marks the process so stop-sanwes.bat can find it)
  $running = Get-ListenerPid 3000
  if ($running -and $envChanged) {
    Warn 'restarting the app so it picks up the new address...'
    Stop-Process -Id $running -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1; $running = $null
  }
  if ($running) { Ok 'app already running' }
  else {
    Start-Process -FilePath 'node' -ArgumentList '--env-file=.env', 'server\index.js', 'sanwes-app' -WorkingDirectory $Root -WindowStyle $Win | Out-Null
    if (Wait-Http 'http://localhost:3000' 20) { Ok 'app started' } else { Fail 'app did not come up within 20 s (open the minimized "node" window to read the error)'; return }
  }

  # --- optional internet tunnel
  $script:TunnelUrl = $null
  if ($Tunnel) {
    $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
    if (-not $cf) { Warn 'cloudflared is not installed: skipping the tunnel' }
    else {
      $already = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match 'localhost:3000' }
      if ($already) { Warn 'a tunnel to this app is already running: its address is in that window' }
      else {
        $log = Join-Path $env:TEMP 'sanwes-tunnel.log'; Remove-Item $log -ErrorAction SilentlyContinue
        $before = @(Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "cloudflared tunnel --url http://localhost:3000 2> `"$log`"" -WindowStyle $Win | Out-Null
        $until = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $until -and -not $script:TunnelUrl) {
          Start-Sleep -Milliseconds 800
          if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($m) { $script:TunnelUrl = $m.Matches[0].Value } }
        }
        $new = Get-Process cloudflared -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Select-Object -First 1
        if ($new) { $new.Id | Set-Content (Join-Path $env:TEMP 'sanwes-tunnel.pid') }
        if ($script:TunnelUrl) {
          Ok "internet tunnel started"
          # the link changes every time, so keep the current one in a file anyone can open
          try { [IO.File]::WriteAllText((Join-Path $Root 'public-link.txt'), "Public link for students (changes every time SanWe's starts):`r`n$($script:TunnelUrl)`r`n`r`nWritten at $(Get-Date)`r`n") } catch { }
        } else { Warn "tunnel started but its address was not found yet: look in $log" }
      }
    }
  }

  Run-Checks
  Show-Summary
  if (-not $NoBrowser -and $script:Failed -eq 0) { Start-Process 'http://localhost:3000' }
}

switch ($Action) {
  'start'  { Start-All }
  'stop'   { Stop-All }
  'status' { $script:TunnelUrl = $null; Run-Checks; Show-Summary }
  default  { Write-Host "usage: sanwes.ps1 start|stop|status  [tunnel] [nobrowser] [rebuild]"; exit 2 }
}
if ($Failed -gt 0) { exit 1 }
