#!/usr/bin/env bash
set -e
podman-compose down 2>/dev/null || podman compose down
echo "[CyberPilot] Podman services stopped."
