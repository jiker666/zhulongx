#!/usr/bin/env sh
set -eu

CONFIG_PATH=${XUANSHU_CONFIG:-config/tsec-hosted.yaml}

for REQUIRED_ENV in BAIDU_API_KEY BENCHMARK_TOKEN BENCHMARK_BASE_URL; do
  eval "REQUIRED_VALUE=\${${REQUIRED_ENV}:-}"
  if [ -z "$REQUIRED_VALUE" ]; then
    echo "Missing required runtime environment variable: $REQUIRED_ENV" >&2
    exit 64
  fi
done

XUANSHU_SANDBOX_ENDPOINT=tcp://127.0.0.1:7320 \
  node dist/cli.js sandbox --config "$CONFIG_PATH" &
SANDBOX_PID=$!

cleanup() {
  kill "$SANDBOX_PID" 2>/dev/null || true
  wait "$SANDBOX_PID" 2>/dev/null || true
}
trap cleanup EXIT

ATTEMPT=0
until node dist/cli.js sandbox-health --config "$CONFIG_PATH" >/dev/null 2>&1; do
  if ! kill -0 "$SANDBOX_PID" 2>/dev/null; then
    wait "$SANDBOX_PID"
    exit 70
  fi
  ATTEMPT=$((ATTEMPT + 1))
  if [ "$ATTEMPT" -ge 30 ]; then
    echo "Timed out waiting for the sandbox service" >&2
    exit 70
  fi
  sleep 1
done

node dist/cli.js tsec-solve-once --config "$CONFIG_PATH"
