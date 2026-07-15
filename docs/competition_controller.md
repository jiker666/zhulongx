# Competition control plane

Competition control is implemented by the v3 `RunManager` and `AgentSession`:

- `AgentRunService` creates and restores sessions.
- `RunManager` owns the in-process run/thread index.
- `AgentSession` owns status, abort, pause, resume, validation, and checkpoints.
- `AppendOnlyEventStore` plus `StateReducer` is the state authority.
- `CanonicalRunProjection` supplies the compatibility response shape.

The API never maintains a parallel controller state map. Scheduling across
multiple runs belongs in the v3 coordinator and subagent manager.
