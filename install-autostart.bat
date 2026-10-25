@echo off
rem Makes SanWe's start by itself every time you sign in to Windows, so scheduled classes run without anyone opening anything.
rem Options:   studio          start SanWe's Studio in class mode (it opens the class window by itself and records it)
rem            tunnel          also start the public internet link (needs cloudflared)
rem            wake=04:15      also wake the computer from sleep at that time every day
rem Examples:  install-autostart.bat studio tunnel wake=04:15
rem            install-autostart.bat                  (the plain, windowless start)
cd /d "%~dp0"
set "STU="
set "TUN="
set "WAKE="
:next
if "%~1"=="" goto go
set "ARG=%~1"
if /i "%ARG%"=="studio" set "STU=-Studio"
if /i "%ARG%"=="tunnel" set "TUN=-Tunnel"
if /i "%ARG:~0,5%"=="wake=" set "WAKE=-WakeAt %ARG:~5%"
shift
goto next
:go
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\autostart.ps1" install %STU% %TUN% %WAKE%
echo.
pause
