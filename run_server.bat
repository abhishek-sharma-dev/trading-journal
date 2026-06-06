@echo off
title Trading Journal Server
echo ==================================================
echo Starting Trading Journal Server...
echo ==================================================
cd /d "%~dp0"
npm start
if %errorlevel% neq 0 (
  echo.
  echo --------------------------------------------------
  echo ERROR: Server failed to start or crashed.
  echo --------------------------------------------------
  pause
)
