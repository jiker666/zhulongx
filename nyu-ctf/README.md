# NYU CTF Bench Adapter

This directory contains the adapter, evaluator, and failure analyzer for
running the external NYU CTF Bench through zhulongx's question-bank runtime.

The challenge corpus is intentionally not vendored. It may contain large
archives, binaries, and evaluator-only answer metadata. Keep the upstream
checkout in an operator-owned path and set `NYU_CTF_REPO` or pass
`--bench-dir` when preparing a local copy.

## Run

```bash
./nyu-ctf/run.sh \
  --bench-dir /path/to/nyu_ctf_bench \
  --categories crypto,misc \
  --max 20
```

The script builds `nyu-ctf/bench` locally, runs the configured question-bank
worker, evaluates submissions, and writes a local failure report. These
generated paths are ignored by Git.

Use `config/nyu-ctf-wanqing.yaml` with credentials supplied only through
environment variables. Do not commit model keys, benchmark tokens, flags, or
run artifacts.
