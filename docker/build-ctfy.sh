#!/bin/bash
# Assemble the CTFY-0001 image: cross-compile the ctfyagent driver, reuse
# the staged toolbox (wordlists/skills/arsenal) from build.sh, build, and
# optionally export the tarball.
#
# Usage: docker/build-ctfy.sh [tarball-out]
#   Default tarball: /e/1/tsecbench-work/agent-oci-ctfy.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

GO_BIN="$(command -v go || true)"
if [ -z "$GO_BIN" ]; then
  if [ -x "/c/Program Files/Go/bin/go.exe" ]; then
    GO_BIN="/c/Program Files/Go/bin/go.exe"
  else
    GO_BIN="/mnt/c/Program Files/Go/bin/go.exe"
  fi
fi

echo "== ctfyagent (linux/amd64) =="
rm -f docker/build/ctfyagent ctfyagent
if [[ "$GO_BIN" == *.exe ]]; then
  "$GO_BIN" env -w GOOS=linux GOARCH=amd64 CGO_ENABLED=0
  restore_go_env() {
    "$GO_BIN" env -u GOOS GOARCH CGO_ENABLED >/dev/null 2>&1 || true
    rm -f ctfyagent
  }
  trap restore_go_env EXIT
  GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" "$GO_BIN" build -trimpath ./cmd/ctfyagent
  mv ctfyagent docker/build/ctfyagent
  restore_go_env
  trap - EXIT
else
  GOOS=linux GOARCH=amd64 CGO_ENABLED=0 GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" \
    "$GO_BIN" build -trimpath -o docker/build/ctfyagent ./cmd/ctfyagent
fi
MAGIC="$(dd if=docker/build/ctfyagent bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')"
[ "$MAGIC" = "7f454c46" ] || { echo "FATAL: ctfyagent is not a Linux ELF (magic=$MAGIC)"; exit 1; }
file docker/build/ctfyagent

echo "== staged toolbox present? =="
for d in docker/build/wordlists docker/build/skills docker/build/arsenal; do
  [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ] || {
    echo "FATAL: $d is empty — run docker/build.sh once first (it stages wordlists/skills/arsenal)"; exit 1; }
done

echo "== shell gate (CRLF kills in-container execution — run 44913) =="
for f in docker/build/ctfy-entrypoint.sh; do
  CR="$(tr -dc '\r' < "$f" | wc -c)"
  [ "$CR" -eq 0 ] || { echo "FATAL: $f has $CR CR bytes — convert to LF before building"; exit 1; }
done
[ -s docker/build/ctfy-doctrine.md ] || { echo "FATAL: ctfy-doctrine.md missing/empty"; exit 1; }
# Protocol inversion guard: this image must NOT ship pi provider config —
# the platform writes the funded provider into ~/.pi/agent (CTFY-0001 §1.1).
if grep -qE 'COPY build/pi-(models|settings)' docker/Dockerfile.ctfy; then
  echo "FATAL: Dockerfile.ctfy copies pi provider config — platform-owned path, funding would break"
  exit 1
fi

echo "== docker build =="
docker build -t zhulongx-agent:ctfy -f docker/Dockerfile.ctfy docker/

echo "== export =="
OUT=${1:-/e/1/tsecbench-work/agent-oci-ctfy.tar.gz}
if [ ! -d "$(dirname "$OUT")" ] && [[ "$OUT" =~ ^/([A-Za-z])(/.*)?$ ]]; then
  WSL_OUT="/mnt/${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
  [ -d "$(dirname "$WSL_OUT")" ] && OUT="$WSL_OUT"
fi
docker save zhulongx-agent:ctfy | gzip > "$OUT"
echo "done: $OUT"
