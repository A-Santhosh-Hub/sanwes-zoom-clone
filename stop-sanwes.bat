@echo off
rem Stops the SanWe's app and its media server. Add the word "tunnel" to stop internet tunnels to this app too.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sanwes.ps1" stop %*
echo.
pause
