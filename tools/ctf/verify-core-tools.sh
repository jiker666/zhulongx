#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/ctf-venv/bin:${PATH}"

required_commands=(
  addr2line
  base32
  bc
  convert
  dcfldd
  ecm
  factor
  ffprobe
  fsstat
  gap
  gcc
  gdb-multiarch
  gifsicle
  gp
  identify
  jadx
  minimodem
  multimon-ng
  objcopy
  outguess
  patchelf
  pickora
  pwn
  pngcheck
  scalpel
  sox
  soxi
  steghide
  stegsnow
  tesseract
  tsk_recover
  vol
  xfs_db
  xfs_repair
  z3
  zbarimg
  zip
  zsteg
  r2
  rabin2
  rafind2
  ragg2
  rax2
  analyzeHeadless
  ghidra-decompile
  java
)

missing_commands=()
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null; then
    missing_commands+=("$command_name")
  fi
done
if [ "${#missing_commands[@]}" -gt 0 ]; then
  echo "Missing required core commands: ${missing_commands[*]}" >&2
  exit 1
fi

gap -q <<'GAP'
if Size(SymmetricGroup(3)) <> 6 then
  QUIT_GAP(1);
fi;
QUIT_GAP(0);
GAP
patchelf --version >/dev/null
# Debian's scalpel returns 1 after printing its version banner; accept that
# documented success-with-banner exit status while retaining other failures.
scalpel -V >/dev/null || test "$?" -eq 1
gdb-multiarch --version >/dev/null
r2 -v >/dev/null
jadx --version >/dev/null
# Ghidra headless must actually decompile, not merely exist: this catches
# missing aarch64/x86 natives, JDK mismatches, and script compile errors.
ghidra_probe=$(mktemp -d)
printf 'int main(void){return 42;}\n' > "$ghidra_probe/probe.c"
gcc -o "$ghidra_probe/probe" "$ghidra_probe/probe.c"
ghidra-decompile "$ghidra_probe/probe" "$ghidra_probe/probe.c.out"
grep -q '^// ===== ' "$ghidra_probe/probe.c.out"
grep -q 'main' "$ghidra_probe/probe.c.out"
rm -rf "$ghidra_probe"

/opt/ctf-venv/bin/python - <<'PY'
import cysignals
import mmh3
import numpy
import pickora
import pycosat
import tqdm
import volatility3
import z3
from Crypto.Cipher import AES
from fpylll import IntegerMatrix, LLL
from ortools.sat.python import cp_model

matrix = IntegerMatrix.from_matrix([[1, 1], [1, 0]])
LLL.reduction(matrix)
assert matrix.nrows == 2
assert mmh3.hash("crypto-misc-smoke") != 0
assert numpy is not None
assert AES.block_size == 16
assert cp_model.CpModel().new_bool_var("x").name == "x"
assert callable(pickora.main)
assert pycosat.solve([[1]]) == [1]
assert callable(tqdm.tqdm)
assert z3.Solver().check() == z3.sat
PY
