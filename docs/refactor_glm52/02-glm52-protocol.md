# GLM-5.2 Native Protocol

Captured against the official documentation on 2026-07-15:

- https://docs.z.ai/guides/llm/glm-5.2
- https://docs.z.ai/guides/capabilities/thinking-mode
- https://docs.z.ai/api-reference/llm/chat-completion
- https://docs.z.ai/guides/tools/stream-tool
- https://docs.bigmodel.cn/cn/guide/start/migrate-to-glm-new

## Capability profile

`GLM52_CAPABILITIES` is the executable source of limits:

| Capability | Value |
| --- | --- |
| Context window | 1,000,000 tokens |
| Maximum output | 131,072 tokens |
| Maximum functions | 128 |
| Thinking | supported; enabled by default by the model family |
| Reasoning effort | `none`, `minimal`, `low`, `medium`, `high`, `max`, `xhigh` |
| Interleaved thinking | supported |
| Preserved thinking | supported |
| Streaming | supported |
| Streaming tool arguments | supported with `stream=true`, `tool_stream=true` |
| Structured output | text / JSON object protocol support |
| Context cache | supported |

The official API currently constrains `temperature` to 0 through 1. Only `tool_choice=auto` is sent for function tools. The harness rejects a request that exceeds output or function limits before network I/O.

## Request

Example effective request:

```json
{
  "model": "glm-5.2",
  "messages": [{"role": "user", "content": "TASK"}],
  "thinking": {
    "type": "enabled",
    "clear_thinking": false
  },
  "reasoning_effort": "max",
  "temperature": 0.1,
  "max_tokens": 8192,
  "stream": true,
  "tool_stream": true,
  "tools": [],
  "tool_choice": "auto",
  "request_id": "REQUEST_ID"
}
```

`tool_stream` and tool fields are omitted when no tools are exposed. `reasoning_effort` is omitted when thinking is disabled. The provider uses distinct connect, read, write, and pool timeouts. Request IDs are generated per model call; optional trace/run IDs are headers and never contain credentials.

The dedicated environment configuration is:

```text
GLM_API_KEY
GLM_BASE_URL
GLM_MODEL=glm-5.2
GLM_THINKING_ENABLED=true
GLM_CLEAR_THINKING=false
GLM_REASONING_EFFORT=max
GLM_STREAM=true
GLM_TOOL_STREAM=true
GLM_MAX_OUTPUT_TOKENS
GLM_CONNECT_TIMEOUT
GLM_READ_TIMEOUT
```

The API key is loaded from settings and never copied into events, logs, metadata, or release reports.

## Stream state machine

```text
HTTP response
  -> validate status
  -> read SSE records
  -> ignore blank/comment/event/id records
  -> parse each data JSON object
  -> append reasoning_content fragments in arrival order
  -> append public content fragments in arrival order
  -> upsert tool buffer by tool_call.index
     -> retain id
     -> assemble name
     -> append arguments bytes/text without parsing
  -> retain finish_reason and final usage
  -> require data: [DONE]
  -> parse each completed arguments string exactly once
  -> validate each argument value is a JSON object
  -> construct AssistantTurn
```

Multiple tool calls and tool argument fragments are independent buffers. JSON is not parsed on every delta. A malformed SSE record, malformed chunk, incomplete stream, missing tool identity, or invalid final arguments object produces a structured `ProviderError`.

HTTP 408/409/429/5xx and transport/incomplete-stream errors are retryable within the configured bound. Each attempt has a fresh accumulator, so a partial failed attempt cannot be combined with the next response. An abort closes the active client and is checked between stream records.

## Preserved thinking

Official guidance requires complete historical `reasoning_content` to be returned unmodified and in the original order when `thinking.clear_thinking=false`. The native provider therefore:

1. retains each exact reasoning block separately from public events;
2. fingerprints the corresponding public assistant message and native tool calls;
3. restores reasoning only onto the exact matching assistant message in the next request;
4. never edits, summarizes, reorders, or substitutes the value used by the provider protocol;
5. removes historical reasoning from outgoing messages when `clear_thinking=true`.

For restart continuity, `AgentSession` binds the provider to:

```text
WORKSPACE/.agent_state/private/provider_transcript.json
```

The parent directory is mode `0700` and the file is mode `0600`. Writes are atomic. The store is not part of canonical events, SSE, the frontend, audit exports, or release packages. It is retained for crash recovery and human-paused runs, then removed on succeeded, failed, cancelled, or timed-out terminal states.

## Public reasoning boundary

`AssistantTurn` contains private `ReasoningBlock` values with representation disabled. Public event serialization contains only:

- an opaque SHA256 reasoning reference;
- per-block sequence, character count, and SHA256;
- a short public decision summary;
- usage and safe provider metadata;
- capability negotiation results.

`AgentLoop` emits `provider.capability_negotiated` once per effective negotiation and never places raw reasoning in `model.responded`. Explanations shown by API/UI must come from plan rationale, decision summaries, tools, evidence, and verifier verdicts.

## Capability negotiation

The provider first sends the configured native fields. If a compatible gateway returns HTTP 400 for optional fields and downgrade is enabled, it makes one explicit reduced retry after removing:

```text
tool_stream
reasoning_effort
thinking.clear_thinking
```

No core tool, message, policy, or model selection is changed. The returned turn includes `capability_negotiation.downgraded_fields`, which becomes a public provider capability event. A second rejection fails visibly. Other non-retryable 4xx responses fail directly.

## Test matrix

`backend/tests/test_agent_engine_glm52_provider.py` covers:

- non-streaming public text and private reasoning;
- streaming reasoning and content;
- two simultaneous tool calls with arguments split across chunks;
- final-only JSON validation;
- preserved-thinking order on the next tool turn;
- provider reconstruction from the restricted transcript store;
- `clear_thinking=true` removal;
- public event and object representation privacy;
- capability negotiation and explicit downgrade fields;
- 429 retry with fresh state;
- malformed JSON/SSE and incomplete stream;
- transport timeout;
- cancellation during a stream;
- max output, temperature, stream/tool-stream, and 128-function limits;
- factory routing to `GLM52Provider`.

