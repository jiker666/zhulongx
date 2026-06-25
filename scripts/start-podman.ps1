# CyberPilot Podman Windows PowerShell Start Script
if (!(Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
}

Write-Host "[CyberPilot] Starting with Podman Compose..."
podman-compose up -d --build

Write-Host ""
Write-Host "[CyberPilot] Services started:"
Write-Host "  Frontend: http://localhost:3000"
Write-Host "  Backend:  http://localhost:8000"
Write-Host "  API Docs: http://localhost:8000/docs"
