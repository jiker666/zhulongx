# Testing and benchmark

Run the deterministic backend and v3 suites with the configured Python
environment. Run Worker E2E only after starting `worker-base`:

```bash
cd backend
python -m pytest -q
python -m pytest -q tests/test_agent_engine_*.py
python -m pytest -q tests/test_worker_e2e.py
```

Competition tests assert that the facade creates `AgentSession` instances and
emits canonical events. Worker E2E covers command output, PTY interaction,
abort propagation, process-tree cleanup, timeout cleanup, network-mode failure,
and workspace traversal defenses. These tests are integration evidence, not a
live-model solve-rate claim.
