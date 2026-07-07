@echo off
rem Double-clickable: promote a PRODUCTION account to platform superadmin.
rem The person must have signed up at https://solutions-platform.vercel.app first.
cd /d "%~dp0.."
echo.
set /p email="Email address to promote to superadmin: "
if "%email%"=="" (
  echo No email entered - nothing done.
  pause
  exit /b 1
)
pnpm exec tsx scripts/prod-promote-superadmin.ts %email%
echo.
pause
