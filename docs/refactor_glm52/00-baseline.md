# GLM-5.2 Orchestration Baseline

Captured on 2026-07-15 before the refactor.

## Source and runtime

- Branch: `codex/merge-teammate-7e7dba-into-v3`
- HEAD: `76a43b4a7278400793933a81276a89694ab2411e`
- Working tree before capture: clean
- Test host: macOS, arm64
- Test Python: 3.13.13 (Miniforge)
- System Python: 3.9.6 (not suitable for this codebase)
- Node.js: 26.3.0
- npm: 11.16.0
- Docker CLI: 29.4.3; the selected server is Podman 5.8.2, Linux/arm64
- Podman: 5.8.2, Linux/arm64 VM
- Default sandbox image: `python:3.11-slim`

No environment values or credentials were copied into this report.

## Formal API call paths

The audit confirms the primary architecture issue described in the refactor request.

```text
POST /api/agent/runs
  -> AgentRunService.create_session
  -> AgentSession
  -> AgentLoop

POST /api/competition/challenges
  -> AgentRunService.create_session
  -> AgentSession

POST /api/ctf/tasks/{id}/solve
  -> CTFSessionService._session_for
  -> AgentRunService.create_session
  -> AgentSession
```

`RunManager` stores `dict[str, AgentSession]`. `AgentRunService.create_session()` constructs or resumes only `AgentSession`. The formal API type annotations and several response strings also name `AgentSession` directly.

The production search below returned no matches:

```bash
rg -n "CoordinatorSession\(|SubagentManager\(|ModelRoutePolicy\(" backend/app --glob '!**/tests/**'
```

`CoordinatorSession`, `SubagentManager`, and `ModelRoutePolicy` exist, but their construction is limited to tests. The `/workflow` route only returns a static scenario plan and workflow for display. It does not drive the run created by the formal API.

## Existing orchestration capabilities

The following modules are retained and extended:

- `AppendOnlyEventStore`, `StateReducer`, `CheckpointStore`, and projections
- `AgentSession` and `AgentLoop` as the leaf/single-agent lifecycle
- `PolicyEngine`, `ToolRegistry`, `ToolExecutionService`, and `ContainerSandbox`
- `TaskGraph` DAG validation and workflow primitives
- `SubagentManager` bounded thread pool, role limits, mailbox, cancellation, isolated directories, and checkpoints
- five scenario manifests, validators, plans, and workflows
- canonical event lineage fields (`run_id`, `agent_id`, `task_id`, `parent_event_id`)

Current limitations:

- `CoordinatorSession` takes a prebuilt static plan/workflow and performs no task intake or model planning.
- `SubagentTaskDispatcher` spawns one child and immediately joins it. Parallel workflow branches can overlap, but dispatch itself has no persistent graph queue, resource locks, or graph revision.
- no production `LLMSubagentWorker` exists; coordinator tests use callable fake workers.
- `Replanner.revise()` changes plan metadata rather than applying a validated graph patch.
- coordinator success is `workflow success + any evidence`; it does not invoke the scenario validator/completion contract.
- verifier/refuter are workflow roles, not independently enforced clean-context reproduction sessions.

## Initial planning and context

`AgentSession._ensure_initial_plan()` creates one executor node and gives it the registered tool set. Scenario plans are larger but static, and the formal API does not execute them.

`ContextBuilder(max_events=40)` selects recent events by count. `AgentLoop` compacts after approximately twice that count. There is no model-aware token budget, stable-prefix contract, artifact retrieval budget, or role-scoped context pack.

## GLM-5.2 provider matrix

| Capability | Baseline |
| --- | --- |
| Dedicated provider | Missing; `glm` selects `OpenAICompatibleProvider` |
| Non-streaming chat completion | Present |
| Streaming SSE | Missing |
| `thinking.type` | Missing |
| `reasoning_effort` | Missing |
| `clear_thinking` | Missing |
| `tool_stream` | Missing |
| `reasoning_content` parsing | Missing in Agent Engine v3 |
| Interleaved thinking preservation | Missing |
| Split/multiple tool-call assembly | Missing for streams |
| Model capability negotiation | Missing |
| Structured output validation | Not provider-native |
| Tool count/output token limits | Generic values only |
| Public/private reasoning separation | Missing |

The legacy `backend/app/core/llm_adapter.py` parses `reasoning_content`, but formal Agent Engine APIs do not use it and it is not a fallback target for this migration.

## Baseline verification

Commands used:

```bash
/Users/j1k3r/miniforge3/bin/python3.13 -m compileall -q backend/app worker/app
/Users/j1k3r/miniforge3/bin/python3.13 -m pytest -q --maxfail=20
cd frontend && rm -rf node_modules dist && npm ci && npm run build
```

Results:

- compileall: passed
- backend: 443 passed, 0 failed, 0 skipped, 473 warnings in 154.13 seconds
- container contract/e2e tests included in the full run: passed locally with Podman
- Ubuntu release job with real Docker/Podman: NOT RUN at baseline
- frontend clean install: passed, 0 known npm vulnerabilities
- frontend build: passed
- frontend lint/test: NOT RUN because `package.json` defines no lint or test scripts
- frontend bundle warning: main JS 533.50 kB (162.75 kB gzip), above Vite's 500 kB warning threshold
- responsive Playwright matrix: NOT RUN at baseline

The warnings are primarily unregistered pytest marks and existing UTC datetime deprecations.

## Benchmark classification

- `benchmarks/results/latest.json`: deterministic mock AgentSession protocol/offline fixture report, 75 runs; its own claim states it is not a live-model solve rate.
- `benchmark_results.json`: historical baseline containing expected answers in the report. It is not accepted as a hidden-answer or live GLM-5.2 result.
- live GLM-5.2 benchmark: NOT RUN at baseline.

The release process must exclude evaluator answers, historical result artifacts that contain answers, raw reasoning, runtime workspaces, databases, caches, and credentials.

## Keep, replace, deprecate

Keep and enhance:

- all Agent Engine v3 event/state/checkpoint/policy/tool/sandbox primitives
- `AgentSession` as leaf worker and explicit `single` mode
- scenario manifests, macro workflows, and validators as planner constraints
- `SubagentManager`, mailbox, task graph validation, and UI projections

Replace or materially revise:

- hard-coded `AgentSession` construction with `RunSessionFactory`
- static coordinator execution with a dynamic task graph scheduler
- fake-only worker protocol with `LLMSubagentWorker`
- generic GLM routing with `GLM52Provider`
- event-count context slicing with token-aware context packs
- metadata-only replanning with validated plan patches

Deprecate from formal paths:

- direct imports of legacy `backend/app/core` orchestrators/runtimes
- automatic WQ lane rewriting as a source of role identity
- any host execution fallback in release mode

