# CyberPilot Windows PowerShell Stop Script
Write-Host "[CyberPilot] Stopping Podman Compose..."
if (!$env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME = "cyberpilot_v4" }
podman compose -f podman-compose.yml down
Write-Host "[CyberPilot] Stopped."
