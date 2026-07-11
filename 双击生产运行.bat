@echo off
chcp 65001 >nul
echo ============================================
echo   Starting Auto Media Product (Prod Mode)...
echo ============================================
echo.

rem 开发模式会同时占用 5173 和 8787，不能再启动生产模式。
curl.exe --fail --silent --max-time 2 http://localhost:5173 >nul 2>&1
if %errorlevel%==0 (
  echo Development mode is currently running at http://localhost:5173
  echo Production mode cannot start at the same time because port 8787 is already in use.
  echo.
  echo Please close the "Double-click Development Run" window first,
  echo then run this production launcher again.
  echo.
  echo Opening the currently running development page...
  start "" http://localhost:5173
  pause
  exit /b 0
)

rem 避免重复启动：HTTP 200 表示 8787 已有本项目服务，直接复用。
curl.exe --fail --silent --max-time 3 http://127.0.0.1:8787/api/health >nul 2>&1
if %errorlevel%==0 (
  echo OnlyOneAIVideo is already running at http://127.0.0.1:8787
  echo Reusing the existing server. No second server will be started.
  start "" http://127.0.0.1:8787
  echo.
  echo The existing production service is still running.
  pause
  exit /b 0
)

rem 端口被其它无响应进程占用时，在构建前给出明确提示，避免最后才 EADDRINUSE。
netstat -ano | findstr /R /C:"127.0.0.1:8787 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo ERROR: Port 8787 is occupied by an unresponsive background process.
  echo Close that process and run this launcher again.
  netstat -ano | findstr /R /C:"127.0.0.1:8787 .*LISTENING"
  pause
  exit /b 1
)

echo Building frontend assets and launching server...
echo Please wait, browser will open automatically once built.
echo.
call pnpm build
if errorlevel 1 (
  echo.
  echo ERROR: Frontend build failed. See the messages above.
  pause
  exit /b 1
)
echo Opening browser...
start "" http://127.0.0.1:8787
echo Running pnpm start...
call pnpm start
if errorlevel 1 (
  echo.
  echo ERROR: Server stopped unexpectedly. See the messages above.
  pause
  exit /b 1
)
