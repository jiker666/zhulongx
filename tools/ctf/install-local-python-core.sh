#!/usr/bin/env bash
set -euo pipefail

# Install the reviewed core dependencies into the selected interpreter's own
# site-packages. This is for a host-backed sandbox only; task runs must never
# invoke a package manager.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN=${XUANSHU_CTF_PYTHON:-python3}
SITE_PACKAGES=$("$PYTHON_BIN" -c 'import sysconfig; print(sysconfig.get_path("purelib"))')
if [ -z "$SITE_PACKAGES" ] || [ ! -d "$(dirname "$SITE_PACKAGES")" ]; then
  echo "Unable to resolve a writable Python site-packages directory for $PYTHON_BIN" >&2
  exit 1
fi

"$PYTHON_BIN" -m pip install \
  --disable-pip-version-check \
  --no-input \
  --no-cache-dir \
  --target "$SITE_PACKAGES" \
  --upgrade \
  -r "$SCRIPT_DIR/requirements-core.txt"
