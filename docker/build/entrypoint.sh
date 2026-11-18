#!/bin/bash
# Managed-mode entrypoint: wire pi to the platform LLM gateway, import the
# challenge queue, then run the engine in the foreground until it exits.
set -euo pipefail

# Keep missing runtime configuration visible in hosted logs. Do not print
# values: the token and model key must never enter the image or log stream.
require_env() {
  local name="$1" hint="$2"
  if [ -z "${!name:-}" ]; then
    echo "STARTUP_CONFIG_ERROR: ${name} is missing (${hint})" >&2
    exit 78
  fi
}
# Some hosted launchers expose the same gateway credential under the
# Anthropic-compatible name used by their runner. Normalize it in-process;
# neither source value is written to disk or printed.
if [ -z "${ZHIPU_API_KEY:-}" ] && [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  export ZHIPU_API_KEY="$ANTHROPIC_AUTH_TOKEN"
fi
require_env BENCHMARK_BASE_URL "platform task endpoint"
require_env BENCHMARK_TOKEN "platform-injected task credential"
require_env ZHIPU_API_KEY "managed model gateway credential (ZHIPU_API_KEY or ANTHROPIC_AUTH_TOKEN)"

command -v pi >/dev/null 2>&1 || { echo "STARTUP_DEPENDENCY_ERROR: pi executable not found" >&2; exit 127; }
[ -x /opt/zhx/zhulongx ] || { echo "STARTUP_DEPENDENCY_ERROR: zhulongx engine missing or not executable" >&2; exit 127; }

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

# Queue ordering lives in the engine (bench import sorts by the platform's
# typed difficulty labels). Keep ordering logic out of this shell wrapper so
# the engine always sees the complete platform-provided queue.
/opt/zhx/zhulongx bench import --config /opt/zhx/managed.yaml

# The env-discipline fact is the run's backbone (runs 44913/45035 injected it
# into ZERO goals and fell off the 90% line). Fail loudly — not silently.
INJ="$(/opt/zhx/inject-facts.sh 2>&1)"
echo "$INJ"
case "$INJ" in
  *"env facts injected: 0 goals"*|*"INJECT_BROKEN"*)
    echo "ENTRYPOINT_INJECT_BROKEN: doctrine fact reached zero goals — briefs are degraded; check status output and CRLF" >&2 ;;
esac

exec /opt/zhx/zhulongx run --config /opt/zhx/managed.yaml
