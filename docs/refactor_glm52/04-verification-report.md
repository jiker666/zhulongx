# Agent Engine v3 GLM-5.2 Verification Report

Verification date: 2026-07-16

## Implementation status

Agent Engine v3 is the only formal lifecycle authority. Formal `auto` and `coordinator` runs construct a root `CoordinatorSession`; explicit `single` runs construct a leaf `AgentSession`. No formal API imports or falls back to the legacy orchestrator, old runtime, or bridge.

Phase commits:

1. `7f12ba1 chore: capture glm52 orchestration baseline`
2. `d402e5a refactor: make coordinator the canonical autonomous run`
3. `820eb53 feat: add native glm52 streaming and thinking protocol`
4. `b56d0a4 feat: run llm subagents through the canonical harness`
5. `9ea0abc feat: execute dynamic plan dag with evidence driven replanning`
6. `90b57ea feat: add token aware context and capability scoped tools`
7. `5fc0beb feat: expose live multi agent operations across security workflows`
8. `efbc647 chore: harden glm52 agent harness for release`
9. `fix: make file analysis portable across release hosts` (the commit containing this update)

## Formal runtime

```text
POST /api/agent/runs, competition API, or scenario API
  -> AgentRunService.create_session
  -> RunSessionFactory.create
     -> CoordinatorSession (auto/coordinator)
        -> DynamicPlanner
        -> TaskGraphStore + DynamicTaskScheduler
        -> SubagentManager
        -> LLMSubagentWorker
        -> AgentSession / AgentLoop leaves
        -> EvidenceDrivenGraphReplanner
        -> CoordinatorCompletionPolicy + scenario Validator
     -> AgentSession (explicit single)
```

Key implementation locations:

- `backend/app/agent_engine/service.py`: canonical construction service
- `backend/app/agent_engine/run_session_factory.py`: mode selection, production coordinator and leaf worker construction
- `backend/app/agent_engine/orchestration/coordinator.py`: root lifecycle, control propagation, plan patches and completion
- `backend/app/agent_engine/orchestration/llm_subagent_worker.py`: production role-scoped child sessions
- `backend/app/agent_engine/orchestration/dynamic_scheduler.py`: dependency scheduling and cancellation
- `backend/app/agent_engine/orchestration/graph_replanner.py`: evidence-driven structural replanning
- `backend/app/agent_engine/orchestration/completion_policy.py`: verifier/evidence/validator completion gate
- `backend/app/agent_engine/providers/glm52.py`: native GLM-5.2 protocol
- `backend/app/agent_engine/context.py`: token-aware context packs and stable prefix
- `backend/app/agent_engine/tools/selector.py`: bounded capability selection
- `backend/app/scenarios/workflow_factory.py`: five scenario macros and completion contracts
- `backend/app/api/agent_runs.py`: effective configuration and run/branch controls
- `frontend/src/components/ctf/AgentRunOverview.tsx`: DAG, agent lanes, knowledge and controls

Static formal-runtime import scan returned no old orchestrator, old runtime, or bridge imports.

## Verification results

### Backend and lifecycle

| Check | Result |
| --- | --- |
| macOS `python -m compileall -q backend/app worker/app` | passed |
| first full backend run after Phase 6 | 484 passed, 1 failed; abort terminal ordering race reproduced |
| focused event/abort/deadline regression | 6 passed |
| repeated abort/deadline race regression | 10 passed across five repetitions |
| final macOS full backend suite | 486 passed, 0 failed, 0 skipped, 474 warnings in 154.75s |
| Ubuntu 24.04 compileall | passed on Python 3.12.3 |
| Ubuntu 24.04 full backend suite | 481 passed, 0 failed, 5 skipped, 475 warnings in 138.69s |
| Ubuntu 24.04 Agent Engine suite | 115 passed, 0 failed, 0 skipped in 18.33s |
| Ubuntu 24.04 release container group | 5 passed, 0 failed, 0 skipped in 4.76s; JUnit totals asserted |

The initial failure was not suppressed. `tool.failed` could arrive after `run.cancelled` from a terminating tool thread. `AppendOnlyEventStore` now treats the first terminal event as the append boundary for that run; late events return the existing terminal event and are not persisted. Process-tree cleanup already passed in the failing run and continues to pass after the ordering fix.

The final portability regression adds a bounded Python byte/string scanner to `CtfFileAnalyzer`. It merges and de-duplicates external and Python results, and scans the fallback text directly when a minimal release host has no `strings` binary. The focused analyzer suite is 6/6, including the explicit missing-`strings` binary fixture.

Warnings are Pydantic protected-namespace notices and existing SQLAlchemy/application uses of deprecated naive UTC helpers. They do not change pass/fail counts but remain migration work.

### Container and Linux

The cross-platform run used a clean Ubuntu 24.04.4 environment with managed Python 3.12.3. Pytest capture retained container-native `/tmp`; `--basetemp` used a host-shared absolute path so sibling sandbox containers could mount their workspaces. The Ubuntu environment connected to the external Linux Podman 5.8.2 Docker-compatible server with `python:3.11-slim` preloaded.

The full Ubuntu suite completed with five documented skips, all from `tests/test_worker_e2e.py`: the separately deployed `worker-base` HTTP service was not reachable on `localhost:8090` inside the validation container. No Agent Engine or container sandbox test skipped. The explicit release container group ran as real sibling containers:

```text
backend/tests/test_agent_engine_container_sandbox.py
5 passed, 0 failed, 0 skipped in 4.76s
```

Coverage includes workspace/secret isolation, read-only inputs, network denial, timeout cleanup and abort cleanup. `scripts/release_agent_engine.sh` is the Ubuntu release job: it preloads the image, runs compileall/full backend/Agent Engine/container tests, parses JUnit, asserts exactly five container tests with zero skips, performs the clean frontend sequence, scans the repository, packages the release and scans the ZIP. The Linux commands and JUnit assertion were executed in the Ubuntu environment. A hosted Ubuntu CI runner was not used.

### Frontend

Clean Linux sequence used Node 20.20.2 and npm 10.8.2:

```text
rm -rf frontend/node_modules frontend/dist
npm ci
npm run lint
npm run test --if-present
npm run build
```

Results:

- clean install: 242 packages
- lint: passed (`tsc --noEmit`)
- test: command passed; no frontend test script is defined
- production build: passed, 1,803 modules transformed
- largest shared chunk: 195.83 kB (63.30 kB gzip)
- CTF detail route chunk: 51.65 kB (14.05 kB gzip)
- dependency audit: patched `react-router-dom`, `react-router`, `form-data` and transitive dependencies; 2 development-tool findings remain in Vite 5/esbuild and require a Vite 8 major upgrade

Responsive Playwright/Chrome QA used the populated canonical run fixture at 390x844, 768x1024, 1280x720 and 1440x900. For all three tabs at every viewport: page overflow was 0 px, interactive text overflow was 0, interactive overlap findings were 0, console errors were 0 and failed requests were 0. The large DAG scrolls only inside its dedicated container. Public DOM text contained no raw reasoning field. Screenshots are under `docs/refactor_glm52/qa/responsive/`.

## Benchmarks

The three tiers remain separate.

### Protocol mock

`test_formal_auto_run_emits_dynamic_parallel_replan_and_completion_sequence` ran the formal factory/Coordinator/production child-session harness with a deterministic provider. This proves orchestration behavior, not live-model quality.

Observed trace:

- status and final event: `succeeded` / `run.succeeded`
- 280 canonical events
- 12 spawned and completed child Agents
- 24 tool starts
- one structural plan revision; plan v1 to v2
- roles: scout, analyst, planner, executor, verifier and synthesizer
- injected scout failure, alternate branch execution, independent verifier acceptance and completion decision all occurred

### Offline hidden fixture

Command:

```bash
AGENT_SANDBOX_RUNTIME=docker AGENT_SANDBOX_IMAGE=python:3.11-slim \
python benchmarks/runner.py --sandbox container --repeat 3
```

This tier uses `BenchmarkMockProvider`, one `AgentSession`, real ContainerSandbox execution, 25 public fixtures across five scenarios and a hidden evaluator manifest visible only to the runner/Validator.

- 75/75 validated; pass@1 1.0; pass@3 1.0
- reproducibility 1.0; false-answer, intervention, timeout and duplicate-tool rates 0
- useful evidence/tool call 0.5; median 0.2706s; p95 0.6352s
- mean Agents 1; mean peak tool concurrency 1; mean plan revisions 0
- independent verifier rejection: not applicable to this single-session tier
- timeout/cancel cleanup: not exercised by this fixture set; release lifecycle tests cover it

The 100% result is not a GLM-5.2 solve rate.

### Live GLM-5.2

Status: `NOT RUN`. No GLM, generic LLM, or gateway key was configured in the verification environment. `benchmarks/live_runner.py` passed syntax/help validation and fails closed with exit code 2 when prerequisites are absent. See `05-live-model-eval.md` for the exact command and metric schema.

## Release

- pre-package repository scan: passed (`check_release.py` and `safety_audit.py`; 0 failures)
- archive: `dist/cyberpilot-finalops-v4-submission.zip`
- checksum file: `dist/SHA256SUMS`
- archive scan: passed (`scripts/check_release_archive.py`, 752 packaged files)
- local archive SHA256: `0d454d2f5fb26df8ea8562087d4e7939adf4796345e7d0b9b38db51d4378bf42`

The packager excludes credentials, `.env`, databases, uploads, reports, workspaces, checkpoints, private provider transcripts, node modules, caches, hidden evaluators, benchmark results, evaluator source and every `expected_flag`/`expected_answer` file. `scripts/check_release_archive.py` independently checks ZIP integrity, paths, required documents, secret patterns and `SHA256SUMS`.

The finalized ZIP embeds the pre-hash revision of this report. The repository copy and external `dist/SHA256SUMS` record the post-package checksum because an archive cannot embed its own checksum without changing that checksum.

## Competition dimensions

| Dimension | Evidence |
| --- | --- |
| autonomous decision | model/deterministic intake, dynamic DAG, structural replanning and bounded stuck escalation |
| general security coverage | executable CTF, pentest, vulnerability analysis, incident response and reverse/forensics macros/contracts |
| tool collaboration | capability-scoped tools, policy/hooks, Worker/ContainerSandbox, evidence and artifact lineage |
| multi-agent orchestration | production child AgentSession workers, parallel scheduler, mailbox/handoffs, verifier/refuter roles |
| engineering and auditability | append-only events, reducer projections, checkpoints, controls, responsive UI, release/secret scans |

## Remaining risks

1. Live GLM-5.2 quality, latency, token usage, cost and real gateway capability downgrade behavior remain unmeasured without a model key.
2. The clean Ubuntu 24.04 container run passed, but no hosted CI or dedicated bare-metal Ubuntu runner executed the release job.
3. Five optional worker HTTP E2E tests skip when the separately deployed `worker-base` service is absent; Agent Engine and release container tests have zero skips.
4. Frontend has deterministic type lint/build and responsive browser QA but no component or end-to-end test suite in `package.json`.
5. The frontend lockfile retains two Vite 5/esbuild development-server audit findings; removing them requires a tested Vite 8 major upgrade.
6. The backend passes with 474 macOS and 475 Ubuntu warnings, mainly UTC deprecations that should be migrated before Python removes the affected APIs.
7. The offline 25-case set is deterministic and intentionally bounded; it does not measure difficult open-ended model generalization.
