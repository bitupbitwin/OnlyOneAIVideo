@echo off
chcp 65001 >nul
echo ============================================
echo   Starting Auto Media Product (Dev Mode)...
echo ============================================
echo.
echo Service will start shortly. If the browser does not open automatically, visit:
echo   - Frontend: http://localhost:5173
echo   - Backend: http://127.0.0.1:8787
echo.
echo Opening browser...
start http://localhost:5173
echo Running pnpm dev...
pnpm dev
