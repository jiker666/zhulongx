@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "COMPOSE="
set "CONTAINER_ENGINE="

where podman >nul 2>&1
if not errorlevel 1 (
  podman info >nul 2>&1
  if errorlevel 1 (
    echo Podman is installed but its engine is not running. Attempting to start the Podman machine...
    podman machine start >nul 2>&1
  )
  podman info >nul 2>&1
  if errorlevel 1 (
    echo Podman is unavailable. Docker Compose will be used if its engine is running.
    echo To use Podman instead, run: podman machine init ^&^& podman machine start
  ) else (
    podman compose version >nul 2>&1
    if not errorlevel 1 (
      set "COMPOSE=podman compose"
      set "CONTAINER_ENGINE=Podman Compose"
    ) else (
      podman-compose version >nul 2>&1
      if not errorlevel 1 (
        set "COMPOSE=podman-compose"
        set "CONTAINER_ENGINE=podman-compose"
      ) else (
        echo Podman is running, but no Compose provider is available.
        echo Install podman-compose or configure a Podman Compose provider, then run this script again.
        pause
        exit /b 1
      )
    )
  )
)

if not defined COMPOSE (
  docker info >nul 2>&1
  if not errorlevel 1 (
    docker compose version >nul 2>&1
    if not errorlevel 1 (
      set "COMPOSE=docker compose"
      set "CONTAINER_ENGINE=Docker Compose"
    ) else (
      docker-compose version >nul 2>&1
      if not errorlevel 1 (
        set "COMPOSE=docker-compose"
        set "CONTAINER_ENGINE=docker-compose"
      )
    )
  )
)

if not defined COMPOSE (
  echo A running Podman/Docker engine with a Compose provider is required.
  echo For Podman: start its machine and install/configure podman-compose.
  pause
  exit /b 1
)

rem A persistent .env (gitignored) keeps the server token stable across restarts.
if not defined XUANSHU_SERVER_TOKEN if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /I "%%A"=="XUANSHU_SERVER_TOKEN" set "XUANSHU_SERVER_TOKEN=%%B"
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

echo Building and starting ZhuLong XuanShu with %CONTAINER_ENGINE%...
%COMPOSE% up -d --build
if errorlevel 1 (
  echo Container Compose failed to start the services.
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
