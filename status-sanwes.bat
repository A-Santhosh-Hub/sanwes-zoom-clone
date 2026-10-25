@echo off
rem Checks whether SanWe's is running and healthy (starts nothing).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sanwes.ps1" status
echo.
pause
