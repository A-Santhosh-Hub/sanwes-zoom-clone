@echo off
rem Makes SanWes-for-another-PC.zip on your Desktop: the whole app without this computer's accounts, meetings, videos or keys.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-copy.ps1"
echo.
pause
