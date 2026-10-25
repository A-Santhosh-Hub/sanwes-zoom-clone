@echo off
title SanWe's - first start
rem One double-click: sets everything up the first time (about 2 to 5 minutes), then starts SanWe's and opens the browser.
rem Needs Node.js 20.6 or newer (https://nodejs.org, the LTS version). Options:  tunnel = also make an internet link (needs cloudflared)   nobrowser   rebuild
cd /d "%~dp0"
echo.
echo   SanWe's - self-hosted Zoom clone with classroom automation and Game Hub
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed. Install the LTS version from https://nodejs.org , then double-click this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node scripts\setup.mjs
if errorlevel 1 (
  echo.
  echo   Setup did not finish. Read the message above, fix it, and double-click this file again.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sanwes.ps1" start %*
echo.
pause
