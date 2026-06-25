#!/usr/bin/env bash
set -e

echo "[CyberPilot] Stopping Podman Compose..."
: "${COMPOSE_PROJECT_NAME:=cyberpilot_v4}"
export COMPOSE_PROJECT_NAME
podman compose -f podman-compose.yml down
echo "[CyberPilot] Stopped."
