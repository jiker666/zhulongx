#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
IMAGE_NAME=${XUANSHU_CTF_SANDBOX_IMAGE:-zhulong-xuanshu-ctf-sandbox:v0.2.2}
BASE_IMAGE=${XUANSHU_CTF_SANDBOX_BASE_IMAGE:-zhulong-xuanshu-ctf-sandbox:dev}
CONTAINER_NAME=${XUANSHU_CTF_SANDBOX_CONTAINER:-zhulong-xuanshu-ctf-sandbox-local}
NETWORK_NAME=${XUANSHU_CTF_SANDBOX_NETWORK:-zhulong-xuanshu-internal}

mkdir -p "$PROJECT_ROOT/workspace" "$PROJECT_ROOT/.xuan-shu/work"

if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  if docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
    (cd "$PROJECT_ROOT" && npm run build)
    docker build \
      --file "$PROJECT_ROOT/Dockerfile.ctf-sandbox-overlay" \
      --build-arg "BASE_IMAGE=$BASE_IMAGE" \
      --tag "$IMAGE_NAME" \
      "$PROJECT_ROOT"
  else
    docker build \
      --file "$PROJECT_ROOT/Dockerfile.ctf-sandbox" \
      --tag "$IMAGE_NAME" \
      "$PROJECT_ROOT"
  fi
fi

# Permissive mode: the sandbox network allows external egress; container
# hardening below (read-only rootfs, dropped caps, resource limits) still applies.
# Recreate the network if an older internal-only deployment left one behind.
if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  if [ "$(docker network inspect "$NETWORK_NAME" --format '{{.Internal}}')" = "true" ]; then
    docker network rm "$NETWORK_NAME" >/dev/null
  fi
fi
if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  docker network create "$NETWORK_NAME" >/dev/null
fi

exec docker run --rm \
  --name "$CONTAINER_NAME" \
  --network "$NETWORK_NAME" \
  --publish 127.0.0.1:7320:7320 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 4g \
  --cpus 4 \
  --user 0:0 \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m \
  --env XUANSHU_SANDBOX_ENDPOINT=tcp://0.0.0.0:7320 \
  --env XUANSHU_SANDBOX_NETWORK=external \
  --volume "$PROJECT_ROOT/workspace:/workspace/input:ro" \
  --volume "$PROJECT_ROOT/.xuan-shu/work:/workspace/work" \
  "$IMAGE_NAME"
