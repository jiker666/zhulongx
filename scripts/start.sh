#!/usr/bin/env bash
set -e

echo "[CyberPilot] Starting with Podman Compose..."
cp -n .env.example .env 2>/dev/null || true
: "${COMPOSE_PROJECT_NAME:=cyberpilot_v4}"
: "${FRONTEND_PORT:=13000}"
: "${BACKEND_PORT:=18000}"
export COMPOSE_PROJECT_NAME FRONTEND_PORT BACKEND_PORT
podman compose -f podman-compose.yml up -d --build

echo ""
echo "[CyberPilot] Services started:"
echo "  Frontend: http://localhost:${FRONTEND_PORT}"
echo "  Backend:  http://localhost:${BACKEND_PORT}"
echo "  API Docs: http://localhost:${BACKEND_PORT}/docs"
