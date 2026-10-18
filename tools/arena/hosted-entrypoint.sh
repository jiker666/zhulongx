#!/bin/sh
# zhulongx hosted-mode bootstrap (TSecBench 托管模式).
# One container, everything on stdout:
#   1. ctf-sandbox executor (CTF toolchain, external network)
#   2. xuanshu agent server (127.0.0.1:7318; + a DeepSeek fast server on
#      :7319 when both model keys are configured — R8 dual-model routing)
#   3. arena driver lanes: 4 deep + 2 prospector + 2 sweep (R31 8-lane plan)
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

# R25 multi-account GLM key pool (10h finals): two coding-plan-max accounts
# whose 5h quota windows cannot cover the run alone. The panel fills
# BIGMODEL_API_KEY (account 1) and optional BIGMODEL_API_KEY_2 (account 2);
# BIGMODEL_API_KEYS (raw comma list) overrides both. The gateway round-robins
# the pool and rotates on quota exhaustion before the self-funded DPSK rescue
# is ever touched (user ruling 2026-10-16: GLM first, DPSK strictly reserve).
GLM_POOL=""
if [ -n "${BIGMODEL_API_KEYS:-}" ]; then
  GLM_POOL="$BIGMODEL_API_KEYS"
elif [ -n "${BIGMODEL_API_KEY:-}" ]; then
  GLM_POOL="${BIGMODEL_API_KEY}${BIGMODEL_API_KEY_2:+,$BIGMODEL_API_KEY_2}"
fi
if [ -n "$GLM_POOL" ]; then
  export XUANSHU_MODEL_API_KEYS="$GLM_POOL"
fi

DPSK_ID="${DEEPSEEK_MODEL_ID:-deepseek-flash}"
DPSK_BASE="${DEEPSEEK_ANTHROPIC_BASE:-http://api.deepseek.com.tsecbench.gw/anthropic}"
# R30: deepseek-flash (2026-10-17) carries a 1M window; 400000 keeps parity
# with the GLM-shaped flows and stays far under the real ceiling.
DPSK_CTX="${DEEPSEEK_CONTEXT_WINDOW:-400000}"
# R31 user ruling 2026-10-17 (unlimited-quota deepseek-flash key): the R28
# conservative reasoner gates open up. Flash is fast and unmetered, so the
# DPSK servers run GLM-class concurrency gates; TPM is raised above 1M so
# max-thinking runs (400K ctx in + 61K budget) never queue behind the gate.
DPSK_MIN_MS="${DEEPSEEK_MIN_INTERVAL_MS:-100}"
DPSK_RPM="${DEEPSEEK_RPM:-600}"
DPSK_TPM="${DEEPSEEK_TPM:-20000000}"

# R30/R32: panel-settable reasoning budget. The SDK session is created with this
# level once (per-turn downgrade is impossible), so it must be right at boot:
# max = 61,440-token thinking budget (agent-driver THINKING_BUDGET_TOKENS).
# R32 ruling (2026-10-17): default MAX — quality per call beats call count on
# the slow single-key channel; the panel can dial it back with
# TSEC_THINKING_LEVEL=high if speed becomes the binding constraint.
# Applied before container-fast.yaml is generated, so both servers inherit it.
case "${TSEC_THINKING_LEVEL:-max}" in
  off|minimal|low|medium|high|xhigh|max) THINKING_LEVEL="${TSEC_THINKING_LEVEL:-max}" ;;
  *) THINKING_LEVEL="max" ;;
esac
# R38b: every boot starts from the pristine config. The dual-key seds below
# mutate container.yaml in place, so a container restart re-ran them on
# already-mutated files — container-fast.yaml regenerated from a flipped
# main and :7319 silently lost the GLM key pool. Restore-then-mutate makes
# boot N idempotent for any N; the .orig copy is taken exactly once.
[ -f config/container.yaml.orig ] || cp config/container.yaml config/container.yaml.orig
cp config/container.yaml.orig config/container.yaml
rm -f config/container-fast.yaml

sed -i "s|^  thinkingLevel: high|  thinkingLevel: ${THINKING_LEVEL}|" config/container.yaml

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
         -e "s|^  contextWindow: 400000|  contextWindow: ${DPSK_CTX}|" \
         -e "s|^  modelRequestsPerMinute: 600$|  modelRequestsPerMinute: ${DPSK_RPM}|" \
         -e "s|^  modelTokensPerMinute: 10000000$|  modelTokensPerMinute: ${DPSK_TPM}|" \
         config/container.yaml
else
  echo "[hosted] FATAL: configure BIGMODEL_API_KEY (GLM) and/or DEEPSEEK_API_KEY in the runtime env panel" >&2
  exit 1
fi

# Advisory gateway hints (older drivers/panels may read these; the /v1/runs
# server does not).
if [ "$DUAL_KEYS" = "0" ] && [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  export BIGMODEL_BASE_URL="${BIGMODEL_BASE_URL:-http://api.deepseek.com.tsecbench.gw/v1}"
  export ARENA_MODEL_ID="${ARENA_MODEL_ID:-${DPSK_ID}}"
else
  export BIGMODEL_BASE_URL="${BIGMODEL_BASE_URL:-http://open.bigmodel.cn.tsecbench.gw/api/anthropic}"
  export ARENA_MODEL_ID="${ARENA_MODEL_ID:-glm-5.3}"
fi
export XUANSHU_SERVER_TOKEN="${XUANSHU_SERVER_TOKEN:-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')}"
export XUANSHU_SANDBOX_NETWORK=external
export CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000

# R36 unlimited-token finals: the leaderboard's top tier burns ~1B tokens
# and token count is the LAST ranking tiebreak — raise every self-imposed
# ceiling below the platform gateway's own limits (GLM accepts ~100
# concurrent connections; 2 servers x 32 runs stays comfortably under).
export ARENA_PARALLEL="${ARENA_PARALLEL:-32}"
# Per-server run gate 16 -> 32 (matches maxConcurrentSdkSessions in
# container.yaml); two servers in dual-key mode carry up to 64 concurrent
# runs, each holding ~1 in-flight model request.
export XUANSHU_MAX_CONCURRENT_RUNS="${XUANSHU_MAX_CONCURRENT_RUNS:-32}"

mkdir -p /workspace/input /workspace/work /data/runs /run/xuanshu /app/workspace/tsec /workspace/tools
# Generic capability seeded into the sandbox-shared workspace (R5): a rogue
# LDAP(S) test server for directory-integration/JNDI challenges. Without it the
# agent hand-rolls BER encoding byte-by-byte against the target's error oracle
# and burns its whole budget on encoding bugs (live-run 28506).
cp /app/tools/arena/rogue-ldaps.py /workspace/tools/rogue-ldaps.py
# R22: rotating-captcha single-shot helper (fetch + tesseract OCR in one
# process) — 30661's captcha challenge died to interactive-loop staleness.
cp /app/tools/arena/captcha-ocr.py /workspace/tools/captcha-ocr.py

# Dual-model routing (R8/R28). DPSK_MODE=main (R28 ruling 2026-10-17, dpsk
# 主力 / glm 辅助): :7318 is flipped to DeepSeek-main for the 4 deep grinders
# while :7319 carries the GLM key pool for prospector + sweep + fan-outs.
# DPSK_MODE=lanes keeps :7318 GLM and makes :7319 a DeepSeek fast server.
# R37 (run 35842 post-mortem): this block MUST run before any server boots.
# `serve` reads its config once at startup, and the main-mode flip used to
# land AFTER :7318 was already up with the GLM config — so DPSK was never
# called in any hosted run (34998: 128/128 sessions glm-5.3; 35842: same).
DPSK_MODE="${TSEC_DPSK_MODE:-main}"
FAST_BASE="http://127.0.0.1:7318"
FAST_SERVER_DESC=""
if [ "$DUAL_KEYS" = "1" ] && [ "$DPSK_MODE" = "main" ]; then
  # R28 user ruling 2026-10-17 (dpsk 主力 / glm 辅助): mirror of the R8 split.
  # :7318 = DeepSeek main (3 deep grinders, proven conservative DPSK gates,
  # GLM auxiliary rescue fallback); :7319 = GLM key pool (prospector + sweep
  # bulk, aggressive GLM gates, DPSK rescue fallback). The fast config is
  # generated FIRST from the still-GLM container.yaml, then container.yaml
  # itself is flipped to DeepSeek-main so the two seds never fight.
  sed -e "s|^  port: 7318|  port: 7319|"       -e "s|^    apiKeyEnv: XUANSHU_FALLBACK_API_KEY|    apiKeyEnv: XUANSHU_FAST_FALLBACK_API_KEY|"       config/container.yaml > config/container-fast.yaml
  export XUANSHU_FAST_FALLBACK_API_KEY="$DEEPSEEK_API_KEY"
  export XUANSHU_DPSK_MAIN_API_KEY="$DEEPSEEK_API_KEY"
  export XUANSHU_FALLBACK_API_KEY="$BIGMODEL_API_KEY"
  sed -i -e "s|^  id: glm-5.3|  id: ${DPSK_ID}|"          -e "s|^  name: GLM 5.3|  name: DeepSeek Main|"          -e "s|^  baseUrl: https://open.bigmodel.cn/api/anthropic|  baseUrl: ${DPSK_BASE}|"          -e "s|^  apiKeyEnv: XUANSHU_MODEL_API_KEY|  apiKeyEnv: XUANSHU_DPSK_MAIN_API_KEY|"          -e "s|^  apiKeyPoolEnv: XUANSHU_MODEL_API_KEYS|  apiKeyPoolEnv: XUANSHU_DPSK_MAIN_POOL|"          -e "s|^  contextWindow: 400000|  contextWindow: ${DPSK_CTX}|"          -e "s|^  modelMinIntervalMs: 100$|  modelMinIntervalMs: ${DPSK_MIN_MS}|"          -e "s|^  modelRequestsPerMinute: 600$|  modelRequestsPerMinute: ${DPSK_RPM}|"          -e "s|^  modelTokensPerMinute: 10000000$|  modelTokensPerMinute: ${DPSK_TPM}|"          -e "s|^    id: ${DPSK_ID}|    id: glm-5.3|"          -e "s|^    name: DeepSeek Rescue|    name: GLM Auxiliary|"          -e "s|^    baseUrl: ${DPSK_BASE}|    baseUrl: https://open.bigmodel.cn/api/anthropic|"          -e "s|^    contextWindow: 128000|    contextWindow: 400000|"          config/container.yaml
  FAST_SERVER_DESC="GLM key pool (auxiliary bulk)"
elif [ "$DUAL_KEYS" = "1" ] && [ "$DPSK_MODE" = "lanes" ]; then
  sed -e "s|^  port: 7318|  port: 7319|"       -e "s|^  apiKeyPoolEnv: XUANSHU_MODEL_API_KEYS|  apiKeyPoolEnv: XUANSHU_FAST_MODEL_API_KEYS|"       -e "s|^  id: glm-5.3|  id: ${DPSK_ID}|"       -e "s|^  name: GLM 5.3|  name: DeepSeek Fast|"       -e "s|^  baseUrl: https://open.bigmodel.cn/api/anthropic|  baseUrl: ${DPSK_BASE}|"       -e "s|^  apiKeyEnv: XUANSHU_MODEL_API_KEY|  apiKeyEnv: XUANSHU_FAST_MODEL_API_KEY|"       -e "s|^  contextWindow: 400000|  contextWindow: ${DPSK_CTX}|"       -e "s|^  modelMinIntervalMs: 100$|  modelMinIntervalMs: ${DPSK_MIN_MS}|"       -e "s|^  modelRequestsPerMinute: 600$|  modelRequestsPerMinute: ${DPSK_RPM}|"       -e "s|^  modelTokensPerMinute: 10000000$|  modelTokensPerMinute: ${DPSK_TPM}|"       config/container.yaml > config/container-fast.yaml
  FAST_SERVER_DESC="${DPSK_ID} (fast bulk)"
fi

# R37 guard: verify the files say what this mode promises before anything
# boots on them — a silent no-op sed here IS the 35842 failure mode (all
# lanes on GLM, DPSK never called for the whole 8h run).
if [ "$DUAL_KEYS" = "1" ]; then
  case "$DPSK_MODE" in
    main)
      grep -q "^  id: ${DPSK_ID}" config/container.yaml         || echo "[hosted] WARN: DPSK main flip did not apply — :7318 stays GLM" >&2
      grep -q "^  port: 7319" config/container-fast.yaml         || echo "[hosted] WARN: fast-server port sed did not apply" >&2 ;;
    lanes)
      grep -q "^  id: ${DPSK_ID}" config/container-fast.yaml         || echo "[hosted] WARN: fast-server DPSK sed did not apply" >&2 ;;
  esac
  echo "[hosted] model wiring: :7318=$(grep -m1 '^  id:' config/container.yaml | awk '{print $2}') fallback=$(grep -m1 '^    id:' config/container.yaml | awk '{print $2}')"
fi

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

if [ -f config/container-fast.yaml ]; then
  echo "[hosted] dual-key ${DPSK_MODE} mode: fast-lane xuanshu server (${FAST_SERVER_DESC}) on :7319"
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

# R28: endgame/rich-retry fan-out workers ride the GLM pool server (120 RPM)
# while the deep lanes keep grinding on DeepSeek — a 54 RPM deep gate cannot
# feed an 18-run endgame swarm. Unset (reserve/lanes modes) keeps fan-outs on
# the lane's own server, exactly the pre-R28 behaviour.
if [ "$DUAL_KEYS" = "1" ] && [ "$DPSK_MODE" = "main" ]; then
  export XUANSHU_FANOUT_BASE="${XUANSHU_FANOUT_BASE:-$FAST_BASE}"
fi

# R34 egress gateway: script traffic (python/curl — src/sandbox.ts passes
# these into run_command children) flows through the in-driver rate-limiting
# proxy on :7321; challenge VPN targets get strict per-instance caps and 429
# circuit-breaking, public internet light shaping. Loopback/model/platform
# stay direct. TSEC_EGRESS=off disables both this export and the driver side.
if [ "${TSEC_EGRESS:-on}" = "on" ]; then
  export HTTP_PROXY="http://127.0.0.1:${TSEC_EGRESS_PORT:-7321}"
  export HTTPS_PROXY="$HTTP_PROXY"
  export http_proxy="$HTTP_PROXY"
  export https_proxy="$HTTP_PROXY"
  export NO_PROXY="127.0.0.1,localhost,::1,.tsecbench.gw,.zc.tencent.com,.bigmodel.cn,.deepseek.com,api.deepseek.com,169.254.169.254"
  export no_proxy="$NO_PROXY"
fi

echo "[hosted] launching driver lanes: 4 deep + 2 prospector + 2 sweep (8-lane R31 strategy)"
# R7 lane plan (bctf top-6 post-mortem): the 6-lane shape keeps the R4 deep
# grinders and prospector, and adds two sweep lanes for singles coverage —
# rich-retry picks on any lane fan out into directed workers. R8: in
# dual-key mode the prospector + sweep lanes run against the :7319 fast
# server while the deep lanes grind on the main model at :7318.
# R31 (50-challenge/100-flag finals, unlimited-quota ruling): 8 lanes — the
# extra deep lane widens the hard grind and the second prospector doubles
# fresh-opening throughput for the operator's easy-first directive. The
# per-server run gate is raised to the 16-session SDK ceiling
# (XUANSHU_MAX_CONCURRENT_RUNS), so the worst case (4 fan-outs + 4 singles
# = 16 concurrent per server) no longer queues.
# R28 8h one-shot: a crashed lane must not silently vanish for hours — each
# lane runs under a supervisor that restarts it after 30s. A CLEAN exit (rc=0)
# means the benchmark task ended or every challenge is solved; that stops the
# supervisor too. Ledger/claims/watches all expire safely across restarts.
lane_loop() {
  lane="$1"; role="$2"; base="$3"
  # R33: `set -eu` kills this subshell on the first non-zero foreground exit —
  # a crashed lane took its supervisor with it and silently vanished for the
  # rest of the run. The restart loop must be errexit-immune: set +e locally,
  # and rc is captured inside if/else (an errexit-exempt context) so both
  # paths reach the restart decision.
  set +e
  while true; do
    if [ -n "$base" ]; then
      if TSEC_LANE="$lane" TSEC_ROLE="$role" XUANSHU_BASE="$base" node tools/arena/tsec.mjs loop; then rc=0; else rc=$?; fi
    else
      if TSEC_LANE="$lane" TSEC_ROLE="$role" node tools/arena/tsec.mjs loop; then rc=0; else rc=$?; fi
    fi
    [ "$rc" -eq 0 ] && break
    echo "[hosted] lane $lane exited rc=$rc — restarting in 30s" >&2
    sleep 30
  done
}
lane_loop lane-a deep "" &
lane_loop lane-b deep "" &
lane_loop lane-c deep "" &
lane_loop lane-d deep "" &
lane_loop lane-e prospector "$FAST_BASE" &
lane_loop lane-f prospector "$FAST_BASE" &
lane_loop lane-g sweep "$FAST_BASE" &
lane_loop lane-h sweep "$FAST_BASE" &

# The lanes exit themselves when the benchmark task ends (invalid_state);
# the platform tears the container down at the task time limit regardless.
wait
