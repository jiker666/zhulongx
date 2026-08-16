#!/usr/bin/env bash
set -euo pipefail

RADARE2_VERSION=6.2.0
case "$(dpkg --print-architecture)" in
  amd64)
    RADARE2_SHA256=eb82324e83315887fbee6f5d8632c982c593e056a87180f1bec5ccb06c463aeb
    ;;
  arm64)
    RADARE2_SHA256=e866525e9874588d478d536cca38cf9a7562896725efb4119b886101fd93f1ec
    ;;
  *)
    echo "Unsupported Radare2 architecture: $(dpkg --print-architecture)" >&2
    exit 1
    ;;
esac

PACKAGE="radare2_${RADARE2_VERSION}_$(dpkg --print-architecture).deb"
URL="https://github.com/radareorg/radare2/releases/download/${RADARE2_VERSION}/${PACKAGE}"

curl --http1.1 --fail --location --retry 5 --retry-all-errors --retry-delay 2 \
  --silent --show-error "$URL" --output "/tmp/${PACKAGE}"
echo "${RADARE2_SHA256}  /tmp/${PACKAGE}" | sha256sum --check --status
apt-get update
apt-get install -y --no-install-recommends "/tmp/${PACKAGE}"
rm -f "/tmp/${PACKAGE}"
rm -rf /var/lib/apt/lists/*

r2 -v >/dev/null
rabin2 -v >/dev/null
