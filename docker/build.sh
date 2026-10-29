#!/bin/bash
# Assemble the managed-mode image: cross-compile the engine, stage the live
# skills, build, and export the tarball for platform upload.
set -euo pipefail
cd "$(dirname "$0")/.."

GO_BIN="$(command -v go || true)"
[ -z "$GO_BIN" ] && GO_BIN="/c/Program Files/Go/bin/go.exe"
echo "== engine (linux/amd64) =="
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" \
  "$GO_BIN" build -trimpath -o docker/build/zhulongx ./cmd/zhulongx

echo "== stage skills =="
rm -rf docker/build/skills
cp -r /c/Users/Jiker/.pi/agent/skills docker/build/skills
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

echo "== docker build =="
docker build -t zhulongx-agent:managed docker/

echo "== export =="
OUT=${1:-/e/1/tsecbench-work/agent-oci-managed.tar.gz}
docker save zhulongx-agent:managed | gzip > "$OUT"
echo "done: $OUT"
