# Integrated capabilities

The teammate merge contributes an isolated Linux command and PTY backend,
typed Worker transport, process-group cancellation, capability discovery, and
task ownership checks. These capabilities are registered as v3 tools and emit
the same policy and execution events as local tools.

Existing v3 planning, hypotheses, bounded subagents, evidence, verification,
checkpoint/replay, and audit export remain the only orchestration
implementations. Duplicate controller, broker, repository, replay, and
cancellation prototypes were not retained.
