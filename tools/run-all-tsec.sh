#!/usr/bin/env bash
# run-all-tsec.sh  — 并发跑所有未完成 TSec 题目
# 用法: bash tools/run-all-tsec.sh [config] [concurrency] [prefix_filter]
#   config         默认 config/tsec-wanqing.yaml
#   concurrency    默认 1（串行运行，避免共享模型额度争用）
#   prefix_filter  可选，空格分隔的题目前缀，如 "f1 f2" 或 "a e1"，默认跑全部
set -euo pipefail

CONFIG="${1:-config/tsec-wanqing.yaml}"
CONCURRENCY="${2:-1}"   # default 1: avoid shared TPM exhaustion across parallel agents
FILTER="${3:-}"   # e.g. "f1 f2" or "a" or "" for all
LOG_DIR=".xuan-shu/tsec-batch-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
SUMMARY="$LOG_DIR/summary.jsonl"

echo "[run-all-tsec] config=$CONFIG  concurrency=$CONCURRENCY  filter='${FILTER}'  log=$LOG_DIR  started=$(date -Iseconds)"

# 加载 .env
set -a; source .env 2>/dev/null || true; set +a
export TSEC_SKIP_VPN=1

# ── 工具函数 ──────────────────────────────────────────────────────────────────

# 检查平台 API 是否可达（VPN 健康）
api_alive() {
  node -e "
const { createTSecClient } = require('./dist/tsec.js');
createTSecClient().listChallenges()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
" 2>/dev/null
}

# 等待 VPN/平台恢复，最多等 10 分钟
wait_for_api() {
  local tries=0
  while ! api_alive; do
    tries=$((tries + 1))
    if [ "$tries" -ge 40 ]; then
      echo "[run-all-tsec] FATAL: platform unreachable after 10 min, aborting." >&2
      exit 1
    fi
    echo "[run-all-tsec] Platform unreachable (try $tries/40), waiting 15s..."
    sleep 15
  done
}

# 关闭平台上所有活跃靶场实例（清理前次残留）
close_active_instances() {
  echo "[run-all-tsec] Closing any active challenge instances..."
  node -e "
const { createTSecClient } = require('./dist/tsec.js');
const client = createTSecClient();
client.listChallenges()
  .then(async cs => {
    const active = cs.filter(c => !c.is_completed && c.container_status === 'available' && c.container_addr && c.container_addr.length > 0);
    if (active.length === 0) { console.log('No active instances.'); return; }
    for (const c of active) {
      try {
        await client.closeChallenge(c.unique_code);
        console.log('Closed:', c.unique_code);
      } catch(e) {
        console.log('Close failed for', c.unique_code, ':', e.message);
      }
    }
  })
  .catch(e => console.log('list failed:', e.message));
" 2>&1 || true
  sleep 3
}

# 从日志尾部提取最终 JSON 结果（支持多行嵌套 JSON）
extract_result() {
  local log="$1"
  tail -60 "$log" | python3 -c "
import sys, json, re

text = sys.stdin.read()

# Strategy 1: find last block that starts with '{' and contains '\"outcome\"'
# Walk backwards through potential JSON starts
candidates = []
for i, ch in enumerate(text):
    if ch == '{':
        # Try to parse from here
        for end in range(len(text), i, -1):
            chunk = text[i:end]
            try:
                d = json.loads(chunk)
                if 'outcome' in d or 'state' in d:
                    candidates.append(d)
                    break
            except:
                pass

if candidates:
    d = candidates[-1]
    print(json.dumps(d))
    sys.exit(0)

print(json.dumps({'raw': text.strip()[-300:]}))
" 2>/dev/null || echo '{"raw":"parse_error"}'
}

# 解题函数（带网络中断重试）
solve_challenge() {
  local CODE="$1"
  local IDX="$2"
  local TOTAL="$3"
  local CHALLENGE_LOG="$LOG_DIR/${CODE}.log"
  local START_TS
  START_TS=$(date +%s)

  echo "[run-all-tsec] [$IDX/$TOTAL] START $CODE at $(date +%H:%M:%S)"

  local attempt=0
  local OUTCOME="unknown"
  local RESULT

  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))

    # 等 API 可达再开始
    wait_for_api

    # 运行 agent
    set +e
    npm run dev -- tsec-solve-once \
      --challenge-code "$CODE" \
      --config "$CONFIG" \
      >>"$CHALLENGE_LOG" 2>&1
    local EXIT_CODE=$?
    set -e

    RESULT=$(extract_result "$CHALLENGE_LOG")
    OUTCOME=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('outcome','unknown'))" 2>/dev/null || echo "unknown")

    if [ "$OUTCOME" = "solved" ]; then
      break
    fi

    # 判断是否值得重试
    local STOP_REASON
    STOP_REASON=$(echo "$RESULT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
r=d.get('stopReason','')
raw=d.get('raw','')
transient_keys=['SIGTERM','temporarily unavailable','graceful shutdown','Request timed out','fetch failed','Connection error','ECONNREFUSED','ENOTFOUND','network']
if any(k.lower() in (r+raw).lower() for k in transient_keys):
    print('transient')
else:
    print('no')
" 2>/dev/null || echo "no")

    if [ "$STOP_REASON" = "transient" ] && [ "$attempt" -lt 3 ]; then
      echo "[run-all-tsec] [$IDX/$TOTAL] $CODE transient failure (attempt $attempt), waiting 30s before retry..."
      sleep 30
    else
      break
    fi
  done

  local END_TS
  END_TS=$(date +%s)
  local ELAPSED=$((END_TS - START_TS))

  # 写 summary（原子追加）
  echo "{\"code\":\"$CODE\",\"idx\":$IDX,\"total\":$TOTAL,\"outcome\":\"$OUTCOME\",\"elapsed_s\":$ELAPSED,\"result\":$RESULT}" >> "$SUMMARY"

  if [ "$OUTCOME" = "solved" ]; then
    local AWARDED
    AWARDED=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('submission',{}).get('awarded','?'))" 2>/dev/null || echo "?")
    echo "[run-all-tsec] [$IDX/$TOTAL] ✓ SOLVED $CODE  awarded=$AWARDED  (${ELAPSED}s)"
  else
    local STOP
    STOP=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('stopReason',d.get('raw','?'))[:80])" 2>/dev/null || echo "?")
    echo "[run-all-tsec] [$IDX/$TOTAL] ✗ FAILED $CODE  outcome=$OUTCOME  reason=$STOP  (${ELAPSED}s)"
  fi
}

export -f solve_challenge extract_result wait_for_api api_alive
export TSEC_FILTER="$FILTER"
export CONFIG LOG_DIR SUMMARY

# ── 主流程 ────────────────────────────────────────────────────────────────────

# 等待已有 agent 进程结束
while pgrep -f "tsec-solve-once" > /dev/null 2>&1; do
  echo "[run-all-tsec] Waiting for existing tsec-solve-once to finish..."
  sleep 15
done

# 等平台可达
wait_for_api
echo "[run-all-tsec] Platform is reachable."

# 清理残留实例
close_active_instances

# 获取未完成列表
CODES=$(node -e "
const { createTSecClient } = require('./dist/tsec.js');
const filter = process.env.TSEC_FILTER ? process.env.TSEC_FILTER.split(' ').filter(Boolean) : [];
createTSecClient().listChallenges()
  .then(cs => {
    let codes = cs.filter(c => !c.is_completed).map(c => c.unique_code);
    if (filter.length > 0) codes = codes.filter(c => filter.some(p => c.startsWith(p)));
    if (codes.length > 0) process.stdout.write(codes.join('\n') + '\n');
  })
  .catch(e => { process.stderr.write('LIST_ERROR: ' + e.message + '\n'); process.exit(1); });
" 2>&1)

if echo "$CODES" | grep -q "LIST_ERROR"; then
  echo "[run-all-tsec] ERROR fetching list: $CODES"
  exit 1
fi

if [ -z "$CODES" ]; then
  echo "[run-all-tsec] All challenges already completed!"
  exit 0
fi

# 转为数组（兼容 macOS bash 3.2）
CODE_ARRAY=()
while IFS= read -r line; do
  [ -n "$line" ] && CODE_ARRAY+=("$line")
done <<< "$CODES"
TOTAL=${#CODE_ARRAY[@]}
echo "[run-all-tsec] Found $TOTAL incomplete challenges."

# ── 并发执行（信号量控制最大并发数 = CONCURRENCY）────────────────────────────
IDX=0
ACTIVE_PIDS=()

for CODE in "${CODE_ARRAY[@]}"; do
  IDX=$((IDX + 1))

  # 等待空闲槽
  while [ "${#ACTIVE_PIDS[@]}" -ge "$CONCURRENCY" ]; do
    NEW_PIDS=()
    for PID in "${ACTIVE_PIDS[@]}"; do
      if kill -0 "$PID" 2>/dev/null; then
        NEW_PIDS+=("$PID")
      fi
    done
    ACTIVE_PIDS=("${NEW_PIDS[@]+"${NEW_PIDS[@]}"}")
    if [ "${#ACTIVE_PIDS[@]}" -ge "$CONCURRENCY" ]; then
      sleep 2
    fi
  done

  # 启动并发子进程
  (solve_challenge "$CODE" "$IDX" "$TOTAL") &
  ACTIVE_PIDS+=($!)

  # 避免平台在短时间内收到大量 start 请求
  sleep 3
done

# 等待所有子进程结束
for PID in "${ACTIVE_PIDS[@]+"${ACTIVE_PIDS[@]}"}"; do
  wait "$PID" 2>/dev/null || true
done

echo ""
echo "=========================================="
echo "[run-all-tsec] Batch finished at $(date -Iseconds)"
echo "Summary: $SUMMARY"
echo "=========================================="

# 最终汇总报告
export SUMMARY_FILE="$SUMMARY"
python3 - <<'PYEOF'
import json, os, pathlib, sys

s = pathlib.Path(os.environ['SUMMARY_FILE'])
if not s.exists():
    print("No summary file found.")
    sys.exit(0)

lines = [json.loads(l) for l in s.read_text().splitlines() if l.strip()]
solved  = [l for l in lines if l.get('outcome') == 'solved']
failed  = [l for l in lines if l.get('outcome') != 'solved']
awarded = sum(l.get('result', {}).get('submission', {}).get('awarded', 0) for l in solved)

print(f"\n=== BATCH RESULT ===")
print(f"Solved  : {len(solved)}/{len(lines)}")
print(f"Awarded : {awarded} pts this batch")
print(f"\nSOLVED:")
for l in sorted(solved, key=lambda x: x['code']):
    sub = l.get('result', {}).get('submission', {})
    print(f"  ✓ {l['code']:<10} awarded={str(sub.get('awarded','?')):>5}  cumulative={sub.get('cumulativeScore','?')}  ({l.get('elapsed_s','?')}s)")
print(f"\nFAILED:")
for l in sorted(failed, key=lambda x: x['code']):
    r = l.get('result', {})
    reason = r.get('stopReason', r.get('raw', '?'))
    if isinstance(reason, str): reason = reason[:80]
    print(f"  ✗ {l['code']:<10} outcome={l.get('outcome','?'):<20} elapsed={l.get('elapsed_s','?')}s  reason={reason}")
PYEOF
