@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "COMPOSE=docker compose"
docker compose version >nul 2>&1
if errorlevel 1 (
  docker-compose version >nul 2>&1
  if errorlevel 1 (
    echo Docker Compose is required. Install or update Docker Desktop.
    pause
    exit /b 1
  )
  set "COMPOSE=docker-compose"
)

if not defined XUANSHU_SERVER_TOKEN (
  for /f "delims=" %%T in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set "XUANSHU_SERVER_TOKEN=%%T"
  set "GENERATED_TOKEN=1"
) else (
  set "GENERATED_TOKEN=0"
)
if not defined XUANSHU_PORT set "XUANSHU_PORT=7318"
set "WEB_URL=http://127.0.0.1:%XUANSHU_PORT%/"
set "HEALTH_URL=%WEB_URL%health"

echo Building and starting ZhuLong XuanShu...
%COMPOSE% up -d --build
if errorlevel 1 (
  echo Docker Compose failed to start the services.
  %COMPOSE% ps
  %COMPOSE% logs --tail=100 xuanshu ctf-sandbox
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddMinutes(2); do { try { $response=Invoke-WebRequest -UseBasicParsing -Uri $env:HEALTH_URL -TimeoutSec 3; if ($response.StatusCode -eq 200) { exit 0 } } catch {} Start-Sleep -Seconds 2 } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
  echo ZhuLong XuanShu did not become healthy within 120 seconds.
  %COMPOSE% ps
  %COMPOSE% logs --tail=100 xuanshu ctf-sandbox
  pause
  exit /b 1
)

echo ZhuLong XuanShu is ready: %WEB_URL%
if "%GENERATED_TOKEN%"=="1" (
  echo This session's server token (paste it into the key icon in the UI):
  echo %XUANSHU_SERVER_TOKEN%
)
start "" "%WEB_URL%"
echo.
echo The browser has been opened. You can close this window after copying the token if needed.
pause
