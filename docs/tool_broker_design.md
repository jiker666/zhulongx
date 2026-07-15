# Canonical tool execution

Agent Engine v3 `ToolExecutionService` is the only production tool execution
path. It resolves one `ToolDefinition` from `ToolRegistry`, validates arguments,
asks `PolicyEngine`, emits requested/allowed/started/result events, bounds
output, and supports completed-call replay by `tool_call_id`.

Worker and PTY definitions use this path. The teammate `ToolBroker` and legacy
Worker tool registrations were removed to avoid a second policy, evidence, and
execution ledger.
