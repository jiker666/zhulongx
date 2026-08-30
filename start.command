#!/bin/sh

set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PROJECT_ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Desktop and run this script again."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Docker Compose is required (docker compose or docker-compose)."
  echo "Install or update Docker Desktop, then run this script again."
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

echo "Building and starting ZhuLong XuanShu..."
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
