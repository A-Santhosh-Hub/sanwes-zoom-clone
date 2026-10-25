@echo off
rem Stops SanWe's from starting by itself when you sign in to Windows.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\autostart.ps1" remove
echo.
pause
