@echo off
setlocal
title OpenMausBot build and install
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required and was not found on PATH.
  echo Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

node "%~dp0scripts\local-install.mjs" %*
set "exit_code=%errorlevel%"

if not "%exit_code%"=="0" (
  echo.
  echo Build or install failed with exit code %exit_code%.
  echo Logs are in %TEMP%\openmausbot-local-build\
)

pause
exit /b %exit_code%
