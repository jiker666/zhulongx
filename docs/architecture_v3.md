# Agent Engine v3 Architecture

## Authority

- `AgentSession` owns single-Agent lifecycle and terminal state.
- `CoordinatorSession` owns declarative multi-Agent workflow lifecycle.
- `AppendOnlyEventStore` is the audit and recovery source.
- `StateReducer` is the canonical projection function.
- `AgentRunService` is the only formal session construction path.
- scenario plugins own manifest, Plan, WorkflowSpec, completion schema, and validator.

```mermaid
flowchart TD
    API["FastAPI control plane"] --> SERVICE["AgentRunService"]
    SERVICE --> SESSION["AgentSession"]
    SERVICE --> COORD["CoordinatorSession"]
    COORD --> DAG["Plan / TaskGraph"]
    DAG --> SCHED["WorkflowScheduler"]
    SCHED --> SUB["SubagentManager"]
    SUB --> MAIL["Mailbox + child checkpoints"]
    SESSION --> PROVIDER["Provider adapter"]
    SESSION --> TOOL["ToolExecutionService"]
    TOOL --> POLICY["PolicyEngine"]
    TOOL --> SANDBOX["ContainerSandbox"]
    SESSION --> VALIDATOR["Scenario validator"]
    SESSION --> EVENTS["EventStore"]
    COORD --> EVENTS
    SUB --> EVENTS
    EVENTS --> REDUCER["StateReducer"]
    REDUCER --> PROJECTION["API / SSE / UI / audit export"]
```

## Native Tool Sequence

```mermaid
sequenceDiagram
    participant M as ModelProvider
    participant L as AgentLoop
    participant P as PolicyEngine
    participant T as ToolExecutor
    participant E as EventStore
    participant V as Validator
    L->>M: system/user + assistant tool_calls + tool results
    M-->>L: AssistantTurn(tool_calls[])
    L->>E: model.responded
    loop each bounded batch
        L->>P: authorize ToolDefinition
        P->>E: policy.allowed or policy.denied
        L->>T: execute idempotent/locked call
        T->>E: tool.finished or tool.failed
    end
    L->>V: evidence-bound candidate
    V->>E: validation.completed
    alt authoritative acceptance
        L->>E: completion.decided then run.succeeded
    else no evaluator
        L->>E: candidate.pending_external
    else blocked
        L->>E: human.requested with structured handoff
    end
```

## Recovery

Events use contiguous per-run sequence numbers and schema version 1. Checkpoints store the reducer state,
budget usage, and event offset atomically. Provider tool-call IDs are replay keys; completed calls return their
stored result and non-idempotent tools are not repeated. Subagents persist independent summaries/transcripts
under `.agent_subagents/<agent_id>/.agent_state/`.

## Runtime Boundary

Formal API modules import `agent_engine` and `scenarios` only. The old orchestrator, old runtime, and bridge
remain compatibility/research code and have no default selection or fallback role.
