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
# Run 43003: the first API response came back degraded, the jq pipeline
# wrote an EMPTY priority.txt without failing the script, and the whole
# queue degenerated to raw platform order (hardest tier fed at t+20).
# Retry until the list validates; the engine's import also re-sorts on
# its own fetch as a second line of defense.
codes=""
for i in 1 2 3 4 5 6; do
  codes=$(curl -s --noproxy '*' -m 30 -H "BENCHMARK_TOKEN: $BENCHMARK_TOKEN" \
      "$BENCHMARK_BASE_URL/openapi/v1/challenges" \
      | jq -r 'sort_by({"easy":0,"medium":1,"hard":2}[.difficulty] // 9, .unique_code)
               | .[].unique_code') || codes=""
  [ -n "$codes" ] && break
  echo "WARN: priority fetch attempt $i returned no codes — retrying in 15s"
  sleep 15
done
printf '%s\n' "$codes" > /work/priority.txt
echo "queue: $(wc -l < /work/priority.txt) challenges"

/opt/zhx/zhulongx bench import --config /opt/zhx/managed.yaml \
  --priority-file /work/priority.txt

/opt/zhx/inject-facts.sh

exec /opt/zhx/zhulongx run --config /opt/zhx/managed.yaml
