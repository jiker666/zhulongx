# Refactor Milestone Status

Date: 2026-07-13

This report distinguishes implemented behavior from release claims.

## Milestone 0: containment

Status: implemented and tested.

Delivered:

- Removed root `.env` and `backend/.env`; rotation remains an operator action documented in `03-secret-rotation.md`.
- Root `pytest.ini` limits collection to `backend/tests` and supplies the backend import path.
- Default CTF run storage moved outside the source tree.
- Legacy runtime and filesystem tools now resolve paths and reject host and symlink escapes.
- ZIP and TAR member extraction rejects traversal and links.
- Legacy sandbox processes use owned process groups; timeout and abort terminate descendants.
- API stop reaches the active compatibility runtime before thread bookkeeping is cleared.
- Legacy bridge is disabled by default and silent fallback is disabled.
- Release packaging excludes secrets, VCS data, dependency trees, databases, runs, recovered vendor code, and vendored skills.

Focused result:

```text
50 passed, 0 failed
```

Root discovery result:

```text
395 tests collected from backend/tests only
generated backend/data/ctf_runs scripts were not collected
```

## Milestone 1: walking skeleton

Status: implemented and tested.

Delivered under `backend/app/agent_engine/`:

- one `AgentSession` lifecycle owner and a bounded tool-use loop;
- append-only redacted events with unique per-run sequence and reconnect cursor;
- serializable generic `RunRequest` and `SessionState` without evaluator answers;
- provider-neutral `AssistantTurn` and scripted mock provider;
- registry definitions binding schema, permissions, timeout, risk, and real executor;
- argument validation, policy decisions, bounded tool results, and artifacts;
- seven base tools for list/read/write/grep/shell/Python/candidate submission;
- evidence-bound validator completion and compatibility event projection.

The deterministic end-to-end test executes read -> Python -> candidate -> validator and reaches `succeeded` only after acceptance. Denied and failed tool paths are fed back to later model turns.

## Milestone 2: usable kernel

Status: partially implemented; not release-complete.

Implemented:

- OpenAI-compatible native-tool provider with classified retries, timeout, abort, usage, strict malformed-call errors, and hashed raw references;
- session deadline watchdog and process-tree abort under three seconds;
- atomic checkpoint/resume with tool-call ID idempotency;
- progressive SkillIndex/SkillLoader and `skill.loaded` events;
- staged CTF format/evidence/reproduction/authoritative validation;
- all 11 first-phase tools when progressive skills are enabled;
- default-deny HTTP scope with host/port allowlists and DNS/private/metadata checks;
- incremental legacy UI projection and `/api/agent/runs` control-plane endpoints;
- Stage A legacy CTF task-to-RunRequest adapter that drops `expected_flag`;
- five scenario contracts;
- 10 public blind harness cases, repeated three times through AgentSession;
- Podman/Docker `ContainerSandbox` with disabled image pulls and network, read-only root, dropped capabilities, resource limits, one writable workspace, read-only input overlays, minimal environment, and bounded abort/timeout cleanup.

Engine-focused result:

```text
44 passed, 0 failed
```

Full backend result:

```text
395 passed, 0 failed, 488 warnings
warnings are existing datetime.utcnow() deprecations
```

Harness result:

```text
mode: agent_session_mock
runs: 30
validated rate: 100%
false answer / human intervention / invalid call / timeout: 0%
reproducibility: 100%
```

This harness result is not a live-model solve rate.

## Modified areas

- New: `backend/app/agent_engine/`, `backend/app/scenarios/`, `backend/app/api/agent_runs.py`
- New: `benchmarks/`, `docs/refactor/`, `pytest.ini`, focused v2 tests
- Security compatibility fixes: legacy runtime, sandbox, archive/filesystem tools, cancellation API
- Configuration and release fixes: `.env.example`, `config.py`, README, package/release checkers
- No task-related frontend files were edited; pre-existing frontend changes were preserved.

## Unmet release gates

- `/api/ctf` still uses the legacy orchestrator; v2 is exposed separately and has not become the default task path.
- The legacy bridge, legacy phase loop, observer/blackboard/router path, and recovered vendor tree still exist locally.
- API-created CTF runs do not have an authoritative evaluator by default and therefore cannot succeed.
- No authorized live-model 10-case benchmark has been run after secret rotation.
- The 20+ hidden, five-category, three-repeat benchmark required for final acceptance is not present.
- HTTP DNS validation still depends on the HTTP client's second resolution; production needs container/network enforcement or IP-pinned connection handling to eliminate DNS TOCTOU.
- Service-restart reconstruction of RunManager records from persisted run metadata is not implemented, although core checkpoint restore is tested.
- Existing UI pages have not yet been switched from legacy task polling to the v2 event endpoint.

The large refactor must not be declared complete until these gates are closed.
