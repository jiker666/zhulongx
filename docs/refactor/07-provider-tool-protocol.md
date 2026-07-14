# Provider and Tool Protocol

## Canonical model turn

Providers return `AssistantTurn(text, tool_calls, usage, finish_reason, raw_response_ref)`. A tool call contains a
stable ID, name, and object arguments. Provider adapters own HTTP schema parsing, error classification, timeout,
retry, raw-response hashing, and token/cost metadata.

The context sequence is reconstructed as:

```json
{"role":"assistant","content":"...","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{...}"}}]}
{"role":"tool","tool_call_id":"call_1","name":"read_file","content":"{...bounded result...}"}
```

Policy denial and tool failure still produce a paired `role=tool` result, so the next model turn never receives an
orphan call. Golden tests cover multiple calls, success/failure pairing, malformed arguments, usage, retries, and
abort.

## Per-run routing

`RunRequest.model_config` controls provider, model, credential-free base URL/profile, temperature, maximum tokens,
timeout, and parallel tool support. `ModelRoutePolicy` can derive cheap, expert, and reviewer profiles by role.
Credential lookup happens only in `configured_provider`; keys are absent from requests, events, metadata,
checkpoints, and API responses. A per-run base URL must match the selected configured gateway profile, so a
request cannot redirect that profile's credential to another origin. Missing live credentials fail visibly rather
than selecting the mock provider.

## Tool definition

Each immutable `ToolDefinition` binds:

- JSON Schema and the real executor;
- permissions, risk, and timeout;
- idempotency and side-effect level;
- exclusive resource locks and `parallel_safe`;
- approval requirement and evidence type.

`BoundedToolBatchExecutor` parallelizes only read-only/idempotent calls marked parallel-safe with no conflicting
locks. Other calls execute in provider order. Event sequence remains canonical even when results finish out of
order. Completed call IDs replay their stored result after restart; a non-idempotent tool is never repeated because
of provider retry.

## State tools

`record_evidence`, `record_fact`, `record_hypothesis`, `refute_hypothesis`, and `revise_plan` validate input, then
emit canonical state events. They do not mutate `SessionState` directly. `StateReducer` applies the events, making
the same state reproducible from JSONL after process restart.
