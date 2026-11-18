@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0tools\setup.ps1" %*
if errorlevel 1 pause
