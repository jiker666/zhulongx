#!/usr/bin/env bash
set -e

echo "[CyberPilot] Starting with Podman Compose..."
cp -n .env.example .env 2>/dev/null || true

if command -v podman-compose &>/dev/null; then
    podman-compose up -d --build
elif command -v podman &>/dev/null; then
    podman compose up -d --build
else
    echo "[ERROR] podman-compose or podman not found."
    exit 1
fi

echo ""
echo "[CyberPilot] Services started:"
echo "  Frontend: http://localhost:3000"
echo "  Backend:  http://localhost:8000"
echo "  API Docs: http://localhost:8000/docs"
