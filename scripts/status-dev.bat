@echo off
rem Shows which platform pieces are running (Docker, database containers, web, worker).
cd /d "%~dp0.."
pnpm status
pause
