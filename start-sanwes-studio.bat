@echo off
rem Opens SanWe's Studio: the meeting in its own window, a public link for guests, and a recorder that records that window with its sound.
set "ELECTRON_RUN_AS_NODE="
set "EXE=%~dp0desktop\dist\SanWes Studio-win32-x64\SanWes Studio.exe"
if exist "%EXE%" ( start "" "%EXE%" & exit /b )
if exist "%~dp0desktop\node_modules\electron\dist\electron.exe" ( start "" "%~dp0desktop\node_modules\electron\dist\electron.exe" "%~dp0desktop" & exit /b )
echo SanWe's Studio is not built yet. Run build-sanwes-studio.bat first.
pause
