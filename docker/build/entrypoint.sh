#!/bin/bash
# Managed-mode entrypoint: wire pi to the platform LLM gateway, import the
# challenge queue, then run the engine in the foreground until it exits.
set -euo pipefail

: "${BENCHMARK_BASE_URL:?BENCHMARK_BASE_URL is injected by the platform}"
: "${BENCHMARK_TOKEN:?BENCHMARK_TOKEN is injected by the platform}"
: "${ZHIPU_API_KEY:?configure ZHIPU_API_KEY as a runtime env var}"

PI_DIR=/root/.pi/agent
mkdir -p "$PI_DIR" /work/attack

# pi model config: gateway rewrite (managed) unless LOCAL_TEST=1 (direct API,
# for validating the image outside the platform sandbox).
if [ "${LOCAL_TEST:-0}" = "1" ]; then
  cp /opt/zhx/pi-models.local.json "$PI_DIR/models.json"
else
  cp /opt/zhx/pi-models.gw.json "$PI_DIR/models.json"
fi
cp /opt/zhx/pi-settings.json "$PI_DIR/settings.json"
cp /opt/zhx/local-toolbox.container.md "$PI_DIR/skills/local-toolbox/SKILL.md"

cd /work

# Queue ordering lives in the engine (bench import sorts by the platform's
# own difficulty labels from its typed fetch). Run 43065: this shell-side
# jq sort silently degraded to raw-API order when the response's sort-key
# field stopped matching — a 6-flag intranet siege fed at position 4 and 7
# titles never saw a container. No ordering derivation here anymore.
/opt/zhx/zhulongx bench import --config /opt/zhx/managed.yaml

/opt/zhx/inject-facts.sh

exec /opt/zhx/zhulongx run --config /opt/zhx/managed.yaml
