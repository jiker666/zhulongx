#!/bin/bash
# Assemble the managed-mode image: cross-compile the engine, stage the live
# skills, build, and export the tarball for platform upload.
set -euo pipefail
cd "$(dirname "$0")/.."

GO_BIN="$(command -v go || true)"
if [ -z "$GO_BIN" ]; then
  # Git Bash uses /c while WSL exposes the same drive at /mnt/c.
  if [ -x "/c/Program Files/Go/bin/go.exe" ]; then
    GO_BIN="/c/Program Files/Go/bin/go.exe"
  else
    GO_BIN="/mnt/c/Program Files/Go/bin/go.exe"
  fi
fi
echo "== engine (linux/amd64) =="
rm -f docker/build/zhulongx zhulongx
if [[ "$GO_BIN" == *.exe ]]; then
  # WSL interop does not reliably pass GOOS/GOARCH assignments to a Windows
  # Go executable. Use Go's persisted env settings for this one build, then
  # clear them before returning to the caller.
  "$GO_BIN" env -w GOOS=linux GOARCH=amd64 CGO_ENABLED=0
  restore_go_env() {
    "$GO_BIN" env -u GOOS GOARCH CGO_ENABLED >/dev/null 2>&1 || true
    rm -f zhulongx
  }
  trap restore_go_env EXIT
  GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" "$GO_BIN" build -trimpath ./cmd/zhulongx
  mv zhulongx docker/build/zhulongx
  restore_go_env
  trap - EXIT
else
  GOOS=linux GOARCH=amd64 CGO_ENABLED=0 GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" \
    "$GO_BIN" build -trimpath -o docker/build/zhulongx ./cmd/zhulongx
fi
ENGINE_MAGIC="$(dd if=docker/build/zhulongx bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')"
[ "$ENGINE_MAGIC" = "7f454c46" ] || { echo "FATAL: engine is not a Linux ELF (magic=$ENGINE_MAGIC)"; exit 1; }
file docker/build/zhulongx

echo "== stage skills =="
rm -rf docker/build/skills
SKILL_ROOT="/c/Users/Jiker/.pi/agent/skills"
if [ ! -d "$SKILL_ROOT" ]; then
  SKILL_ROOT="/mnt/c/Users/Jiker/.pi/agent/skills"
fi
[ -d "$SKILL_ROOT" ] || { echo "FATAL: pi skills directory not found"; exit 1; }
cp -r "$SKILL_ROOT" docker/build/skills
rm -f docker/build/skills/defense-spec -r

# Wordlists are NOT in git (secret-scanning push protection correctly blocks
# them — the flask key list is real leaked credentials). Stage them from
# primary + fallback CDNs; the flask list comes from the PyPI wheel, the most
# reliable source on this network. Existing files are kept as-is.
echo "== stage wordlists =="
WL=docker/build/wordlists
mkdir -p $WL/web $WL/passwords $WL/secrets
fetch() { out=$1; shift; for u in "$@"; do
  curl -fsSL --retry 2 --max-time 40 "$u" -o "$out.tmp" 2>/dev/null && [ -s "$out.tmp" ] && mv "$out.tmp" "$out" && return 0
done; rm -f "$out.tmp"; return 1; }
[ -s $WL/web/common.txt ] || fetch $WL/web/common.txt \
  "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@master/Discovery/Web-Content/common.txt" \
  "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@2024.3/Discovery/Web-Content/common.txt"
[ -s $WL/web/raft-medium-directories.txt ] || fetch $WL/web/raft-medium-directories.txt \
  "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@master/Discovery/Web-Content/raft-medium-directories.txt" \
  "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@2024.3/Discovery/Web-Content/raft-medium-directories.txt"
[ -s $WL/passwords/top10000.txt ] || fetch $WL/passwords/top10000.txt \
  "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@2024.3/Passwords/Common-Credentials/10-million-password-list-top-10000.txt" \
  "https://cdn.jsdelivr.net/gh/danielmiessler/SecLists@master/Passwords/Common-Credentials/10-million-password-list-top-10000.txt"
if [ ! -s $WL/secrets/flask-secret-keys.txt ]; then
  rm -rf /tmp/fuwl && mkdir -p /tmp/fuwl
  python -m pip download flask-unsign-wordlist --no-deps -d /tmp/fuwl -q &&
    python -I -X utf8 -c "import zipfile,glob; z=zipfile.ZipFile(glob.glob('/tmp/fuwl/*.whl')[0]); z.extract('flask_unsign_wordlist/wordlists/all.txt','/tmp/fuwl')" &&
    cp /tmp/fuwl/flask_unsign_wordlist/wordlists/all.txt $WL/secrets/flask-secret-keys.txt
fi
wc -l $WL/web/*.txt $WL/passwords/*.txt $WL/secrets/*.txt

echo "== shell gate =="
# Run 44913/45035 postmortem: every codex-era image shipped CRLF line endings
# on the executed scripts and injected ZERO env-discipline facts (briefs
# showed `facts: []`). A CRLF shebang (`#!/bin/bash\r`) silently breaks
# in-container execution. Gate ONLY the files bash executes or the engine
# parses — markdown/py the model merely reads has always shipped CRLF
# (skills/ tree, arsenal/README.md) without harm.
for f in docker/build/inject-facts.sh docker/build/entrypoint.sh docker/build/managed.yaml docker/build/inject-facts.sh; do
  CR="$(tr -dc '\r' < "$f" | wc -c)"
  [ "$CR" -eq 0 ] || { echo "FATAL: $f has $CR CR bytes — Windows editor rewrote it; convert to LF before building"; exit 1; }
done
# Parse the shipped fact-injection script and hold its CONTENT line to a small
# invariant: exactly one opening and one closing quote, with the tail marker
# inside (a shell-quoting truncation would otherwise ship a broken prompt).
bash -n docker/build/inject-facts.sh
bash -n docker/build/entrypoint.sh
CONTENT_LINE="$(sed -n '/^CONTENT=/p' docker/build/inject-facts.sh)"
NQ="$(tr -cd "'" <<<"$CONTENT_LINE" | wc -c)"
[ "$NQ" -eq 2 ] || { echo "FATAL: inject-facts.sh CONTENT has $NQ ASCII quotes (need exactly 2 — open+close)"; exit 1; }
[ "${#CONTENT_LINE}" -ge 3500 ] || { echo "FATAL: inject-facts.sh CONTENT collapsed to ${#CONTENT_LINE} chars — the full environment doctrine (~4000) must ship"; exit 1; }
case "$CONTENT_LINE" in
  *"解出永远优先于省 hint。"*) ;;
  *) echo "FATAL: inject-facts.sh CONTENT tail marker missing — string truncated?"; exit 1;;
esac

echo "== docker build =="
docker build -t zhulongx-agent:managed docker/

echo "== export =="
OUT=${1:-/e/1/tsecbench-work/agent-oci-managed.tar.gz}
if [ ! -d "$(dirname "$OUT")" ] && [[ "$OUT" =~ ^/([A-Za-z])(/.*)?$ ]]; then
  WSL_OUT="/mnt/${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
  [ -d "$(dirname "$WSL_OUT")" ] && OUT="$WSL_OUT"
fi
docker save zhulongx-agent:managed | gzip > "$OUT"
echo "done: $OUT"
