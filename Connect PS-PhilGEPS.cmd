@echo off
rem Opens the PS-PhilGEPS log-in in Chrome with everything filled in. Tick "I'm not a robot";
rem the session is then saved to Supabase and the deployed dashboard's Sync can use it.
cd /d "%~dp0"
node ps-philgeps-session.js --connect
echo.
pause
