@echo off
chcp 65001 >nul
echo ============================================
echo   Starting Auto Media Product (Prod Mode)...
echo ============================================
echo.
echo Building frontend assets and launching server...
echo Please wait, browser will open automatically once built.
echo.
call pnpm build
echo Opening browser...
start http://127.0.0.1:8787
echo Running pnpm start...
pnpm start
