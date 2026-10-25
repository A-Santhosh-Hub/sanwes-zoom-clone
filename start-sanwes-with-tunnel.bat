@echo off
rem Starts SanWe's AND an internet tunnel so friends can open it from anywhere (needs cloudflared: https://github.com/cloudflare/cloudflared).
cd /d "%~dp0"
where node >nul 2>nul || ( echo Node.js 20.6 or newer is needed: https://nodejs.org & pause & exit /b 1 )
node scripts\setup.mjs || ( pause & exit /b 1 )
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sanwes.ps1" start tunnel %*
echo.
pause
