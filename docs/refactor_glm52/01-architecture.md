# Agent Engine v3 Target Architecture

## One harness

Agent Engine v3 remains the only formal runtime. The root and leaf execution modes share one control-plane protocol and the existing event/state/tool/sandbox implementation.

```text
AgentRunService
  -> RunSessionFactory
     -> CoordinatorSession (auto/coordinator)
        -> DynamicPlanner
        -> TaskGraphStore
        -> OrchestrationScheduler
        -> SubagentManager
           -> LLMSubagentWorker
              -> AgentSession / AgentLoop
        -> Replanner + PlanPatchValidator
        -> CompletionPolicy + Scenario Validator
        -> Synthesizer
     -> AgentSession (explicit single/simple auto selection)
```

`backend/app/core/cc_bridge_runtime.py` and other legacy runtime modules remain compatibility/research code. Factory failures are visible and never route to those modules.

## ManagedRun control plane

`ManagedRun` defines the surface consumed by `RunManager` and APIs:

- identity and state: `run_id`, `request`, `state`, `workspace`, `events`, `sandbox`
- lifecycle: `run()`, `abort(reason)`, `pause_for_human(reason)`
- human/external resume operations
- `event_stream(after_sequence=0)`
- operator evidence, hypothesis, and tool operations where supported

Both session types emit the same terminal events and are projected by `StateReducer`. Root and child events carry `root_run_id`, `parent_run_id`, `child_run_id`, `agent_id`, `task_id`, and role in their public payload/lineage. Raw model reasoning is excluded.

## Mode selection

The request value is `auto | coordinator | single`.

- `coordinator`: always construct a root coordinator.
- `single`: construct an `AgentSession` explicitly.
- `auto`: select coordinator for attachments, security scenarios, multi-step objectives, or configured high autonomy; select single only for a clearly bounded simple request.

Selection emits `run.mode_selected` with the effective mode and a public reason list. It occurs before model execution and has no legacy fallback.

## Planning and graph ownership

Deterministic intake inventories immutable inputs before the planner runs. The planner receives a scenario macro as a prior, not as the final plan. It returns a schema-validated `PlanProposal` with assumptions, unknowns, hypotheses, nodes, critical path, alternatives, completion contract, risks, and a rationale summary.

`TaskGraphStore` is the graph authority. It validates unique IDs, role/tool scopes, dependencies, cycles, graph budget, and completion contracts. Scheduler state is projected from events. A revision uses a finite `PlanPatch` operation set; accepted patches create a structural diff and a new graph version. Checkpoints contain the graph version and pending queue cursor.

## Child execution

`LLMSubagentWorker` constructs an `AgentSession` with:

- a unique child run ID and parent/root lineage
- a role-specific execution profile and system contract
- a capability-selected tool registry (maximum 128 schemas)
- an isolated or explicitly read-only shared workspace
- a task budget and abort token linked to the parent
- an independent transcript/private reasoning store and checkpoint path
- a compact structured `AgentHandoff`

The coordinator reads handoffs and referenced evidence by default, not full child transcripts. A verifier/refuter receives a clean context pack and independently replays evidence.

## Provider and reasoning boundary

`GLM52Provider` owns model capabilities, request validation, capability negotiation, SSE parsing, tool-call assembly, retry/cancellation, and preserved thinking order. The provider returns public text, tool calls, usage, public decision summary, metadata, and opaque references to private reasoning.

Private reasoning is never included in canonical public events, SSE, UI state, audit ZIPs, or normal logs. Where continuous thinking requires persistence, encrypted/restricted transcript storage has an explicit retention policy. Public auditability comes from plans, decisions, tool requests/results, evidence, and verifier verdicts.

## Tool and sandbox boundary

The model proposes operations; the harness performs schema validation, policy evaluation, scope checks, idempotency, resource locking, Worker/ContainerSandbox execution, cancellation, artifact storage, evidence extraction, and state events. Plugin hooks can narrow or observe decisions but cannot bypass `PolicyEngine`.

Release mode has no host sandbox fallback. Parent cancellation propagates to child sessions, active tool calls, process trees, and containers before the terminal event is committed.

## Completion

Models never set terminal success directly. `CompletionPolicy` combines the plan's completion contract, scenario validator, evidence lineage, independent verdicts, and external evaluator state. A rejection produces a graph revision or a precise human handoff; it does not implicitly succeed.

## UI projection

The existing canonical event stream feeds:

- plan DAG, critical path, status and revision diffs
- child-agent lanes, budgets, active tools and handoffs
- facts, hypotheses, evidence, artifacts and verdicts
- pause/resume/cancel and permitted branch controls

The projection contains public decision summaries only.

