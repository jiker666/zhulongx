#!/bin/sh

set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_ROOT"

COMPOSE=""
CONTAINER_ENGINE=""

# Prefer Podman when it is installed. On macOS, Podman needs a running
# machine; starting an existing machine is safe and keeps the one-click
# workflow usable without Docker Desktop.
if command -v podman >/dev/null 2>&1; then
  if ! podman info >/dev/null 2>&1; then
    echo "Podman is installed but its engine is not running. Attempting to start the Podman machine..."
    podman machine start >/dev/null 2>&1 || true
  fi
  if podman info >/dev/null 2>&1; then
    if podman compose version >/dev/null 2>&1; then
      COMPOSE="podman compose"
      CONTAINER_ENGINE="Podman Compose"
    elif command -v podman-compose >/dev/null 2>&1 && podman-compose version >/dev/null 2>&1; then
      COMPOSE="podman-compose"
      CONTAINER_ENGINE="podman-compose"
    else
      echo "Podman is running, but no Compose provider is available."
      echo "Install podman-compose or configure a Podman Compose provider, then run this script again."
      exit 1
    fi
  else
    echo "Podman is installed but unavailable. Docker Compose will be used if its engine is running."
    echo "To use Podman instead, run: podman machine init && podman machine start"
  fi
fi

if [ -z "$COMPOSE" ] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
    CONTAINER_ENGINE="Docker Compose"
  elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
    COMPOSE="docker-compose"
    CONTAINER_ENGINE="docker-compose"
  fi
fi

if [ -z "$COMPOSE" ]; then
  echo "A running Podman/Docker engine with a Compose provider is required."
  echo "For Podman on macOS: podman machine init && podman machine start, then install/configure podman-compose."
  exit 1
fi

if [ -z "${XUANSHU_SERVER_TOKEN:-}" ]; then
  if command -v openssl >/dev/null 2>&1; then
    XUANSHU_SERVER_TOKEN=$(openssl rand -hex 24)
  elif command -v uuidgen >/dev/null 2>&1; then
    XUANSHU_SERVER_TOKEN=$(uuidgen | tr -d '-').$(date +%s)
  else
    echo "Set XUANSHU_SERVER_TOKEN before running this script (openssl or uuidgen is unavailable)."
    exit 1
  fi
  export XUANSHU_SERVER_TOKEN
  GENERATED_TOKEN=1
else
  GENERATED_TOKEN=0
fi

export XUANSHU_PORT="${XUANSHU_PORT:-7318}"
WEB_URL="http://127.0.0.1:${XUANSHU_PORT}/"
HEALTH_URL="${WEB_URL}health"

echo "Building and starting ZhuLong XuanShu with $CONTAINER_ENGINE..."
$COMPOSE up -d --build

ready=0
attempt=1
while [ "$attempt" -le 60 ]; do
  if curl --silent --show-error --fail --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done

if [ "$ready" -ne 1 ]; then
  echo "ZhuLong XuanShu did not become healthy within 120 seconds."
  $COMPOSE ps
  $COMPOSE logs --tail=100 xuanshu ctf-sandbox || true
  exit 1
fi

echo "ZhuLong XuanShu is ready: $WEB_URL"
if [ "$GENERATED_TOKEN" -eq 1 ]; then
  echo "This session's server token (paste it into the key icon in the UI):"
  echo "$XUANSHU_SERVER_TOKEN"
fi

if command -v open >/dev/null 2>&1; then
  open "$WEB_URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$WEB_URL" >/dev/null 2>&1 &
else
  echo "Open $WEB_URL in your browser."
fi
