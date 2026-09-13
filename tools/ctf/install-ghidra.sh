#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# Ghidra headless decompiler. Bookworm has no openjdk-21 package, so the JDK
# comes from a pinned Eclipse Temurin tarball. Official Ghidra releases ship
# linux x86_64 decompiler natives only: on arm64 hosts the native is executed
# through qemu-user with multiarch x86_64 runtime libraries, which keeps the
# JVM itself native. Every artifact is verified by SHA-256; tools/ctf/deps/
# can pre-seed the archives to build offline.
readonly GHIDRA_VERSION="12.1.3"
readonly GHIDRA_BUILD="20260817"
readonly GHIDRA_ZIP="ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_BUILD}.zip"
readonly GHIDRA_SHA256="93a5d11a9ad510622acaaf908c556a7b9b764d338e78a7567f3689bf5081fd54"
readonly GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${GHIDRA_ZIP}"
readonly GHIDRA_ROOT="/opt/ghidra_${GHIDRA_VERSION}_PUBLIC"

readonly JDK_TAG="21.0.12.1+1"
case "$(dpkg --print-architecture)" in
  arm64)
    readonly JDK_PACKAGE="OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz"
    readonly JDK_SHA256="23e37e026f12f3e706f18938ff611db3032d075b09d0879a25d06718c773e223"
    ;;
  amd64)
    readonly JDK_PACKAGE="OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz"
    readonly JDK_SHA256="ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94"
    ;;
  *)
    echo "install-ghidra: unsupported architecture: $(dpkg --print-architecture)" >&2
    exit 1
    ;;
esac
readonly JDK_URL="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-${JDK_TAG//+/%2B}/${JDK_PACKAGE}"
readonly JDK_ROOT="/opt/jdk-temurin-21"
readonly DEPS_DIR="$(cd "$(dirname "$0")" && pwd)/deps"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

fetch_artifact() {
  local url="$1" sha256="$2" file="$3"
  local cached="$DEPS_DIR/$file"
  if [ -f "$cached" ]; then
    echo "install-ghidra: using pre-seeded $file"
    install -m 0644 "$cached" "$workdir/$file"
  else
    echo "install-ghidra: downloading $file"
    curl --fail --silent --show-error --location --output "$workdir/$file" "$url"
  fi
  echo "$sha256  $workdir/$file" | sha256sum --check --strict
}

if [ "$(dpkg --print-architecture)" = "arm64" ]; then
  dpkg --add-architecture amd64
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends qemu-user libc6:amd64 libstdc++6:amd64
fi
apt-get update -qq
apt-get install -y -qq --no-install-recommends unzip
rm -rf /var/lib/apt/lists/*

echo "install-ghidra: installing JDK ${JDK_TAG}"
fetch_artifact "$JDK_URL" "$JDK_SHA256" "$JDK_PACKAGE"
mkdir -p "$JDK_ROOT"
tar --extract --gunzip --file "$workdir/$JDK_PACKAGE" --directory "$JDK_ROOT" --strip-components=1
for binary in java javac jar; do
  ln -sf "$JDK_ROOT/bin/$binary" "/usr/local/bin/$binary"
done

echo "install-ghidra: installing Ghidra ${GHIDRA_VERSION}"
fetch_artifact "$GHIDRA_URL" "$GHIDRA_SHA256" "$GHIDRA_ZIP"
unzip -q "$workdir/$GHIDRA_ZIP" -d /opt
test -d "$GHIDRA_ROOT"
ln -sf "$GHIDRA_ROOT/support/analyzeHeadless" /usr/local/bin/analyzeHeadless

if [ "$(dpkg --print-architecture)" = "arm64" ]; then
  # Ghidra resolves decompiler natives from os/<platform dir>/, where the
  # aarch64 Linux platform dir is linux_arm_64; bridge it to the bundled
  # x86_64 binary through qemu-user.
  native_root="$GHIDRA_ROOT/Ghidra/Features/Decompiler/os"
  mkdir -p "$native_root/linux_arm_64"
  for native in decompile sleigh; do
    printf '#!/bin/sh\nexec qemu-x86_64 "$(dirname "$0")/../linux_x86_64/%s" "$@"\n' "$native" \
      > "$native_root/linux_arm_64/$native"
    chmod 0755 "$native_root/linux_arm_64/$native"
  done
fi

install -d /opt/ghidra-scripts
install -m 0644 "$(dirname "$0")/DumpDecompiled.java" /opt/ghidra-scripts/DumpDecompiled.java

cat > /usr/local/bin/ghidra-decompile <<'WRAPPER'
#!/bin/sh
# ghidra-decompile <binary> [output.c]
# Headless-decompiles every function into one C pseudocode file with
# "// ===== name @ address =====" separators. Default output: <binary>.c
set -eu
if [ "$#" -lt 1 ]; then
  echo "usage: ghidra-decompile <binary> [output.c]" >&2
  exit 2
fi
TARGET=$(readlink -f "$1")
OUT=${2:-"${TARGET}.c"}
mkdir -p "$(dirname "$OUT")"
OUT=$(readlink -f "$OUT")
PROJECT=$(mktemp -d)
trap 'rm -rf "$PROJECT"' EXIT
JAVA_HOME=/opt/jdk-temurin-21 analyzeHeadless "$PROJECT" decompile \
  -import "$TARGET" \
  -scriptPath /opt/ghidra-scripts \
  -postScript DumpDecompiled.java "$OUT" \
  -deleteProject >/dev/null
FUNCTIONS=$(grep -c '^// ===== ' "$OUT" || true)
echo "decompiled ${FUNCTIONS} functions -> ${OUT}"
WRAPPER
chmod 0755 /usr/local/bin/ghidra-decompile

echo "install-ghidra: ghidra ${GHIDRA_VERSION} + temurin ${JDK_TAG} installed"
