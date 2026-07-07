@echo off
rem Double-clickable dev startup. Requires Docker Desktop to be running.
rem Starts local Supabase (if not running), writes .env files, then runs
rem web (http://localhost:3000) + worker. Press Ctrl+C to stop the apps.
cd /d "%~dp0.."
pnpm dev
pause
