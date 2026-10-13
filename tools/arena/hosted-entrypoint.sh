#!/bin/sh
# zhulongx hosted-mode bootstrap (TSecBench 托管模式).
# One container, four process groups, everything on stdout:
#   1. ctf-sandbox executor (CTF toolchain, external network)
#   2. xuanshu agent server (127.0.0.1:7318)
#   3. arena driver lanes: 3 deep + 1 prospector + 2 sweep (round-7 lane plan)
#      - 3 deep lanes: hard singles + chains (scratch inheritance, long budgets)
#      - 1 prospector lane: fresh opens only — compressed probes on any
#        difficulty to surface quick wins, or map boards for deep lanes.
#      - 2 sweep lanes: singles coverage — the R5 harvest-sweep pools drain
#        faster with dedicated lanes instead of borrowing deep grinders.
#      - rich-retry picks on any lane fan out into 3 directed workers (R7).
# The platform injects BENCHMARK_BASE_URL / BENCHMARK_TOKEN; the model key
# comes from the runtime env panel. Model traffic goes through the platform
# gateway: <host>.tsecbench.gw over http (whitelist rules).
set -eu

: "${BENCHMARK_BASE_URL:?platform injects BENCHMARK_BASE_URL}"
: "${BENCHMARK_TOKEN:?platform injects BENCHMARK_TOKEN}"
# Accept either BIGMODEL_API_KEY (GLM) or DEEPSEEK_API_KEY; the container.yaml
# model gateway uses BIGMODEL_API_KEY as the env var name so map DEEPSEEK into
# it when only the DeepSeek key is present.
if [ -z "${BIGMODEL_API_KEY:-}" ] && [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  export BIGMODEL_API_KEY="${DEEPSEEK_API_KEY}"
fi
: "${BIGMODEL_API_KEY:?configure BIGMODEL_API_KEY (or DEEPSEEK_API_KEY) in the runtime env panel}"

# Gateway routing: prefer DEEPSEEK gateway if DEEPSEEK_API_KEY is set and
# BIGMODEL_BASE_URL is not explicitly overridden by the operator.
if [ -z "${BIGMODEL_BASE_URL:-}" ]; then
  if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
    export BIGMODEL_BASE_URL="http://api.deepseek.com.tsecbench.gw/v1"
    export ARENA_MODEL_ID="${ARENA_MODEL_ID:-deepseek-reasoner}"
  else
    export BIGMODEL_BASE_URL="http://open.bigmodel.cn.tsecbench.gw/api/anthropic"
    export ARENA_MODEL_ID="${ARENA_MODEL_ID:-glm-5.3}"
  fi
fi
export XUANSHU_MODEL_API_KEY="${XUANSHU_MODEL_API_KEY:-$BIGMODEL_API_KEY}"
export XUANSHU_SERVER_TOKEN="${XUANSHU_SERVER_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
export XUANSHU_SANDBOX_NETWORK=external
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000

# Increase parallel model requests: lanes + fan-out workers need a wider
# gate; capped under the platform gateway's 60 RPM soft limit (R7: 8; the
# bctf top-6 post-mortem showed token throughput tracks rank — #1 burned
# ~1.4B tokens across 4 models while our 4-lane single-stream runs used a
# fraction of the quota).
export ARENA_PARALLEL="${ARENA_PARALLEL:-8}"

mkdir -p /workspace/input /workspace/work /data/runs /run/xuanshu /app/workspace/tsec /workspace/tools
# Generic capability seeded into the sandbox-shared workspace (R5): a rogue
# LDAP(S) test server for directory-integration/JNDI challenges. Without it the
# agent hand-rolls BER encoding byte-by-byte against the target's error oracle
# and burns its whole budget on encoding bugs (live-run 28506).
cp /app/tools/arena/rogue-ldaps.py /workspace/tools/rogue-ldaps.py

echo "[hosted] starting ctf-sandbox executor"
node dist/cli.js sandbox --config config/container.yaml &
for i in $(seq 1 60); do
  node dist/cli.js sandbox-health --config config/container.yaml >/dev/null 2>&1 && break
  sleep 1
done
node dist/cli.js sandbox-health --config config/container.yaml >/dev/null 2>&1 \
  || { echo "[hosted] FATAL: ctf-sandbox failed to become healthy"; exit 1; }

echo "[hosted] starting xuanshu server"
node dist/cli.js serve --config config/container.yaml &
for i in $(seq 1 60); do
  node -e "fetch('http://127.0.0.1:7318/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
  sleep 1
done
node -e "fetch('http://127.0.0.1:7318/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
  || { echo "[hosted] FATAL: xuanshu server failed to become healthy"; exit 1; }

echo "[hosted] launching driver lanes: 3 deep + 1 prospector + 2 sweep (6-lane R7 strategy)"
# R7 lane plan (bctf top-6 post-mortem): the 6-lane shape keeps the R4 deep
# grinders and prospector, and adds two sweep lanes for singles coverage —
# rich-retry picks on any lane fan out into 3 directed workers. 6 lanes keep
# the worst case (3 fan-outs + 3 singles = 12 concurrent runs) under the
# server's 16-session gate and the gateway's 60 RPM soft limit.
TSEC_LANE=lane-a TSEC_ROLE=deep       node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-b TSEC_ROLE=deep       node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-c TSEC_ROLE=deep       node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-d TSEC_ROLE=prospector node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-e TSEC_ROLE=sweep      node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-f TSEC_ROLE=sweep      node tools/arena/tsec.mjs loop &

# The lanes exit themselves when the benchmark task ends (invalid_state);
# the platform tears the container down at the task time limit regardless.
wait
