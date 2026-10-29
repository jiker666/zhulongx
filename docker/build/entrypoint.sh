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

# Priority: derived from live platform data only (easy -> medium -> hard,
# then code order). No baked-in per-challenge knowledge.
curl -s --noproxy '*' -m 30 -H "BENCHMARK_TOKEN: $BENCHMARK_TOKEN" \
  "$BENCHMARK_BASE_URL/openapi/v1/challenges" \
  | jq -r 'sort_by({"easy":0,"medium":1,"hard":2}[.difficulty] // 9, .unique_code)
           | .[].unique_code' > /work/priority.txt
echo "queue: $(wc -l < /work/priority.txt) challenges"

/opt/zhx/zhulongx bench import --config /opt/zhx/managed.yaml \
  --priority-file /work/priority.txt

/opt/zhx/inject-facts.sh

exec /opt/zhx/zhulongx run --config /opt/zhx/managed.yaml
