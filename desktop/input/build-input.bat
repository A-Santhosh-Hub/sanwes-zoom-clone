@echo off
rem Builds sanwes-input.exe (the Game Hub input helper) with the .NET Framework compiler that comes with Windows. No SDK needed.
setlocal
cd /d "%~dp0"
set "FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319"
if not exist "%FW%\csc.exe" ( echo The .NET Framework compiler was not found at %FW% & exit /b 1 )
if not exist "Nefarius.ViGEm.Client.dll" ( echo Nefarius.ViGEm.Client.dll is missing. See THIRD_PARTY.md. & exit /b 1 )
rem winexe: no console window; commands still arrive on stdin and answers leave on stdout when it is started with pipes.
"%FW%\csc.exe" /nologo /target:winexe /platform:x64 /optimize+ /out:sanwes-input.exe /r:Nefarius.ViGEm.Client.dll /r:"%FW%\netstandard.dll" /r:"%FW%\System.Runtime.dll" /r:System.Windows.Forms.dll /r:System.Drawing.dll sanwes-input.cs
if errorlevel 1 ( echo Build failed. & exit /b 1 )
echo Built %CD%\sanwes-input.exe
exit /b 0
