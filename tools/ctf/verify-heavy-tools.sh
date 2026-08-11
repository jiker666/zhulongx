#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/ctf-venv/bin:${PATH}"

required_commands=(
  RsaCtfTool
  cado-nfs
  flatter
  r2
  sage
  stegseek
)

for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null
done

test -f /opt/RsaCtfTool/LICENSE.txt
test -f /opt/cado-nfs/COPYING
test -f /usr/share/doc/xuanshu-heavy/stegseek-COPYING
test -f /usr/share/doc/xuanshu-heavy/flatter-COPYING.LESSER
test -f /usr/share/doc/xuanshu-heavy/radare2-COPYING.md

sage -c 'assert factor(15) == 3 * 5'
RsaCtfTool --help >/dev/null
cado-nfs --help >/dev/null
r2 -v >/dev/null
stegseek --version >/dev/null

/opt/ctf-venv/bin/python - <<'PY'
import angr
import bitarray
import cryptography
import psutil
import qiling
import r2pipe
import torch
import transformers

assert bitarray.bitarray("101").to01() == "101"
assert psutil.cpu_count() is not None
PY
