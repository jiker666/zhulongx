#!/usr/bin/env bash
set -euo pipefail

JADX_VERSION=1.5.5
JADX_SHA256=38a5766d3c8170c41566b4b13ea0ede2430e3008421af4927235c2880234d51a
ARCHIVE="jadx-${JADX_VERSION}.zip"
URL="https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/${ARCHIVE}"

curl --http1.1 --fail --location --retry 5 --retry-all-errors --retry-delay 2 \
  --silent --show-error "$URL" --output "/tmp/${ARCHIVE}"
echo "${JADX_SHA256}  /tmp/${ARCHIVE}" | sha256sum --check --status
rm -rf /opt/jadx
mkdir -p /opt/jadx
unzip -q "/tmp/${ARCHIVE}" -d /opt/jadx
rm -f "/tmp/${ARCHIVE}"
chmod +x /opt/jadx/bin/jadx /opt/jadx/bin/jadx-gui
ln -sf /opt/jadx/bin/jadx /usr/local/bin/jadx

jadx --version >/dev/null
