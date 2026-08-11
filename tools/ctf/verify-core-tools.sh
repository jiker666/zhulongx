#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/ctf-venv/bin:${PATH}"

required_commands=(
  base32
  bc
  convert
  dcfldd
  ecm
  factor
  ffprobe
  fsstat
  gcc
  gifsicle
  gp
  identify
  minimodem
  multimon-ng
  outguess
  pickora
  pngcheck
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
)

for command_name in "${required_commands[@]}"; do
  command -v "$command_name" >/dev/null
done

/opt/ctf-venv/bin/python - <<'PY'
import cysignals
import mmh3
import pickora
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
assert AES.block_size == 16
assert cp_model.CpModel().new_bool_var("x").name == "x"
assert callable(pickora.main)
assert callable(tqdm.tqdm)
assert z3.Solver().check() == z3.sat
PY
