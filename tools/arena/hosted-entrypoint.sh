#!/bin/sh
# zhulongx hosted-mode bootstrap (TSecBench 托管模式).
# One container, everything on stdout:
#   1. ctf-sandbox executor (CTF toolchain, external network)
#   2. xuanshu agent server (127.0.0.1:7318; + a DeepSeek fast server on
#      :7319 when both model keys are configured — R8 dual-model routing)
#   3. arena driver lanes: 3 deep + 1 prospector + 2 sweep (round-7 lane plan)
#      - 3 deep lanes: hard singles + chains (scratch inheritance, long budgets)
#      - 1 prospector lane: fresh opens only — compressed probes on any
#        difficulty to surface quick wins, or map boards for deep lanes.
#      - 2 sweep lanes: singles coverage — the R5 harvest-sweep pools drain
#        faster with dedicated lanes instead of borrowing deep grinders.
#      - rich-retry picks on any lane fan out into 3 directed workers (R7).
# The platform injects BENCHMARK_BASE_URL / BENCHMARK_TOKEN; the model key
# comes from the runtime env panel (BIGMODEL_API_KEY for GLM, DEEPSEEK_API_KEY
# for the fast lanes; set both for the dual-model split).
set -eu

: "${BENCHMARK_BASE_URL:?platform injects BENCHMARK_BASE_URL}"
: "${BENCHMARK_TOKEN:?platform injects BENCHMARK_TOKEN}"

# --- model wiring (R8, bctf top-6 post-mortem: dual-model routing) ----------
# The /v1/runs API ignores modelId/baseUrl body fields: the model a run uses
# is fixed by the serving config, so model routing = server routing. With BOTH
# a GLM key and a DeepSeek key in the runtime env panel, a second server on
# :7319 (config/container-fast.yaml, DeepSeek) carries the fast lanes
# (prospector + sweep) while :7318 keeps GLM for the deep grinders — the
# champion's cost split: bulk calls on a fast model, hard chains on the strong
# reasoner. Single-key deployments keep the one-server behavior (DeepSeek-only
# now actually rewires the config; the old env-var hints never reached the
# /v1/runs server on their own).
DUAL_KEYS=0
if [ -n "${BIGMODEL_API_KEY:-}" ] && [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  DUAL_KEYS=1
fi

DPSK_ID="${DEEPSEEK_MODEL_ID:-deepseek-reasoner}"
DPSK_BASE="${DEEPSEEK_ANTHROPIC_BASE:-http://api.deepseek.com.tsecbench.gw/anthropic}"

if [ "$DUAL_KEYS" = "1" ]; then
  export XUANSHU_MODEL_API_KEY="${XUANSHU_MODEL_API_KEY:-$BIGMODEL_API_KEY}"
  export XUANSHU_FAST_MODEL_API_KEY="${XUANSHU_FAST_MODEL_API_KEY:-$DEEPSEEK_API_KEY}"
  # R19 rescue wiring: container.yaml ships the fallback block with a
  # placeholder id/baseUrl (dpsk-4.1 @ api.deepseek.com); point it at the
  # same platform DeepSeek gateway the fast lanes use so gateway failover
  # and modelRole:"fallback" rescue dispatch actually reach a live model.
  export XUANSHU_FALLBACK_API_KEY="${XUANSHU_FALLBACK_API_KEY:-$DEEPSEEK_API_KEY}"
  sed -i -e "s|^    id: dpsk-4.1|    id: ${DPSK_ID}|" \
         -e "s|^    name: DPSK 4.1|    name: DeepSeek Rescue|" \
         -e "s|^    baseUrl: https://api.deepseek.com/anthropic|    baseUrl: ${DPSK_BASE}|" \
         config/container.yaml
elif [ -n "${BIGMODEL_API_KEY:-}" ]; then
  export XUANSHU_MODEL_API_KEY="${XUANSHU_MODEL_API_KEY:-$BIGMODEL_API_KEY}"
elif [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  export XUANSHU_MODEL_API_KEY="${XUANSHU_MODEL_API_KEY:-$DEEPSEEK_API_KEY}"
  sed -i -e "s|^  id: glm-5.3|  id: ${DPSK_ID}|" \
         -e "s|^  name: GLM 5.3|  name: DeepSeek|" \
         -e "s|^  baseUrl: https://open.bigmodel.cn/api/anthropic|  baseUrl: ${DPSK_BASE}|" \
         -e "s|^  contextWindow: 400000|  contextWindow: 128000|" \
         config/container.yaml
else
  echo "[hosted] FATAL: configure BIGMODEL_API_KEY (GLM) and/or DEEPSEEK_API_KEY in the runtime env panel" >&2
  exit 1
fi

# Advisory gateway hints (older drivers/panels may read these; the /v1/runs
# server does not).
if [ "$DUAL_KEYS" = "0" ] && [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  export BIGMODEL_BASE_URL="${BIGMODEL_BASE_URL:-http://api.deepseek.com.tsecbench.gw/v1}"
  export ARENA_MODEL_ID="${ARENA_MODEL_ID:-deepseek-reasoner}"
else
  export BIGMODEL_BASE_URL="${BIGMODEL_BASE_URL:-http://open.bigmodel.cn.tsecbench.gw/api/anthropic}"
  export ARENA_MODEL_ID="${ARENA_MODEL_ID:-glm-5.3}"
fi
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

# Dual-model routing (R8, bctf top-6 post-mortem): the #1 agent ran a model
# ensemble (cheap/fast model for the bulk of calls, a stronger reasoner for
# hard chains). When both keys are configured, a second xuanshu server on
# :7319 carries the fast lanes (sweep/prospector) on DeepSeek while the deep
# grinders stay on the proven GLM. Each server has its own rate gate and its
# own upstream key, so the per-key gateway quota holds. Falls back to the
# single server if :7319 fails to come up.
FAST_BASE="http://127.0.0.1:7318"
if [ "$DUAL_KEYS" = "1" ]; then
  sed -e "s|^  port: 7318|  port: 7319|" \
      -e "s|^  id: glm-5.3|  id: ${DPSK_ID}|" \
      -e "s|^  name: GLM 5.3|  name: DeepSeek Fast|" \
      -e "s|^  baseUrl: https://open.bigmodel.cn/api/anthropic|  baseUrl: ${DPSK_BASE}|" \
      -e "s|^  apiKeyEnv: XUANSHU_MODEL_API_KEY|  apiKeyEnv: XUANSHU_FAST_MODEL_API_KEY|" \
      -e "s|^  contextWindow: 400000|  contextWindow: 128000|" \
      config/container.yaml > config/container-fast.yaml
  echo "[hosted] dual-key mode: fast-lane xuanshu server (${DPSK_ID}) on :7319"
  node dist/cli.js serve --config config/container-fast.yaml &
  for i in $(seq 1 60); do
    node -e "fetch('http://127.0.0.1:7319/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && break
    sleep 1
  done
  if node -e "fetch('http://127.0.0.1:7319/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    FAST_BASE="http://127.0.0.1:7319"
  else
    echo "[hosted] WARN: fast server unhealthy; fast lanes fall back to :7318"
  fi
fi

echo "[hosted] launching driver lanes: 3 deep + 1 prospector + 2 sweep (6-lane R7 strategy)"
# R7 lane plan (bctf top-6 post-mortem): the 6-lane shape keeps the R4 deep
# grinders and prospector, and adds two sweep lanes for singles coverage —
# rich-retry picks on any lane fan out into 3 directed workers. 6 lanes keep
# the worst case (3 fan-outs + 3 singles = 12 concurrent runs) under the
# server's 16-session gate and the gateway's 60 RPM soft limit. R8: in
# dual-key mode the prospector + sweep lanes run against the :7319 DeepSeek
# server (fast bulk model) while the deep lanes grind on GLM at :7318.
TSEC_LANE=lane-a TSEC_ROLE=deep                     node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-b TSEC_ROLE=deep                     node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-c TSEC_ROLE=deep                     node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-d TSEC_ROLE=prospector XUANSHU_BASE="$FAST_BASE" node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-e TSEC_ROLE=sweep      XUANSHU_BASE="$FAST_BASE" node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-f TSEC_ROLE=sweep      XUANSHU_BASE="$FAST_BASE" node tools/arena/tsec.mjs loop &

# The lanes exit themselves when the benchmark task ends (invalid_state);
# the platform tears the container down at the task time limit regardless.
wait
