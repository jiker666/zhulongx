import json
import stat

import httpx
import pytest

from app.agent_engine.abort import AbortToken, RunAborted
from app.agent_engine.events import EventType
from app.agent_engine.providers.base import AssistantTurn, ProviderError, ProviderToolCall, ReasoningBlock
from app.agent_engine.providers.factory import configured_provider
from app.agent_engine.providers.glm52 import GLM52Provider
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.state import ModelConfig, RunRequest, RunStatus
from app.agent_engine.validation.base import PredicateValidator
from app.config import settings


def _stream(*chunks):
    records = [f"data: {json.dumps(chunk)}\n\n" for chunk in chunks]
    records.append("data: [DONE]\n\n")
    return "".join(records)


def _response_stream(*chunks):
    return httpx.Response(
        200,
        text=_stream(*chunks),
        headers={"content-type": "text/event-stream"},
    )


def _provider(handler, **kwargs):
    return GLM52Provider(
        base_url="https://glm.example/v4",
        api_key="fixture-key",
        transport=httpx.MockTransport(handler),
        max_retries=0,
        **kwargs,
    )


def test_glm52_stream_assembles_reasoning_content_and_multiple_split_tool_calls():
    captured = {}

    def handler(request):
        captured["payload"] = json.loads(request.content)
        captured["headers"] = dict(request.headers)
        return _response_stream(
            {"id": "resp_1", "model": "glm-5.2", "choices": [{"delta": {"reasoning_content": "private "}}]},
            {"choices": [{"delta": {"reasoning_content": "analysis"}}]},
            {"choices": [{"delta": {"content": "Checking."}}]},
            {"choices": [{"delta": {"tool_calls": [{
                "index": 0, "id": "call_a", "function": {"name": "read_file", "arguments": '{"path":'},
            }]}}]},
            {"choices": [{"delta": {"tool_calls": [{
                "index": 1, "id": "call_b", "function": {"name": "grep", "arguments": '{"query":"flag",'},
            }]}}]},
            {"choices": [{"delta": {"tool_calls": [{
                "index": 0, "function": {"arguments": '"input.txt"}'},
            }, {
                "index": 1, "function": {"arguments": '"path":"."}'},
            }]}, "finish_reason": "tool_calls"}], "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "prompt_tokens_details": {"cached_tokens": 4},
            }},
        )

    provider = _provider(handler)
    turn = provider.complete(
        [{"role": "user", "content": "inspect"}],
        [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}],
        timeout_seconds=5,
        abort_token=AbortToken(),
    )

    assert turn.text == "Checking."
    assert [(call.id, call.name, call.arguments) for call in turn.tool_calls] == [
        ("call_a", "read_file", {"path": "input.txt"}),
        ("call_b", "grep", {"query": "flag", "path": "."}),
    ]
    assert turn.private_reasoning_blocks[0].content == "private analysis"
    assert turn.private_reasoning_ref.startswith("sha256:")
    assert "private analysis" not in repr(turn)
    assert "private analysis" not in json.dumps(turn.public_metadata())
    assert turn.usage == {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cached_tokens": 4}
    assert captured["payload"]["thinking"] == {"type": "enabled", "clear_thinking": False}
    assert captured["payload"]["reasoning_effort"] == "max"
    assert captured["payload"]["stream"] is True
    assert captured["payload"]["tool_stream"] is True
    assert captured["headers"]["authorization"] == "Bearer fixture-key"


def test_glm52_preserved_thinking_is_returned_unmodified_on_next_tool_turn():
    payloads = []

    def handler(request):
        payloads.append(json.loads(request.content))
        if len(payloads) == 1:
            return _response_stream(
                {"choices": [{"delta": {"reasoning_content": "exact-private-block"}}]},
                {"choices": [{"delta": {"tool_calls": [{
                    "index": 0,
                    "id": "call_1",
                    "function": {"name": "read_file", "arguments": '{"path":"a.txt"}'},
                }]}, "finish_reason": "tool_calls"}]},
            )
        return _response_stream(
            {"choices": [{"delta": {"content": "done"}, "finish_reason": "stop"}]},
        )

    provider = _provider(handler, clear_thinking=False)
    first = provider.complete(
        [{"role": "user", "content": "read"}],
        [],
        timeout_seconds=5,
        abort_token=AbortToken(),
    )
    history = [
        {"role": "user", "content": "read"},
        {
            "role": "assistant",
            "content": first.text,
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "read_file", "arguments": '{"path": "a.txt"}'},
            }],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "result"},
    ]
    provider.complete(history, [], timeout_seconds=5, abort_token=AbortToken())

    assert payloads[1]["messages"][1]["reasoning_content"] == "exact-private-block"


def test_glm52_clear_thinking_removes_historical_reasoning():
    captured = {}

    def handler(request):
        captured["payload"] = json.loads(request.content)
        return _response_stream({"choices": [{"delta": {"content": "done"}, "finish_reason": "stop"}]})

    provider = _provider(handler, clear_thinking=True)
    provider.complete(
        [{"role": "assistant", "content": "public", "reasoning_content": "must-be-cleared"}],
        [],
        timeout_seconds=5,
        abort_token=AbortToken(),
    )

    assert "reasoning_content" not in captured["payload"]["messages"][0]
    assert captured["payload"]["thinking"]["clear_thinking"] is True


def test_glm52_private_transcript_survives_provider_reconstruction(tmp_path):
    store_path = tmp_path / "private" / "provider_transcript.json"
    first_provider = _provider(lambda request: _response_stream(
        {"choices": [{"delta": {"reasoning_content": "resume-exact-reasoning"}}]},
        {"choices": [{"delta": {"content": "public"}, "finish_reason": "stop"}]},
    ))
    first_provider.bind_private_transcript(str(store_path))
    first = first_provider.complete(
        [{"role": "user", "content": "start"}],
        [],
        timeout_seconds=5,
        abort_token=AbortToken(),
    )

    captured = {}

    def resumed_handler(request):
        captured["payload"] = json.loads(request.content)
        return _response_stream({"choices": [{"delta": {"content": "resumed"}, "finish_reason": "stop"}]})

    resumed_provider = _provider(resumed_handler)
    resumed_provider.bind_private_transcript(str(store_path))
    resumed_provider.complete(
        [
            {"role": "user", "content": "start"},
            {"role": "assistant", "content": first.text},
            {"role": "user", "content": "continue"},
        ],
        [],
        timeout_seconds=5,
        abort_token=AbortToken(),
    )

    assert captured["payload"]["messages"][1]["reasoning_content"] == "resume-exact-reasoning"
    assert stat.S_IMODE(store_path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(store_path.stat().st_mode) == 0o600
    resumed_provider.clear_private_transcript()
    assert not store_path.exists()


def test_glm52_non_streaming_parses_private_reasoning_without_public_leak():
    provider = _provider(
        lambda request: httpx.Response(200, json={
            "id": "response",
            "model": "glm-5.2",
            "choices": [{
                "message": {"content": "public", "reasoning_content": "sensitive-reasoning-body"},
                "finish_reason": "stop",
            }],
            "usage": {"total_tokens": 3},
        }),
        stream=False,
        tool_stream=False,
    )

    turn = provider.complete([], [], timeout_seconds=5, abort_token=AbortToken())

    assert turn.text == "public"
    assert turn.private_reasoning_blocks[0].content == "sensitive-reasoning-body"
    assert "sensitive-reasoning-body" not in json.dumps(turn.public_metadata())


def test_glm52_gateway_capability_downgrade_is_explicit():
    payloads = []

    def handler(request):
        payloads.append(json.loads(request.content))
        if len(payloads) == 1:
            return httpx.Response(400, json={"error": "unsupported optional fields"})
        return _response_stream({"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]})

    turn = _provider(handler).complete(
        [],
        [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}],
        timeout_seconds=5,
        abort_token=AbortToken(),
    )

    assert len(payloads) == 2
    assert turn.provider_metadata["capability_negotiation"]["downgraded_fields"] == [
        "tool_stream",
        "reasoning_effort",
        "thinking.clear_thinking",
    ]
    assert "tool_stream" not in payloads[1]
    assert "reasoning_effort" not in payloads[1]
    assert "clear_thinking" not in payloads[1]["thinking"]


def test_glm52_retries_429_and_discards_partial_attempt_state():
    attempts = {"count": 0}

    def handler(request):
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(429, json={"error": "rate limited"})
        return _response_stream({"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]})

    provider = GLM52Provider(
        base_url="https://glm.example/v4",
        api_key="fixture-key",
        transport=httpx.MockTransport(handler),
        max_retries=1,
    )
    turn = provider.complete([], [], timeout_seconds=5, abort_token=AbortToken())

    assert turn.text == "ok"
    assert attempts["count"] == 2


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ("not-an-sse-record\n", "malformed_sse"),
        ("data: {not-json}\n\n", "malformed_sse"),
        ("data: {}\n\n", "incomplete_stream"),
    ],
)
def test_glm52_malformed_or_incomplete_sse_is_structured(body, code):
    provider = _provider(lambda request: httpx.Response(
        200,
        text=body,
        headers={"content-type": "text/event-stream"},
    ))

    with pytest.raises(ProviderError) as raised:
        provider.complete([], [], timeout_seconds=5, abort_token=AbortToken())

    assert raised.value.code == code


def test_glm52_enforces_parameter_and_function_limits():
    with pytest.raises(ValueError, match="temperature"):
        _provider(lambda request: httpx.Response(200), temperature=1.1)
    with pytest.raises(ValueError, match="max_tokens"):
        _provider(lambda request: httpx.Response(200), max_tokens=131_073)
    with pytest.raises(ValueError, match="tool_stream"):
        _provider(lambda request: httpx.Response(200), stream=False, tool_stream=True)

    provider = _provider(lambda request: pytest.fail("request must not be sent"))
    tools = [
        {"type": "function", "function": {"name": f"tool_{index}", "parameters": {"type": "object"}}}
        for index in range(129)
    ]
    with pytest.raises(ProviderError) as raised:
        provider.complete([], tools, timeout_seconds=5, abort_token=AbortToken())
    assert raised.value.code == "too_many_tools"


def test_glm52_honors_preexisting_abort():
    token = AbortToken()
    token.abort("stop glm")
    provider = _provider(lambda request: pytest.fail("request must not be sent"))

    with pytest.raises(RunAborted, match="stop glm"):
        provider.complete([], [], timeout_seconds=5, abort_token=token)


def test_glm52_transport_timeout_is_structured_and_retryable():
    def handler(request):
        raise httpx.ReadTimeout("fixture timeout", request=request)

    provider = _provider(handler)
    with pytest.raises(ProviderError) as raised:
        provider.complete([], [], timeout_seconds=1, abort_token=AbortToken())

    assert raised.value.code == "transport_error"
    assert raised.value.retryable is True


def test_glm52_cancel_during_stream_stops_parsing():
    token = AbortToken()

    class CancellingStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            token.abort("cancel during stream")
            yield b"data: [DONE]\n\n"

    provider = _provider(lambda request: httpx.Response(
        200,
        stream=CancellingStream(),
        headers={"content-type": "text/event-stream"},
    ))

    with pytest.raises(RunAborted, match="cancel during stream"):
        provider.complete([], [], timeout_seconds=5, abort_token=token)


def test_configured_provider_routes_glm52_to_native_implementation(monkeypatch):
    monkeypatch.setattr(settings, "LLM_ENABLED", True)
    monkeypatch.setattr(settings, "GLM_BASE_URL", "https://glm.example/v4")
    monkeypatch.setattr(settings, "GLM_API_KEY", "configured-key")
    monkeypatch.setattr(settings, "GLM_MODEL", "glm-5.2")

    provider = configured_provider(ModelConfig(provider="glm", model="glm-5.2"))

    assert isinstance(provider, GLM52Provider)
    assert provider.endpoint == "https://glm.example/v4/chat/completions"


def test_public_events_exclude_raw_reasoning_and_emit_capability_negotiation(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "evidence.txt").write_text("flag{private_boundary}", encoding="utf-8")
    negotiation = {
        "model": "glm-5.2",
        "requested": {"thinking": True},
        "downgraded_fields": [],
        "capabilities": {"supports_thinking": True},
    }
    provider = ScriptedProvider([
        AssistantTurn(
            tool_calls=(ProviderToolCall("read", "read_file", {"path": "evidence.txt"}),),
            private_reasoning_ref="sha256:fixture",
            private_reasoning_blocks=(ReasoningBlock(0, "RAW_REASONING_MUST_STAY_PRIVATE"),),
            decision_summary="Read the evidence file.",
            provider_metadata={"capability_negotiation": negotiation},
        ),
        AssistantTurn(
            tool_calls=(ProviderToolCall("submit", "submit_candidate", {
                "candidate": "flag{private_boundary}",
            }),),
            private_reasoning_ref="sha256:fixture-2",
            private_reasoning_blocks=(ReasoningBlock(0, "SECOND_RAW_REASONING"),),
            decision_summary="Submit the evidence-backed candidate.",
            provider_metadata={"capability_negotiation": negotiation},
        ),
    ])
    session = AgentSession(
        RunRequest("reasoning_boundary", "boundary", "verify privacy", str(workspace)),
        provider=provider,
        validator=PredicateValidator(lambda value: value == "flag{private_boundary}"),
        sandbox=LocalTestSandbox(workspace),
    )

    assert session.run().status == RunStatus.SUCCEEDED
    serialized = json.dumps([event.to_dict() for event in session.event_stream()])
    assert "RAW_REASONING_MUST_STAY_PRIVATE" not in serialized
    assert "SECOND_RAW_REASONING" not in serialized
    assert "Read the evidence file." in serialized
    assert [event.type for event in session.event_stream()].count(
        EventType.PROVIDER_CAPABILITY_NEGOTIATED.value
    ) == 1
