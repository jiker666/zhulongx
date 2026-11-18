#!/bin/bash
# CTFY-0001 entrypoint. The binary handles the protocol (dry run, funding
# check, rounds, result.json); this wrapper only guarantees the working
# directory exists and hands over.
#
# Deliberately NOT done here (protocol §1.1): writing ~/.pi/agent/models.json
# or settings.json. The platform pre-writes pi's provider config into the
# image user's $HOME when LLM_BASE_URL is set, and an image-shipped file at
# those exact paths would win and strand the run on a dead provider. The
# TSecBench entrypoint copies its gateway config there — that habit must
# not cross over to this image.
set -euo pipefail

WD="${CTFY_WORK_DIR:-/ctfy/work}"
mkdir -p "$WD"

exec /opt/zhx/ctfyagent
