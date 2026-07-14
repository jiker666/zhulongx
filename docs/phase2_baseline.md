# Phase 2 baseline and destructive acceptance

Date: 2026-07-11. Environment: Windows host, Python 3.14, FastAPI/SQLAlchemy, Docker Worker not started, `winpty` unavailable.

## Commands and measured results

```powershell
cd backend
python -m pytest tests/test_competition_runtime.py -q
# 10 passed in 7.36s

python -m pytest -vv --maxfail=1
# did not complete within the 60s command window; pytest ended while flushing
# stdout with OSError: [Errno 22] Invalid argument
```

The targeted suite covers real TCP menu I/O, HTTP Cookie persistence, repeated
action denial, evidence updates, candidate rejection, and lifecycle state
changes. It does not prove PTY, Worker, persistence, replay, or legacy-runtime
Broker convergence.

## Acceptance findings

- Static call-site search confirms `AgentRuntime._exec_run_shell`,
  `_exec_run_python`, `_exec_http_request`, `_exec_grep`, and archive helpers
  directly use sandbox/http clients. `CtfOrchestrator` also directly calls
  `sandbox.run_shell` and `sandbox.run_python`. This is a real FAIL for unified
  Broker execution.
- `competition_runtime.py` stores controller states in an in-memory dictionary;
  no Competition/Challenge/Hypothesis/Evidence/Trace repository exists for the
  new path. Restart recovery is therefore not available.
- No Linux Worker/PTY endpoint exists in Docker Compose. Windows has no
  `winpty` package in the environment; PTY must be reported unsupported, never
  simulated.
- New HTTP/TCP session objects are real, but lifecycle records, Worker process
  groups, and persistent Trace/Replay are absent.
- New verification rejects evidence-free candidates, but legacy CTF candidate
  extraction still sets `best_flag` from `FlagVerifier` output. The legacy path
  is not yet forced through a single CandidateService.

## Determinism fix

The ScopeGuard default-public-host test now injects a fixed resolver result for
`example.com`. Production DNS and ScopeGuard rules were not relaxed.

## Honest status

This baseline is intentionally not a competition-ready claim. The highest-risk
unresolved items are legacy sandbox bypass, absence of persistent/replay state,
and absence of a real Linux Worker/PTY with cancellation propagation.
