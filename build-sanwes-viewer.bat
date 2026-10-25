@echo off
rem Builds the student Viewer app (desktop\dist\SanWes Viewer-win32-x64\SanWes Viewer.exe).
cd /d "%~dp0desktop"
if not exist node_modules (
  echo Installing the build tools once...
  call npm install
)
node build-viewer.mjs
echo.
pause
