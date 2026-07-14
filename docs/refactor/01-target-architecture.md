# Target Architecture

## Authority boundary

One run has exactly one `AgentSession`. The FastAPI control plane may create, start, inspect, cancel, and resume a session, but it does not choose solve phases or execute tools itself.

```text
FastAPI control plane
  -> RunManager
       -> AgentSession
            -> append-only EventStore
            -> SessionState and CheckpointStore
            -> ContextBuilder and SkillIndex
            -> Provider adapter
            -> small tool-use loop
            -> PolicyEngine
            -> ToolRegistry -> ToolExecutor
            -> Sandbox
            -> Scenario -> Validator
  -> event projections for current UI and incremental event API
```

## Core contracts

### RunRequest

The core request contains task identity, objective, inputs, scenario, authorization, network policy, budgets, and model configuration. It does not contain `expected_flag` or other evaluator answers.

### AgentSession

`AgentSession` exclusively owns lifecycle and terminal state. Valid terminal states are `succeeded`, `failed`, `timed_out`, `cancelled`, and `human_required`. A terminal event is appended once. Repeated `run()` or cancel calls cannot create another terminal transition.

### EventStore

Every model request/response, tool request/result, policy decision, skill load, state update, checkpoint, candidate decision, and lifecycle transition is appended before projections are updated.

Each event has:

```text
event_id, run_id, sequence, created_at, type, actor,
parent_event_id, payload, redaction_metadata
```

`(run_id, sequence)` is unique. Consumers request `after_sequence`, so polling and reconnect do not replay already projected actions. Secrets are redacted before serialization.

### Provider

All providers return `AssistantTurn(text, tool_calls, usage, finish_reason, raw_response_ref)`. Provider-specific HTTP formats, compatibility parsing, retry classification, and raw-response storage stay inside adapters. The core loop never searches model text for tool JSON.

### ToolRegistry

A `ToolDefinition` binds name, description, JSON Schema, permissions, risk, timeout, and the executor instance. Model schemas and execution lookup use the same immutable definition. Unknown or malformed calls produce structured tool failures and events.

Large results are stored as artifacts. Model context receives a bounded summary and artifact/event reference.

### Policy and scope

Policy runs before every tool execution. Filesystem access is workspace-relative after `Path.resolve()` and symlink resolution. Network defaults to deny and requires run authorization plus an explicit host/CIDR/port allowlist. DNS results are checked before connection. Localhost, metadata, and private ranges remain denied unless explicitly included.

### Sandbox

`LocalTestSandbox` exists for deterministic tests and local development only. It owns child process groups, uses a minimal environment, and supports timeout/abort tree termination. It reports `release_capable = false`.

Production uses `ContainerSandbox`, with only the run workspace mounted, network disabled by default, explicit resource limits, and no backend secrets. If the container runtime is unavailable, production startup or run creation fails visibly. It never falls back to host execution.

### Skills

Startup context contains only skill name, one-line description, scenarios, and required tools. `load_skill` resolves and reads the full body on demand and emits `skill.loaded`. Skill files cannot contain evaluator answers or mandatory writeup search behavior.

### Validation

Candidate lifecycle is explicit:

```text
candidate.detected
  -> evidence binding
  -> optional reproduction
  -> authoritative or configured offline validation
  -> candidate.validated or candidate.rejected
  -> run.succeeded only after acceptance
```

CTF, finding, incident response, reverse/forensics, and scoped pentest scenarios provide validators and completion schemas without leaking scenario-specific fields into session core.

## Package boundary

```text
backend/app/agent_engine/
  session.py, loop.py, events.py, state.py, context.py
  checkpoint.py, budget.py, abort.py
  providers/
  tools/
  policy/
  sandbox/
  skills/
  validation/

backend/app/scenarios/
  base.py
  ctf/
  pentest/
  vuln_analysis/
  incident_response/
  reverse_forensics/
```

`agent_engine` must not import `ctf_agent_orchestrator`, `AgentRuntime`, or `CcBridgeRuntime`.

## Release invariants

- Default runtime is v2 and cannot silently switch implementations.
- Production cannot select `LocalTestSandbox`.
- Secrets, evaluator answers, raw provider credentials, and service environment are not persisted in run events or child environments.
- Uploaded originals are mounted/read as immutable inputs; tools write to a separate workspace.
- UI actions are projections of canonical event IDs.
- Benchmark `agent` mode starts the same `AgentSession` used by the API.
- Any missing container, authoritative validator, or hidden benchmark result is reported as an unmet release condition.
