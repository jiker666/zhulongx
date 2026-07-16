#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
SANDBOX_IMAGE="${AGENT_SANDBOX_IMAGE:-python:3.11-slim}"
JUNIT_PATH="${TMPDIR:-/tmp}/zhulongx-container-release.xml"

cd "$ROOT"
docker pull "$SANDBOX_IMAGE"

"$PYTHON" -m compileall -q backend/app worker/app

(
  cd backend
  AGENT_SANDBOX_RUNTIME=docker AGENT_SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    "$PYTHON" -m pytest -q --maxfail=20
  AGENT_SANDBOX_RUNTIME=docker AGENT_SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    "$PYTHON" -m pytest -q tests/test_agent_engine_*.py
  AGENT_SANDBOX_RUNTIME=docker AGENT_SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    "$PYTHON" -m pytest -q tests/test_agent_engine_container_sandbox.py --junitxml="$JUNIT_PATH"
)

JUNIT_PATH="$JUNIT_PATH" "$PYTHON" - <<'PY'
import os
import xml.etree.ElementTree as ET

root = ET.parse(os.environ["JUNIT_PATH"]).getroot()
suites = [root] if root.tag == "testsuite" else list(root)
totals = {
    key: sum(int(suite.attrib.get(key, 0)) for suite in suites)
    for key in ("tests", "failures", "errors", "skipped")
}
assert totals == {"tests": 5, "failures": 0, "errors": 0, "skipped": 0}, totals
print(totals)
PY

(
  cd frontend
  npm ci
  npm run lint
  npm run test --if-present
  npm run build
)

"$PYTHON" scripts/safety_audit.py
"$PYTHON" scripts/check_release.py
"$PYTHON" scripts/package_release.py
"$PYTHON" scripts/check_release_archive.py
