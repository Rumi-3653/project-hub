@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
node.exe test\paid-license-acceptance.cjs
set "HUB_PAID_CHECK_EXIT=%errorlevel%"
pause
exit /b %HUB_PAID_CHECK_EXIT%
