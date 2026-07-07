#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR_DIR="${SCRIPT_DIR}/../vendor/claude-code"
CLI_JS="${VENDOR_DIR}/dist/cli.js"
if [[ ! -f "${CLI_JS}" ]]; then
  echo "Claude Code dist/cli.js not found. Build it first:" >&2
  echo "  cd ${VENDOR_DIR} && bun install && bun run build" >&2
  exit 127
fi
exec node "${CLI_JS}" "$@"
