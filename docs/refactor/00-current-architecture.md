# Current Architecture Audit

Date: 2026-07-13

## Scope

This document describes the implementation currently present in the repository. It is not a description of the intended v2 design.

## Runtime ownership

```text
FastAPI ctf API
  -> one daemon thread per task
  -> CtfOrchestrator.run phase state machine
       INIT -> CLASSIFY -> PLAN -> ANALYZE_FILES -> AGENT_THINK
       -> RUN_SHELL / RUN_SCRIPT / VERIFY_FLAG / WRITEUP
       |
       +-> AgentRuntime.run conversation and tool loop
       |    -> model router chooses another adapter
       |    -> native tool calls and text parsing are both accepted
       |    -> ToolSpec metadata is separate from private executors
       |    -> regex-valid output can end the loop
       |
       +-> CcBridgeRuntime when the external CLI is detected
       |    -> writes one prompt file
       |    -> runs one external process
       |    -> represents all work as one claude_code_cli observation
       |    -> extracts candidates from final stdout/stderr
       |    -> can silently run AgentRuntime instead
       |
       +-> _agent_think_legacy text-action loop
  -> periodically projects runtime turns and ledger into legacy task fields
  -> persists task snapshots and serves polling views to the UI
```

There is no single owner for a run. `CtfOrchestrator.run()` owns phase transitions and terminal state, `AgentRuntime.run()` owns another loop and its own state, `CcBridgeRuntime` owns an external process and compatible shadow fields, and `_agent_think_legacy()` remains a separate fallback.

## Confirmed implementation findings

### Control flow and fallback

- `backend/app/core/ctf_agent_orchestrator.py:499` runs the outer phase machine.
- `backend/app/core/ctf_agent_orchestrator.py:1001` selects either the inner runtime or the legacy loop.
- `backend/app/core/ctf_agent_orchestrator.py:1079` constructs both an `AgentRuntime` and, conditionally, a `CcBridgeRuntime`.
- `backend/app/core/cc_bridge_runtime.py:87` may fall back to the internal runtime on disabled configuration, missing CLI, or bridge failure.
- README, AGENTS.md, CLAUDE.md, `.env.example`, and `config.py` disagree about whether the internal runtime, Codex, or Claude Code is authoritative.

### Events and projections

- `AgentRuntime` stores mutable `turns` and `ledger` lists in memory.
- `_sync_runtime_to_task()` iterates every prior turn and ledger record on every poll. Shell/script history and evidence are appended again, so the projection is not idempotent.
- Existing persistence stores task snapshots and several legacy record types. It is not an append-only run event log with a unique `(run_id, sequence)` cursor.
- The UI event endpoint returns legacy evidence, script runs, flags, and state snapshots rather than replayable canonical events.

### Tools

- `ToolSpec` contains schema, permissions, risk, and timeout metadata.
- `AgentRuntime._default_execute()` separately dispatches names through a large `if/elif` chain to private methods.
- Classes under `backend/app/tools/` provide a third execution surface using `BaseTool.run()`.
- The bridge receives tool names in prompt text; it cannot call the registered ZHULONG-X executors.

### Provider protocol

- `LLMAdapter` handles provider-specific HTTP payloads and returns `LLMResponse`.
- The inner runtime supplies native OpenAI tools where supported, then always calls `parse_tool_calls()` with native and text content.
- The legacy loop asks for JSON or line-oriented actions and parses text again.
- Retries and timeouts exist, but there is no run abort token that can interrupt an active provider request.

### Validation

- Tool output is scanned for flag-like strings and assigned confidence.
- A format match can become `final_answer` in `AgentRuntime`.
- `CcBridgeRuntime` selects the highest-confidence stdout candidate as `best_flag`.
- The outer `FlagVerifier` adds another validation step, but the core distinction between detected, reproduced, validated, and accepted is absent.
- Demo API code reads `expected_flag.txt` into task metadata and returns it to the caller, even though comments say the orchestrator does not read it.

### Filesystem, process, and network isolation

- `AgentRuntime._safe_path()` explicitly permits `/tmp`, `/proc`, `/etc`, `/usr`, `/bin`, `/lib`, `/opt`, and `/var/tmp` outside the workspace.
- The separate filesystem tools use lexical prefix checks and do not resolve symlinks.
- ZIP traversal is skipped, but TAR extraction is delegated to host `tar` without member validation.
- `CodeExecutionSandbox` states that it is not container isolation. It executes `bash -c` on the host, uses deny patterns instead of a strict command policy, and copies most non-secret service environment variables.
- Timeout uses `subprocess.run()` without explicit process-group ownership. The API stop endpoint removes bookkeeping immediately, while worker/model/tool activity can remain alive.
- Network denial relies partly on proxy variables and binary-name checks. Direct sockets and non-listed clients are not contained at the OS boundary.

### Tests, benchmarks, and release hygiene

- No root pytest configuration exists. Generated `backend/data/ctf_runs/**/*_test.py` files are discoverable.
- The default run directory is inside the backend source tree.
- `scripts/hard_ctf_benchmark.py` defaults to `baseline` and executes per-case `baseline_solve.py`.
- `scripts/solve_ctf_case.py` directly invokes deterministic solvers instead of the main runtime.
- Root `.env` and `backend/.env` both contain a set non-placeholder `WQ_API_KEY`. Values were not copied into this audit.
- Local development data includes databases and generated run workspaces. Packaging excludes several paths but does not consistently exclude recovered vendor and skill-vendor trees.

## Current test baseline

The focused security/runtime selection was run with `/Users/j1k3r/miniforge3/bin/python3` because the shell's system Python is 3.9 with SQLAlchemy 1.x and cannot import this Python 3.11+ project.

```text
43 selected tests: 42 passed, 1 failed
failure: AgentRuntime allowed write_file to /tmp/evil.py
```

Root discovery was intentionally not run before adding a root `pytest.ini`, because collection can import generated network-capable scripts.

## Decision

The current runtime is treated as legacy. v2 will be a new Python package with no import from `CtfOrchestrator`. Existing APIs will use an adapter and event projections while migration is in progress; v2 failure will remain visible and will not invoke a hidden legacy fallback.
