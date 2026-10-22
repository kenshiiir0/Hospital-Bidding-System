@echo off
rem Opens the PS-PhilGEPS log-in in Chrome with everything filled in. Tick "I'm not a robot";
rem the session is then saved to Supabase and the dashboard's Sync can use it. Also opened by the
rem dashboard's Sync button through the ps-philgeps-connect: link (tools/register-connect-link.js).
title Connect PS-PhilGEPS
cd /d "%~dp0"
node ps-philgeps-session.js --connect
if errorlevel 1 (
  echo.
  echo The log-in did not finish. Press any key to close this window.
  pause ^>nul
) else (
  echo You can close this window; the dashboard continues the Sync.
  timeout /t 5 ^>nul
)
