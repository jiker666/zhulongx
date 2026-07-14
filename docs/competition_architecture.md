# Competition architecture

The opt-in `/api/competition` runtime is additive. It creates isolated challenge workspaces and uses typed `TaskState`, `Hypothesis`, `ActionCandidate`, `EvidenceRecord`, `CandidateResult`, and `ToolResult`. Every action is scored before execution and goes through `ToolBroker`; out-of-profile, malformed, unavailable, and out-of-scope calls are denied with a structured result.

The legacy `/api/ctf` orchestrator remains the compatibility path. It is not replaced until it can consume the broker and durable state adapters.
