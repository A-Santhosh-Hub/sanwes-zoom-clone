# Makes a zip of SanWe's to install on another computer. It leaves out everything that belongs to THIS computer:
# accounts and meetings (data), uploaded pictures, saved videos, the secret keys (.env), downloaded packages and built apps.
# On the other computer: unzip, double-click start-sanwes.bat (it makes that computer's own keys), create the first account.
# Windows PowerShell 5.1 compatible. Keep this file ASCII-only.
param([string]$Out = '')
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Out) { $Out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'SanWes-for-another-PC.zip' }
$Stage = Join-Path $env:TEMP ('sanwes-copy-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))

if (-not (Test-Path (Join-Path $Root 'client\dist\index.html'))) { Write-Host 'Building the web client first...'; Push-Location $Root; & npm run build; Pop-Location }

$skipDirs = @('node_modules', 'data', 'uploads', 'dist-electron', 'stage', 'stage-viewer', '.git')
New-Item -ItemType Directory -Path $Stage | Out-Null
$dest = Join-Path $Stage 'SanWes'
New-Item -ItemType Directory -Path $dest | Out-Null

function Copy-Tree($from, $to) {
  New-Item -ItemType Directory -Path $to -Force | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $from -Force) {
    if ($item.PSIsContainer) {
      if ($skipDirs -contains $item.Name) { continue }
      if ($item.FullName -ieq (Join-Path $Root 'desktop\dist')) { continue }
      Copy-Tree $item.FullName (Join-Path $to $item.Name)
    } else {
      if ($item.Name -in @('.env', '.env.bak', 'DiscordSetup.exe')) { continue }
      Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $to $item.Name)
    }
  }
}
Copy-Tree $Root $dest
# this computer's media-server secret stays here: the copy gets a placeholder and makes its own on first start
$yamlPath = Join-Path $dest 'livekit.yaml'
if (Test-Path $yamlPath) {
  $y = [IO.File]::ReadAllText($yamlPath)
  $y = [regex]::Replace($y, '(?m)^(\s+sanwes:\s*)\S+\s*$', '${1}replace-me-on-first-start')
  [IO.File]::WriteAllText($yamlPath, $y, (New-Object System.Text.UTF8Encoding($false)))
}

if (Test-Path $Out) { Remove-Item $Out -Force }
Write-Host 'Zipping (the media server is about 40 MB)...'
Compress-Archive -Path $dest -DestinationPath $Out -CompressionLevel Optimal
Remove-Item -Recurse -Force $Stage
$mb = [Math]::Round((Get-Item $Out).Length / 1MB)
Write-Host ''
Write-Host "Done: $Out ($mb MB)" -ForegroundColor Green
Write-Host 'On the other computer: install Node.js (nodejs.org) and Microsoft Edge or Chrome, unzip, then double-click start-sanwes.bat.'
Write-Host 'Accounts, meetings and videos are NOT copied: each computer has its own, and its first account becomes its administrator.'
