#!/bin/sh
# zhulongx hosted-mode bootstrap (TSecBench 托管模式).
# One container, three process groups, everything on stdout:
#   1. ctf-sandbox executor (CTF toolchain, external network)
#   2. xuanshu agent server (127.0.0.1:7318)
#   3. arena driver lanes: 2 deep + 1 prospector (round-3 lane strategy)
# The platform injects BENCHMARK_BASE_URL / BENCHMARK_TOKEN; the model key
# comes from the runtime env panel. Model traffic goes through the platform
# gateway: <host>.tsecbench.gw over http (whitelist rules).
set -eu

: "${BENCHMARK_BASE_URL:?platform injects BENCHMARK_BASE_URL}"
: "${BENCHMARK_TOKEN:?platform injects BENCHMARK_TOKEN}"
: "${BIGMODEL_API_KEY:?configure BIGMODEL_API_KEY in the runtime env panel}"

export BIGMODEL_BASE_URL="${BIGMODEL_BASE_URL:-http://open.bigmodel.cn.tsecbench.gw/api/anthropic}"
export XUANSHU_MODEL_API_KEY="${XUANSHU_MODEL_API_KEY:-$BIGMODEL_API_KEY}"
export XUANSHU_SERVER_TOKEN="${XUANSHU_SERVER_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
export XUANSHU_SANDBOX_NETWORK=external
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000

mkdir -p /workspace/input /workspace/work /data/runs /run/xuanshu /app/workspace/tsec

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

echo "[hosted] launching driver lanes: 2 deep + 1 prospector"
TSEC_LANE=lane-a TSEC_ROLE=deep       node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-b TSEC_ROLE=deep       node tools/arena/tsec.mjs loop &
TSEC_LANE=lane-c TSEC_ROLE=prospector node tools/arena/tsec.mjs loop &

# The lanes exit themselves when the benchmark task ends (invalid_state);
# the platform tears the container down at the task time limit regardless.
wait
