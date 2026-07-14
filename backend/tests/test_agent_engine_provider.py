import json

import httpx
import pytest

from app.agent_engine.abort import AbortToken, RunAborted
from app.agent_engine.providers.base import ProviderError
from app.agent_engine.providers.factory import configured_provider
from app.agent_engine.providers.openai_compatible import OpenAICompatibleProvider
from app.agent_engine.state import ModelConfig
from app.config import settings


def test_openai_provider_parses_native_tool_calls_and_usage():
    captured = {}

    def handler(request):
        captured["authorization"] = request.headers.get("authorization")
        captured["payload"] = json.loads(request.content)
        return httpx.Response(200, json={
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": '{"path":"input.txt"}'},
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
        })

    provider = OpenAICompatibleProvider(
        base_url="https://provider.example/v1",
        api_key="test-secret-key",
        model="test-model",
        transport=httpx.MockTransport(handler),
    )
    turn = provider.complete(
        [{"role": "user", "content": "read the file"}],
        [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}],
        timeout_seconds=5,
        abort_token=AbortToken(),
    )

    assert turn.tool_calls[0].name == "read_file"
    assert turn.tool_calls[0].arguments == {"path": "input.txt"}
    assert turn.usage["total_tokens"] == 18
    assert turn.raw_response_ref.startswith("sha256:")
    assert captured["authorization"] == "Bearer test-secret-key"
    assert captured["payload"]["tools"][0]["function"]["name"] == "read_file"


def test_openai_provider_malformed_tool_call_is_structured_error():
    provider = OpenAICompatibleProvider(
        base_url="https://provider.example/v1",
        api_key="secret",
        model="test-model",
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
            "choices": [{
                "message": {
                    "content": "",
                    "tool_calls": [{
                        "id": "bad_call",
                        "function": {"name": "read_file", "arguments": "{not-json"},
                    }],
                },
                "finish_reason": "tool_calls",
            }],
        })),
    )

    with pytest.raises(ProviderError) as raised:
        provider.complete([], [], timeout_seconds=5, abort_token=AbortToken())

    assert raised.value.code == "malformed_tool_call"
    assert raised.value.retryable is False


def test_openai_provider_retries_only_retryable_status():
    attempts = {"count": 0}

    def handler(request):
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(429, json={"error": "rate limited"})
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "done"}, "finish_reason": "stop"}],
            "usage": {},
        })

    provider = OpenAICompatibleProvider(
        base_url="https://provider.example/v1",
        api_key="secret",
        model="test-model",
        max_retries=1,
        transport=httpx.MockTransport(handler),
    )

    turn = provider.complete([], [], timeout_seconds=5, abort_token=AbortToken())

    assert turn.text == "done"
    assert attempts["count"] == 2


def test_openai_provider_honors_preexisting_abort():
    token = AbortToken()
    token.abort("stop now")
    provider = OpenAICompatibleProvider(
        base_url="https://provider.example/v1",
        api_key="secret",
        model="test-model",
        transport=httpx.MockTransport(lambda request: pytest.fail("request must not be sent")),
    )

    with pytest.raises(RunAborted, match="stop now"):
        provider.complete([], [], timeout_seconds=5, abort_token=token)


def test_configured_provider_rejects_untrusted_per_run_base_url(monkeypatch):
    monkeypatch.setattr(settings, "LLM_ENABLED", True)
    monkeypatch.setattr(settings, "LLM_PROVIDER", "openai_compatible")
    monkeypatch.setattr(settings, "LLM_BASE_URL", "https://gateway.example/v1")
    monkeypatch.setattr(settings, "LLM_MODEL", "configured-model")
    monkeypatch.setattr(settings, "LLM_API_KEY", "configured-secret")

    with pytest.raises(ValueError, match="base URL is not allowed"):
        configured_provider(ModelConfig(
            provider="openai_compatible",
            model="requested-model",
            base_url="https://untrusted.example/v1",
        ))


def test_configured_provider_fails_visibly_when_profile_key_is_missing(monkeypatch):
    monkeypatch.setattr(settings, "LLM_ENABLED", True)
    monkeypatch.setattr(settings, "LLM_PROVIDER", "openai_compatible")
    monkeypatch.setattr(settings, "LLM_BASE_URL", "https://gateway.example/v1")
    monkeypatch.setattr(settings, "LLM_MODEL", "configured-model")
    monkeypatch.setattr(settings, "LLM_API_KEY", "replace_me")

    with pytest.raises(ValueError, match="no configured API key"):
        configured_provider(ModelConfig(provider="openai_compatible", model="requested-model"))
