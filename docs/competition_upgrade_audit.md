# Competition Upgrade Audit

Audit date: 2026-07-11. Scope: repository source, tests, configuration, Docker definition, backend and frontend entry points. The Writeup path (`writeup_generator.py`, `get_writeup*`, `/writeup`, and UI modal) is frozen and is not an upgrade target.

## 1. Current execution path

`POST /api/ctf/tasks` in `backend/app/api/ctf.py` creates an in-memory `CtfTask` and persists a projection through `ctf_persistence.py`. Attachments are copied to the task upload directory. `POST /solve` starts a background thread, which calls `CtfOrchestrator.run` in `core/ctf_agent_orchestrator.py`.

The current orchestrator moves through `INIT -> CLASSIFY -> PLAN -> ANALYZE_FILES -> AGENT_THINK/(RUN_SHELL|GENERATE_SCRIPT|RUN_SCRIPT) -> VERIFY_FLAG -> GENERATE_WRITEUP -> DONE|FAILED|HUMAN_REQUIRED`. It combines `CtfFileAnalyzer`, `CodeExecutionSandbox`, `AgentRuntime`, LLM adapters/router, Blackboard, Observer, CostAccounting, `FlagVerifier`, evidence persistence, and WebSocket events. Static solvers cover selected misc/crypto/reverse/web cases. `AgentRuntime` is a conversation/ReAct loop: it parses model tool calls, directly executes registered tool implementations or sandbox commands, appends observations to the conversation, and repeats.

The legacy challenge/task APIs are separate: `api/challenges.py` uses `Planner`, `Executor`, `ToolRegistry`, evidence rows, and SQL task/challenge models. The React CTF hub and task detail pages poll CTF APIs and show task state, events, candidates, shell history, Blackboard, cost, and generated writeup.

## 2. Existing modules

| Concern | Existing implementation |
|---|---|
| Agent/manager | `CtfOrchestrator`, `AgentRuntime`, `Planner`, `Executor`, `CcBridgeRuntime` |
| State/blackboard/memory | `CtfTask`, `CtfState`, `Blackboard` with facts/intents/hints, `memory.py` |
| Evidence/artifacts | `EvidenceVault`, SQL `Evidence`, `CtfEvent`, `CtfArtifact`, `CtfFlag`, `ctf_persistence.py` |
| Tooling | `ToolRegistry`, `ToolSpec`/protocol, filesystem/archive/file/log/web/shell/python/submit tools |
| Security/isolation | `ScopeGuard`, `SolveAccessGuard`, `PolicyEngine`, `CodeExecutionSandbox`, HTTP safety helpers |
| Model/cost | `LLMAdapter`, `ModelRouter`, `CostAccounting`, OpenAI-compatible configuration |
| Observability | `Observer`, `decision_trace.py`, `ws_manager.py`, `/ws/ctf/{task_id}`, task event API |
| APIs | CTF, challenges, tasks, tools, upload, reports, LLM, settings and WebSocket routers |
| UI | `CtfHub`, `CtfTaskDetail`, `FinalOps`, `ToolCenter`, dashboard and benchmark pages |

## 3. Actual category capability baseline

| Category | Available today | Gap |
|---|---|---|
| Web | Scoped HTTP fingerprint/replay, directory probe, JS extraction, static web solver | no persistent HTTP session or competition scheduler |
| Pwn | Shell/script sandbox and optional binary tools discovered ad hoc | no PTY/TCP/GDB session or concrete specialist |
| Reverse | file analysis, strings and static solver | tooling is host-dependent; no worker capability contract |
| Crypto | misc decoder/static solver and Python sandbox | no specialist ledger/action model |
| Misc | archive, file parsing, triage and decode solver | no structured broker result/evidence graph |
| Forensics | log analysis, artifact triage, optional external tools | no dedicated worker/session/tool health API |

## 4. Findings with concrete code locations

1. **Concentrated responsibility and prompt-driven loop:** `core/ctf_agent_orchestrator.py` owns intake, classification, planning, artifact analysis, execution, candidate selection, verification, persistence and Writeup hand-off. `core/agent_runtime.py` retains a non-resumable conversation ReAct loop and embeds strategy instructions in `_build_system_prompt`/loop-recovery text.
2. **Permissions are descriptive, not a universal enforcement point:** `core/tool_registry.py` exposes `permissions`, risk and schemas, but its `get()` only checks enabled state. `AgentRuntime` can execute through its tool executor/sandbox without a broker that consistently validates schema, specialist permission, profile, scope, budget and concurrency.
3. **Interactive execution is one-shot:** `core/code_execution_sandbox.py` uses subprocess execution. There is no persistent PTY, TCP, HTTP-cookie, or debugger session manager.
4. **Evidence is split and weakly linked:** `models/evidence.py`, `models/ctf.py`, `core/evidence_vault.py`, and `ctf_persistence.py` store separate records. There is no artifact derivation graph or immutable evidence IDs connecting every candidate to exact tool calls.
5. **Candidate verification is incomplete:** `core/flag_verifier.py` performs format/source-oriented validation, while `CtfFlag` keeps confidence and source. There is no independent verifier pipeline requiring reproducibility and platform/manual submission status.
6. **Hypotheses are not durable typed records:** `CtfOrchestrator._hypotheses` is an in-process dictionary and mirrors text into Blackboard facts. It does not retain support/contradiction links, status transitions, confidence rationale, or budget competition.
7. **Scheduling/recovery are limited:** `api/ctf.py` uses a process-local background thread map. It has stop flags and startup ghost cleanup but no persisted checkpoints/resume node, multi-challenge priority scheduler, worker recovery, or replay-grade trace events.
8. **Tool capability discovery is ad hoc:** `_check_tool_capabilities` in `ctf_agent_orchestrator.py` probes host executables once and returns lists. It is not persisted, versioned, health-checked, exposed as a standard capability registry, or used by planning.
9. **Docker isolation is incomplete for untrusted challenge code:** `docker-compose.yml` runs a single backend container and bind-mounts data/storage. It has no separate non-root task worker or per-task containerized workspace. The sandbox documentation explicitly notes process-level rather than container-level isolation.
10. **Frontend observability is valuable but not competition-oriented yet:** `CtfTaskDetail.tsx` presents events/blackboard/cost/candidates but has no competition overview, hypothesis/action scoring view, session console, evidence/artifact graph, or replay timeline.
11. **Stability concerns:** `main.py::_cleanup_ghost_tasks` suppresses all exceptions; the long synchronous test command exceeded 60 seconds during this audit; current runtime uses blocking sleeps/subprocesses inside a loop.

## 5. Baseline verification

- Repository test command attempted: `cd backend && python -m pytest -q`.
- Result: command exceeded the audit execution window (64.8 seconds) before completion; no passing count is claimed. Targeted and new tests must be run after the upgrade, with the full suite run using an appropriately longer CI timeout.
- `docker-compose.yml` and package manifests were inspected. Frontend build has not yet been run in this baseline phase.

## 6. Upgrade disposition

| Keep and integrate | Refactor behind compatibility layer | Add now | Defer |
|---|---|---|---|
| CTF APIs, Blackboard, ScopeGuard, sandbox, current tools, model router/cost, CTF persistence, existing CTF UI, all Writeup functionality | `CtfOrchestrator` execution path, tool dispatch, evidence/candidate persistence, events and task control | competition profile, typed decision state, hypothesis ledger, action scorer, tool broker, capability registry, sessions, specialists, verifier, trace/replay, controller APIs/tests/docs | full Docker worker images, real CTFd adapter credentials, GDB structured adapter, production queue/DB migrations beyond SQLite compatibility |

## 7. Migration rules

The new competition workflow will be opt-in through a profile/configuration switch. Existing `/api/ctf/*` behavior remains available. New tables are additive and created through the current SQLite-compatible migration mechanism. The existing Writeup code and related UI/configuration are excluded from edits. All new executions must use a task-scoped workspace and route tool calls through the broker.
