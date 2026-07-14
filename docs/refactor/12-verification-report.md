# Agent Engine v3 Verification Report

Date: 2026-07-14

This report records the final local verification of the Agent Engine v3
refactor. Mock, offline-fixture, and live-model evidence are kept separate.

## Environment

- Branch: `codex/refactor-agent-engine-v3`
- Python: `/Users/j1k3r/miniforge3/bin/python3` (3.13.13)
- pytest: 9.0.3
- SQLAlchemy: 2.0.50
- FastAPI: 0.136.1
- Frontend: TypeScript and Vite 5.4.21

The macOS system `python3` is Python 3.9 with SQLAlchemy 1.x and does not meet
the project dependency floor. A first collection attempt with that interpreter
failed before tests ran because `sqlalchemy.orm.DeclarativeBase` was absent.
All results below use the configured Miniforge runtime shown above.

## Test Results

| Layer | Command | Result |
|---|---|---|
| API and CTF integration | `/Users/j1k3r/miniforge3/bin/python3 -m pytest -q backend/tests/test_ctf_api.py backend/tests/test_agent_engine_api.py` | 14 passed, 0 failed, 0 skipped, 30 warnings |
| Agent Engine | `/Users/j1k3r/miniforge3/bin/python3 -m pytest -q backend/tests/test_agent_engine_*.py` | 68 passed, 0 failed, 5 skipped, 8 warnings |
| Scenario and coordinator | `/Users/j1k3r/miniforge3/bin/python3 -m pytest -q backend/tests/test_agent_engine_scenarios.py backend/tests/test_agent_engine_v3_coordinator.py` | 4 passed, 0 failed, 0 skipped |
| Complete backend | `/Users/j1k3r/miniforge3/bin/python3 -m pytest -q` | 424 passed, 0 failed, 5 skipped, 471 warnings in 122.84s |
| Frontend production build | `cd frontend && npm run build` | passed; 1,802 modules transformed |
| Release hygiene | `/Users/j1k3r/miniforge3/bin/python3 scripts/check_release.py` | passed |

The five skips are container-sandbox integration tests. They report
`preloaded Docker/Podman sandbox image is unavailable`; the local environment
did not pull an image or enable network to hide that prerequisite. The 471
warnings are existing `datetime.utcnow()` deprecation warnings. The frontend
build reports one advisory warning for its 533.50 kB main chunk (162.75 kB
gzip); TypeScript compilation and bundling both pass.

## Acceptance Coverage

- Provider transcript replay, tool-call pairing, parallel calls, normalized
  errors, per-run model selection, and retry behavior are covered by the
  provider/protocol suites. Profile credentials are bound to configured base
  URLs, and missing live credentials fail visibly.
- Reducer replay, checkpoint restore, plan revisions, facts, hypotheses,
  evidence, compaction, and artifact ingestion are covered by the v3 contract,
  restore, projection, and event suites.
- DAG validation, bounded subagents, role limits, mailbox delivery, cancel,
  join, stuck detection, replanning, verifier/refuter conflict, and human
  resume are covered by the orchestration and coordinator suites.
- Default-deny policy, scope enforcement, high-risk approval, archive and path
  traversal defenses, symlink handling, and process-tree termination are
  covered by the engine and legacy compatibility suites.
- CTF, pentest, vulnerability analysis, incident response, and reverse/
  forensics have executable workflow fixtures and canonical projections.
- Formal API source checks reject imports of `ctf_agent_orchestrator`,
  `agent_runtime`, and `cc_bridge_runtime`; no runtime metadata still reports
  `engine: v2`.

## Benchmark Tiers

### Deterministic harness

The Agent Engine tests use scripted providers to verify protocol, state,
recovery, policy, and completion behavior. These are integration tests, not a
solve-rate claim.

### Offline fixture benchmark

Command:

```bash
/Users/j1k3r/miniforge3/bin/python3 benchmarks/runner.py \
  --sandbox local --repeat 3 \
  --output /tmp/zhulongx-agent-engine-v3-benchmark.json
```

The runner executed 25 hidden-evaluator cases across five scenarios, three
times each, through `AgentSession` and `BenchmarkMockProvider`:

- 75/75 validated;
- false-answer, human-intervention, invalid-tool-call, and timeout rates: 0%;
- reproducibility: 100%;
- median time: 0.0936s; p95 time: 0.1673s;
- scenario runs: CTF 30, pentest 12, vulnerability analysis 9,
  reverse/forensics 18, incident response 6.

The output was written outside the repository because it contains evaluator
results. `LocalTestSandbox` is a test-only runner; container behavior is a
separate release prerequisite.

### Live-model benchmark

No live-model benchmark was executed. No provider credentials or scoped live
target were supplied for this verification, so live solve rate, token cost,
latency, and intervention rate remain unmeasured.

## Frontend QA

The local CTF task view was checked in the in-app browser at 390x844 and
1280x720. Both viewports reported zero visible elements outside the main
viewport. Plan, Agent, and Evidence tabs switched correctly; the canonical v3
panel, human handoff, status pills, and audit controls rendered without text or
control overlap. The QA pass found and fixed two intrinsic-width issues in the
shared app flex item and timeline grid.

## Release Inspection

`scripts/package_release.py` excludes secrets, databases, upload/report data,
runtime state, vendor trees, dependency trees, hidden evaluators, raw benchmark
results, caches, generated CTF cases, and generated evidence. The final archive
contains 731 files. Its checksum passed, and direct ZIP inspection found zero
forbidden entries and zero missing required v3 files.

## Remaining Risks

1. The preloaded container image must be built or installed before the five
   container integration tests and container-mode benchmark can run.
2. A live-model benchmark is still required to claim competition solve rate,
   token/cost behavior, or provider-specific reliability.
3. Existing compatibility modules remain in the source tree for rollback and
   research, but formal APIs do not import them and bridge fallback is disabled.
4. The frontend main chunk should be split before substantial new UI modules
   are added.
