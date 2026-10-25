@echo off
rem Starts SanWe's (media server + app), checks that everything works, then opens the browser. The first run sets itself up (see START-HERE.bat).
rem Options:  tunnel = also start an internet tunnel (needs cloudflared)   nobrowser   rebuild
cd /d "%~dp0"
where node >nul 2>nul || ( echo Node.js 20.6 or newer is needed: https://nodejs.org & pause & exit /b 1 )
node scripts\setup.mjs || ( pause & exit /b 1 )
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sanwes.ps1" start %*
echo.
pause
