#!/usr/bin/env bash
set -euo pipefail

python3 -m venv /opt/ctf-venv
/opt/ctf-venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel
/opt/ctf-venv/bin/pip install --no-cache-dir -r /app/tools/ctf/requirements-core.txt

gem install --no-document one_gadget seccomp-tools zsteg
