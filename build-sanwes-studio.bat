@echo off
rem Builds "SanWes Studio.exe" (the desktop app that opens class windows and records them). It is built on YOUR computer: no .exe is stored in this repository.
rem Needs Node.js 20.6+ and an internet connection for the first build (it downloads Electron, about 100 MB).
cd /d "%~dp0"
node scripts\setup.mjs || ( pause & exit /b 1 )
cd /d "%~dp0desktop"
if not exist node_modules\electron\dist\electron.exe ( call npm install & node node_modules\electron\install.js )
call node build.mjs
echo.
pause
