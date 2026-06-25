"""
Tests for LLMAdapter - mock mode, JSON mode, masking.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.llm_adapter import (
    LLMAdapter,
    LLMResponse,
    detect_provider,
    mask_secret,
    mask_sensitive_in_text,
    sanitize_messages_for_provider,
)


def test_mock_mode_auto_on_when_disabled():
    os.environ["APP_ENV"] = "dev"
    a = LLMAdapter(enabled=False)
    assert a.mock_mode is True


def test_mock_classify_returns_json():
    a = LLMAdapter(enabled=False)
    resp = a.chat(
        [{"role": "user", "content": "please classify this CTF problem"}],
        json_mode=True,
    )
    assert resp.success
    data = json.loads(resp.content)
    assert "category" in data
    assert "confidence" in data


def test_mock_generate_script_returns_python():
    a = LLMAdapter(enabled=False)
    resp = a.chat(
        [{"role": "user", "content": "please generate solve.py for this crypto challenge"}],
    )
    assert resp.success
    # Should be valid Python (no markdown fence)
    assert "import" in resp.content
    assert "def " in resp.content
    assert not resp.content.startswith("```")


def test_chat_json_extracts_from_fence():
    """If LLM wraps JSON in code fence, adapter should still parse it."""
    a = LLMAdapter(enabled=False)
    # Manually mock response with fence
    a._mock_complete = lambda msgs, json_mode=False: LLMResponse(
        success=True,
        content='```json\n{"k": "v"}\n```',
        model="mock",
    )
    ok, data, resp = a.chat_json([{"role": "user", "content": "test"}])
    assert ok
    assert data == {"k": "v"}


def test_disabled_when_not_mock_and_not_enabled():
    # If we explicitly disable mock by setting APP_ENV=prod, and LLM_ENABLED=false
    os.environ["APP_ENV"] = "prod"
    a = LLMAdapter(enabled=False)
    if not a.mock_mode:
        resp = a.chat([{"role": "user", "content": "hi"}])
        assert not resp.success
        assert "disabled" in resp.error.lower()
    os.environ["APP_ENV"] = "dev"


def test_mask_secret():
    assert mask_secret(None) == "(not configured)"
    assert mask_secret("replace_me") == "(not configured)"
    assert mask_secret("sk-abc") == "****"
    masked = mask_secret("sk-abcdefghijklmno")
    # head 4 + tail 4 preserved
    assert masked.startswith("sk-a")
    assert masked.endswith("lmno")
    assert "****" in masked


def test_mask_sensitive_in_text():
    text = "my token is sk-abcd1234567890wxyz and bearer abcdefghijklmnop123"
    out = mask_sensitive_in_text(text)
    assert "MASKED" in out
    assert "sk-abcd1234567890wxyz" not in out


def test_detect_provider():
    assert detect_provider("deepseek-chat") == "deepseek"
    assert detect_provider("qwen2.5-coder") == "qwen"
    assert detect_provider("glm-4") == "glm"
    assert detect_provider("moonshot-v1") == "moonshot"
    assert detect_provider("gpt-4") == "openai"
    assert detect_provider("unknown-model", "https://api.deepseek.com/v1") == "deepseek"


def test_sanitize_for_qwen():
    msgs = [
        {"role": "developer", "content": "you are CTF expert"},
        {"role": "system", "content": "be careful"},
        {"role": "user", "content": "solve this"},
    ]
    out = sanitize_messages_for_provider(msgs, "qwen")
    # qwen does not support developer role → should be merged to system
    roles = [m["role"] for m in out]
    assert "developer" not in roles
    assert "system" in roles
    # merged system content
    sys_msg = [m for m in out if m["role"] == "system"][0]
    assert "CTF expert" in sys_msg["content"]
    assert "be careful" in sys_msg["content"]


def test_sanitize_for_openai_keeps_developer():
    msgs = [
        {"role": "developer", "content": "you are CTF expert"},
        {"role": "user", "content": "solve"},
    ]
    out = sanitize_messages_for_provider(msgs, "openai")
    roles = [m["role"] for m in out]
    assert "developer" in roles


def test_chat_with_system_prompt():
    a = LLMAdapter(enabled=False)
    resp = a.chat(
        [{"role": "user", "content": "classify this"}],
        system_prompt="You are a CTF expert. Respond in JSON.",
        json_mode=True,
    )
    assert resp.success
