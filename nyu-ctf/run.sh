#!/usr/bin/env bash
# NYU CTF Bench runner for zhulongx
# Usage: ./nyu-ctf/run.sh [OPTIONS]
#
# Options:
#   --bench-dir PATH    Path to nyu_ctf_bench repo (default: ~/nyu_ctf_bench)
#   --categories CATS   Comma-separated categories (default: all)
#   --max N             Max challenges per category (default: 0=all)
#   --concurrency N     Parallel runs (default: 1)
#   --evaluate-only     Skip running, only evaluate existing results
#   --analyze-only      Skip running, only analyze failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

# Defaults
BENCH_REPO="${NYU_CTF_REPO:-$HOME/nyu_ctf_bench}"
OUT_DIR="nyu-ctf/bench"
CATEGORIES="web,pwn,crypto,forensics,rev,misc"
MAX=0
CONCURRENCY=1
EVALUATE_ONLY=0
ANALYZE_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bench-dir) BENCH_REPO="$2"; shift 2;;
    --categories) CATEGORIES="$2"; shift 2;;
    --max) MAX="$2"; shift 2;;
    --concurrency) CONCURRENCY="$2"; shift 2;;
    --evaluate-only) EVALUATE_ONLY=1; shift;;
    --analyze-only) ANALYZE_ONLY=1; shift;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

# --- Step 1: Clone/update bench repo ---
if [[ $EVALUATE_ONLY -eq 0 && $ANALYZE_ONLY -eq 0 ]]; then
  if [[ ! -d "$BENCH_REPO" ]]; then
    echo "Cloning NYU CTF Bench to $BENCH_REPO ..."
    git clone --depth=1 https://github.com/nyu-llm-ctf/nyu_ctf_bench.git "$BENCH_REPO"
  else
    echo "Using existing bench repo at $BENCH_REPO"
  fi

  # --- Step 2: Run adapter ---
  echo ""
  echo "=== Setting up challenge directories ==="
  python3 nyu-ctf/setup.py \
    --bench-dir "$BENCH_REPO" \
    --out-dir "$OUT_DIR" \
    --split test \
    --categories "$CATEGORIES" \
    ${MAX:+--max $MAX}
fi

if [[ $ANALYZE_ONLY -eq 0 ]]; then
  # --- Step 3: Build project ---
  echo ""
  echo "=== Building project ==="
  npm run build

  # --- Step 4: Run question-bank-solve ---
  echo ""
  echo "=== Running NYU CTF Bench ==="
  export NYU_CTF_BENCH_DIR="$(pwd)/$OUT_DIR"

  node dist/cli.js question-bank-solve \
    --config config/nyu-ctf-wanqing.yaml \
    --concurrency "$CONCURRENCY"
fi

# --- Step 5: Evaluate results ---
echo ""
echo "=== Evaluating Results ==="
python3 nyu-ctf/evaluate.py \
  --bench-dir "$OUT_DIR" \
  --runs-dir .xuan-shu/nyu-runs \
  --output nyu-ctf/results.json

# --- Step 6: Analyze failures ---
echo ""
echo "=== Analyzing Failures ==="
python3 nyu-ctf/analyze_failures.py \
  --results nyu-ctf/results.json \
  --runs-dir .xuan-shu/nyu-runs \
  --output nyu-ctf/failure_report.md

echo ""
echo "=== Done ==="
echo "Results: nyu-ctf/results.json"
echo "Report:  nyu-ctf/failure_report.md"
