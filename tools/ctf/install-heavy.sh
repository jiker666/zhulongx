#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

readonly RSACTFTOOL_COMMIT="7c98848f1945de3e67a420871e8672f5ad9aa5d5"
readonly STEGSEEK_COMMIT="58969789a5724701048d5d5510af84098cc1f1ea"
readonly FLATTER_COMMIT="d2b8026f29b4a69e987b15d4b240f8a5053275d3"
readonly RADARE2_COMMIT="77618b4c7feaa294782c12040a634d5863ea71c1"
readonly CADO_NFS_COMMIT="9bb8fc0799bbaaf0b47a1edf573ecf5e0cf8e46a"

fetch_pinned_repo() {
  local repository="$1"
  local commit="$2"
  local target="$3"
  rm -rf "$target"
  git init -q "$target"
  git -C "$target" remote add origin "$repository"
  git -C "$target" fetch -q --depth 1 origin "$commit"
  git -C "$target" checkout -q --detach FETCH_HEAD
  test "$(git -C "$target" rev-parse HEAD)" = "$commit"
}

apt-get update
apt-get install -y --no-install-recommends \
  cmake \
  libbz2-dev \
  libeigen3-dev \
  libhwloc-dev \
  libjpeg62-turbo-dev \
  libmcrypt-dev \
  libmhash-dev \
  libopenblas-dev \
  sagemath \
  zlib1g-dev
rm -rf /var/lib/apt/lists/*
install -d /usr/share/doc/xuanshu-heavy

/opt/ctf-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel
/opt/ctf-venv/bin/pip install --no-cache-dir -r /app/tools/ctf/requirements-heavy.txt
/opt/ctf-venv/bin/pip install --no-cache-dir \
  --index-url https://download.pytorch.org/whl/cpu \
  torch==2.9.0

fetch_pinned_repo https://github.com/RsaCtfTool/RsaCtfTool.git "$RSACTFTOOL_COMMIT" /opt/RsaCtfTool
/opt/ctf-venv/bin/pip install --no-cache-dir --no-deps /opt/RsaCtfTool

fetch_pinned_repo https://github.com/RickdeJager/stegseek.git "$STEGSEEK_COMMIT" /tmp/stegseek
cmake -S /tmp/stegseek -B /tmp/stegseek/build -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/stegseek/build --parallel "$(nproc)"
cmake --install /tmp/stegseek/build
install -m 0644 /tmp/stegseek/COPYING /usr/share/doc/xuanshu-heavy/stegseek-COPYING
rm -rf /tmp/stegseek

fetch_pinned_repo https://github.com/keeganryan/flatter.git "$FLATTER_COMMIT" /tmp/flatter
cmake -S /tmp/flatter -B /tmp/flatter/build -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/flatter/build --parallel "$(nproc)"
cmake --install /tmp/flatter/build
install -m 0644 /tmp/flatter/COPYING.LESSER /usr/share/doc/xuanshu-heavy/flatter-COPYING.LESSER
rm -rf /tmp/flatter

fetch_pinned_repo https://github.com/radareorg/radare2.git "$RADARE2_COMMIT" /tmp/radare2
bash /tmp/radare2/sys/install.sh --install
install -m 0644 /tmp/radare2/COPYING.md /usr/share/doc/xuanshu-heavy/radare2-COPYING.md
rm -rf /tmp/radare2

fetch_pinned_repo https://gitlab.inria.fr/cado-nfs/cado-nfs.git "$CADO_NFS_COMMIT" /opt/cado-nfs
printf 'build_tree="/opt/cado-nfs/build/static"\n' > /opt/cado-nfs/local.sh
make -C /opt/cado-nfs -j"$(nproc)"
ln -sf /opt/cado-nfs/cado-nfs.py /usr/local/bin/cado-nfs
chmod +x /opt/cado-nfs/cado-nfs.py
ldconfig
