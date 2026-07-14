# Competition API on Agent Engine v3

`/api/competition` is a compatibility facade, not an independent runtime. It
constructs every run through `AgentRunService`, stores lifecycle state in
`AgentSession`, and projects the append-only v3 event stream for clients.

Operator actions resolve against the session's v3 `ToolRegistry` and execute
through `ToolExecutionService`. Policy decisions and tool start, completion,
or failure are canonical events consumed by `StateReducer`. Hypotheses, human
evidence, pause, resume, external validation, and cancel update that same event
stream. There is no competition-owned `TaskState`, controller state dictionary,
tool broker, event store, or terminal-state machine.

The teammate `competition_runtime.py` and `agent_tool_gateway.py` prototypes
were removed during the v3 merge because they duplicated these authorities.
