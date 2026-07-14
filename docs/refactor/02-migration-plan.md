# Migration Plan

## File disposition

### Preserve

- `backend/app/api/` task intake, upload, auth, and UI-facing endpoints
- `frontend/` operational UI and current user changes
- `backend/app/core/scope_guard.py` concepts, adapted behind v2 policy contracts
- deterministic analyzers and solvers, only after registration as tools
- persistence/report presentation code that can become event projections
- OpenAI-compatible connectivity, moved behind the v2 provider interface

### Migrate or rewrite

- `backend/app/core/agent_runtime.py` -> `backend/app/agent_engine/session.py` and `loop.py`
- `backend/app/core/tool_protocol.py`, `backend/app/tools/`, and private runtime executors -> one v2 Tool Registry
- task evidence, shell history, and script runs -> append-only events plus projections
- `backend/app/core/code_execution_sandbox.py` -> test and container sandbox implementations
- provider behavior in `backend/app/core/llm_adapter.py` -> v2 provider adapters
- eager skill prompt injection -> v2 SkillIndex and `load_skill`
- flag extraction/verification -> scenario-owned candidate validators
- `scripts/hard_ctf_benchmark.py` and `scripts/solve_ctf_case.py` -> formal AgentSession benchmark runner

### Retire after v2 acceptance

- `_agent_think_legacy` and phase-owned solve actions in `ctf_agent_orchestrator.py`
- `CcBridgeRuntime` as a primary or fallback runtime
- `CC_RUNTIME_*` configuration
- `_sync_runtime_to_task()` replay projection
- large embedded payload/writeup-search system prompts
- baseline result files presented as Agent solve rate
- recovered `backend/vendor/claude-code`, `frontend/node_modules`, `.skills/vendor`, databases, run workspaces, and local `.env` files from release artifacts

Development dependencies can remain installed locally. Release packaging must exclude them without deleting unrelated user work.

## Milestone 0: containment

1. Delete the two local secret-bearing `.env` files without printing their values; document that the credential must be rotated.
2. Add root pytest discovery configuration restricted to `backend/tests`.
3. Move the default run root outside the repository while keeping an environment override.
4. Replace lexical/host exceptions with resolved workspace containment and reject symlink escapes.
5. Validate ZIP and TAR members before extraction.
6. Own child process groups and terminate the tree on timeout or abort.
7. Make cancellation reach the active runtime/sandbox before task bookkeeping is cleared.
8. Exclude secrets, runtime data, recovered vendor trees, dependency trees, and VCS data from release packages.

Acceptance tests include path traversal, absolute path, symlink escape, archive traversal, process-tree timeout/abort, pytest collection scope, and package manifest checks.

## Milestone 1: walking skeleton

1. Add serializable `RunRequest` and `SessionState` without CTF-only answer fields.
2. Add append-only event storage with per-run sequences, redaction, and `after_sequence` reads.
3. Add one readable tool-use loop and one lifecycle owner.
4. Add a registry where each definition contains its real executor.
5. Validate arguments, authorize permissions, enforce timeout, bound results, and emit all decisions.
6. Add a scripted mock provider.
7. Add seven base tools: list, read, write, grep, shell, Python, and candidate submission.
8. Add deterministic end-to-end tests: read -> Python -> candidate -> validator -> succeeded, plus denied and failed tool paths.

Milestone 1 does not claim production sandbox readiness or live-model capability.

## Milestone 2: usable kernel

- OpenAI-compatible provider with native tools, bounded retries, timeout, abort, usage, and redacted raw references
- checkpoints that store structured state, summary, budget, and event offset
- resume without re-executing completed tool calls
- progressive skill index and `load_skill`
- CTF validator with evidence binding and offline/authoritative checks
- API adapter, active run manager, incremental events, and legacy UI projections
- v2 as explicit default with no hidden fallback
- ten AgentSession-driven blind cases

## Milestone 3: general scenarios and evidence

- five scenario plugins and scenario-specific completion schemas
- container sandbox as the production default
- at least 20 hidden cases, each run three times with fixed budgets
- metrics for validated rate, false answers, intervention, invalid calls, timeout, latency, token/cost, and reproducibility
- one coherent README, deployment guide, configuration reference, test report, and release manifest

## Test commands

Use a Python 3.11+ environment with `backend/requirements.txt` installed. On the audited workstation the compatible interpreter is `/Users/j1k3r/miniforge3/bin/python3`.

```bash
# Safe discovery after pytest.ini exists
/Users/j1k3r/miniforge3/bin/python3 -m pytest --collect-only -q

# Milestone 0
/Users/j1k3r/miniforge3/bin/python3 -m pytest -q \
  backend/tests/test_agent_runtime_loop.py \
  backend/tests/test_filesystem_tools_safe_path.py \
  backend/tests/test_archive_zip_slip.py \
  backend/tests/test_code_sandbox.py

# Milestone 1+
/Users/j1k3r/miniforge3/bin/python3 -m pytest -q backend/tests/test_agent_engine_*.py

# Full backend suite
cd backend && /Users/j1k3r/miniforge3/bin/python3 -m pytest -q

# Release manifest/hygiene
/Users/j1k3r/miniforge3/bin/python3 scripts/package_release.py
/Users/j1k3r/miniforge3/bin/python3 scripts/check_release.py
```

Live provider tests and any networked benchmark remain opt-in and require an explicitly authorized target and allowlist. They are not part of default CI.
