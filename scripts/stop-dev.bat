@echo off
rem Stops the local Supabase containers. (The web/worker processes stop with
rem Ctrl+C in the window where start-dev.bat is running.)
cd /d "%~dp0.."
pnpm stop
pause
