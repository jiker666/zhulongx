# Teammate 7e7dba Merge Report

Date: 2026-07-14

## Inputs and history

- Baseline: `b010bbcc8b8ff6f1f69b778cbbacced61cccb59e`
- Teammate source commit: `7e7dba344f247badab213bc721253b8357b0d8d3`
- ZIP SHA256: `41e2c6c3a1e9ea74fefde6dfcf0a73bcadd2f8b33c3b16ddf825e25ecf97f7b9`
- Actual merge base: `1abea88606ee8a61794dbebaba7f94a7232054ea`
- Merge commit: `e53fa476070161df352171a0a4ca5a456a1d74ab`
- Merge strategy: the real Git commit from `origin/main` was used. No synthetic
  snapshot commit was created.
- Safety branch: `backup/pre-teammate-merge-b010bbc`
- Result branch: `codex/merge-teammate-7e7dba-into-v3`
- Final validated implementation/test commit: `a1b9987`
- GitHub branch: <https://github.com/jiker666/zhulongx/tree/codex/merge-teammate-7e7dba-into-v3>

The merge commit has exactly the expected parents: v3 baseline `b010bbc` and
teammate commit `7e7dba`. The ZIP was used for checksum/content validation only.
It was not copied into the repository.

## Conflict resolution

### `backend/app/core/agent_runtime.py`

The v3-side compatibility implementation was retained. Archive extraction uses
`ExtractArchiveTool`; workspace path checks, abort/timeout behavior, and safe
archive handling remain intact. The teammate `AgentToolGateway` was removed
because it constructed another `TaskState` and `ToolBroker`.

### `backend/app/main.py`

The formal `agent_runs_router` registration was retained. The teammate
competition router was registered only after it had been rewritten as a facade
over `AgentRunService`, `RunManager`, `AgentSession`, the v3 tool registry, and
canonical projections. It does not import the teammate competition runtime.

## Disposition of teammate changes

### Retained

- `worker/Dockerfile`, Worker FastAPI service, requirements, Compose service,
  typed Worker client, PowerShell verification script, and Worker E2E coverage.
- Useful architecture, deployment, evidence, interaction, and testing docs,
  updated to describe the merged v3 implementation.
- The deletion of generated random CTF runs containing evaluator answers.

### Adapted into v3

- Worker command and PTY operations are v3 `ToolDefinition` objects registered
  by `build_builtin_registry`.
- Every call carries run/session/task/tool-call identity, authorization, and
  network scope. Policy and tool lifecycle events use the canonical event store.
- AgentSession abort invokes task cancellation; command and PTY process groups
  are terminated and reaped. PTY timeouts are reaped by the Worker.
- The Worker runs non-root with a read-only root filesystem, all capabilities
  dropped, `no-new-privileges`, a PID limit, no Docker socket, and an internal
  control network. The optional host port binds only to `127.0.0.1`.
- Linux Landlock confines child filesystem access to the owning run workspace.
  Parent traversal, symlink escape, and known absolute cross-run paths were
  verified as rejected.
- `/api/competition` maps create/list/start/pause/resume/cancel, hypotheses,
  human evidence, operator tools, and external validation to v3 sessions and
  events.

### Removed as duplicate authority

- `core/competition_runtime.py`, `core/agent_tool_gateway.py`
- `core/cancellation.py`, `core/competition_repository.py`
- `core/runtime_repository.py`, `core/replay_service.py`, `core/resource_service.py`
- `core/observation_authority.py`, `core/agent_patterns.py`
- `models/competition_runtime.py`, legacy `tools/worker.py`
- Tests that exercised those independent controllers/repositories instead of v3

Their useful behavior was either already present in AbortToken, EventStore,
StateReducer, ToolExecutionService, SubagentManager, checkpoints, and
projections, or was covered by the Worker integration above.

## Single-runtime invariant

`AgentRunService` is the only formal construction path. `AgentSession` owns
lifecycle and terminal state. `AppendOnlyEventStore` plus `StateReducer` owns
state and replay. Worker calls execute through `ToolExecutionService`; their
results enter the same reducer and audit stream. Static checks found no
`TaskState`, `ToolBroker`, `CompetitionController`, controller state dictionary,
or teammate runtime import in production code.

Legacy research/compatibility source elsewhere in `core/` remains outside the
formal APIs as established by the v3 baseline. No formal API imports
`agent_runtime`, `ctf_agent_orchestrator`, or `cc_bridge_runtime`.

## Generated paths

The teammate commit removed 246 tracked files under generated random cases,
including raw `expected_answer.txt` data. They are runtime products and are
already covered by `.gitignore`. The single tracked
`ctf_cases/generated/latest` fixture was restored after tests and has no
worktree change. No ZIP, merge input, environment file, database, dependency
tree, frontend build output, or benchmark answer output is included.

## Verification results

| Layer | Command | Result |
|---|---|---|
| Complete backend | `/Users/j1k3r/miniforge3/bin/python3 -m pytest -q` in `backend` | 443 passed, 0 failed, 0 skipped; 470 deprecation warnings |
| Agent Engine | `python -m pytest -q tests/test_agent_engine_*.py` | 73 passed, 0 failed, 0 skipped; 8 warnings |
| Worker E2E | `python -m pytest -q tests/test_worker_e2e.py` with Worker running | 5 passed, 0 failed, 0 skipped |
| Competition/convergence focus | competition, session, tools, and convergence suites | 28 passed, 0 failed |
| Frontend | clean `npm ci`, then `npm run build` | passed; 1,802 modules transformed |
| Compose config | `docker-compose config` | passed |
| Images | `docker-compose build worker-base backend` | passed |
| Runtime health | backend `/api/health`, Worker `/health` | both `status=ok`; database/storage checks passed |
| Worker security | container inspect plus E2E | non-root, read-only root, cap-drop, no-new-privileges, PID limit, loopback port, internal network, Landlock |
| Release | `python scripts/check_release.py` | passed |
| Conflict/whitespace | conflict-marker scan and `git diff --check` | passed |

The frontend build retains the existing advisory for a 533.50 kB main chunk.
Release check warns about local runtime/dependency directories that its package
rules exclude; it reports no tracked release failure and no secret finding.

These are deterministic/offline and local-container results. No live-model
benchmark was run and no live solve-rate claim is made.

## Remaining risks

1. Worker process creation intentionally supports only `network_mode=deny`.
   An allowlisted Worker network mode needs a per-run network namespace and is
   currently a visible failed tool call, never a host fallback.
2. The Worker control endpoint trusts requests arriving on the internal Docker
   network or loopback host binding. Mutual service authentication should be
   added before exposing that control plane beyond one trusted host.
3. The existing frontend chunk-size advisory remains.
4. A live provider benchmark is still needed for model quality, cost, latency,
   and solve-rate evidence.

The exact pushed branch tip and PR are recorded by GitHub after the report and
commit sequence is finalized; the branch URL above resolves to that tip.
