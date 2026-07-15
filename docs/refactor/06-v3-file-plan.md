# Agent Engine v3 File-Level Migration Plan

## Phase 1: protocol and lifecycle

- Extend `state.py` model configuration and completion states.
- Extend `events.py` with schema version and canonical plan/task/agent/fact/hypothesis/evidence,
  validation, budget, human, and completion events.
- Add `reducer.py`; session mutation flows through appended events and reducer application.
- Rebuild native messages in `context.py`; add transcript golden tests.
- Update provider factory/routing so each `RunRequest` controls provider/model/profile/timeouts.
- Extend tool definitions and add bounded batch execution.

## Phase 2: decision state and artifacts

- Add typed contracts under `contracts/` for plans, tasks, knowledge, evidence, and completion.
- Add `artifacts/model.py` and `artifacts/ingest.py` with safe inventory/extractor dispatch.
- Add `compaction.py` for structured long-term summaries and evidence indices.
- Add reducer replay, checkpoint, compaction, and artifact tests.

## Phase 3: orchestration

- Add `orchestration/task_graph.py`, `workflow.py`, and `primitives.py`.
- Add `subagent_manager.py`, `mailbox.py`, `scheduler.py`, and `coordinator.py`.
- Add `stuck_detector.py`, `replanner.py`, `verifier.py`, and `synthesizer.py`.
- Add role permissions and structured agent summaries under `agents/`.
- Test DAG validation, fan-out/fan-in, retry/idempotency, cancel, resume, timeout, budget, and
  executor/verifier conflicts.

## Phase 4: scenarios

- Give every scenario a manifest, workflow, roles, policy, completion policy, and validator.
- CTF includes candidate pending/accepted/rejected external transitions.
- Add one offline end-to-end fixture per scenario through the canonical coordinator path.

## Phase 5: control plane and UI

- Move run construction to one `AgentRunService` used by both generic and CTF routes.
- Add plan/projection, human answer/resume, and audit export endpoints.
- Extend frontend API types and the CTF detail timeline with canonical plan, agent, evidence,
  verifier, budget, and handoff projections.

## Phase 6: legacy isolation

- Remove formal API imports/instantiation of `CTFAgentOrchestrator`, `AgentRuntime`, and bridge.
- Move bridge selection to explicit experimental configuration with no fallback.
- Update README, AGENTS, architecture, deployment, protocol, workflow, threat-model, migration,
  and operator documentation.

## Phase 7: gates

- Focused engine tests, full backend suite, frontend type/build test, deterministic mock tier,
  offline fixture tier, release packaging, and release inspection.
- Live-model benchmark remains opt-in and its absence is reported explicitly.

## Module disposition

| Module | Disposition |
| --- | --- |
| `agent_engine/session.py`, events, policy, sandbox, skills | Preserve and evolve |
| `agent_engine/loop.py`, context, providers, tools | Refactor behind v3 contracts |
| `scenarios/ctf/service.py` | Preserve API compatibility, delegate to shared run service |
| Other scenario packages | Replace skeletons with executable specifications |
| `core/ctf_agent_orchestrator.py`, `core/agent_runtime.py` | Retire from formal API path |
| `core/cc_bridge_runtime.py` | Experimental only; no fallback |
| Legacy UI projection | Keep as compatibility projection; add canonical v3 projection |

