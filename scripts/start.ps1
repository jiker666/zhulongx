# CyberPilot Windows PowerShell Start Script
if (!(Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[CyberPilot] .env created from .env.example"
}

Write-Host "[CyberPilot] Starting with Podman Compose..."
if (!$env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME = "cyberpilot_v4" }
if (!$env:FRONTEND_PORT) { $env:FRONTEND_PORT = "13000" }
if (!$env:BACKEND_PORT) { $env:BACKEND_PORT = "18000" }
podman compose -f podman-compose.yml up -d --build

Write-Host ""
Write-Host "[CyberPilot] Services started:"
Write-Host "  Frontend: http://localhost:$env:FRONTEND_PORT"
Write-Host "  Backend:  http://localhost:$env:BACKEND_PORT"
Write-Host "  API Docs: http://localhost:$env:BACKEND_PORT/docs"
