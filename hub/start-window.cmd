@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer, Windows x64, is required. See the Windows trial instructions.
  pause
  exit /b 1
)
node.exe "%~dp0start-window.js"
set "HUB_START_EXIT=%errorlevel%"
if not "%HUB_START_EXIT%"=="0" pause
exit /b %HUB_START_EXIT%
