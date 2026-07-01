"""Tests for runtime_config + settings API (v6.1)."""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

os.environ["LLM_ENABLED"] = "false"
os.environ["APP_ENV"] = "dev"

from app.main import app
from app.core.runtime_config import (
    get_runtime_config, EDITABLE_FIELDS, SENSITIVE_FIELDS,
    _mask_key, _coerce,
)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_runtime_config():
    """每个测试前后清空 runtime_config。"""
    rc = get_runtime_config()
    rc.reset()
    # 清空审计日志
    from app.core.runtime_config import _AUDIT_LOG
    try:
        _AUDIT_LOG.unlink(missing_ok=True)
    except Exception:
        pass
    yield
    rc.reset()
    try:
        _AUDIT_LOG.unlink(missing_ok=True)
    except Exception:
        pass


# ---------- unit tests ----------


def test_mask_key_not_configured():
    assert _mask_key(None) == "(not configured)"
    assert _mask_key("replace_me") == "(not configured)"
    assert _mask_key("") == "(not configured)"


def test_mask_key_configured_no_plaintext():
    masked = _mask_key("sk-supersecret1234567890")
    assert "sk-supersecret" not in masked
    assert "configured" in masked
    assert "length" in masked


def test_coerce_bool():
    assert _coerce("true", "bool") is True
    assert _coerce("false", "bool") is False
    assert _coerce("1", "bool") is True
    assert _coerce("yes", "bool") is True
    assert _coerce(True, "bool") is True


def test_coerce_int():
    assert _coerce("42", "int") == 42
    assert _coerce(42, "int") == 42


def test_coerce_float():
    assert _coerce("0.05", "float") == 0.05
    assert abs(_coerce(0.05, "float") - 0.05) < 1e-9


def test_coerce_str():
    assert _coerce("hello", "str") == "hello"
    assert _coerce(None, "str") is None
    assert _coerce("", "str") is None


def test_editable_fields_no_duplicates():
    assert len(EDITABLE_FIELDS) > 10
    # 所有 sensitive 字段都在 EDITABLE_FIELDS 里
    for s in SENSITIVE_FIELDS:
        assert s in EDITABLE_FIELDS
        assert EDITABLE_FIELDS[s]["sensitive"] is True


# ---------- update logic ----------


def test_update_non_sensitive_field():
    rc = get_runtime_config()
    from app.config import settings
    original = settings.LLM_BUDGET_PER_TASK_USD
    try:
        result = rc.update({"LLM_BUDGET_PER_TASK_USD": 0.15}, actor="test")
        assert "LLM_BUDGET_PER_TASK_USD" in result["applied"]
        assert settings.LLM_BUDGET_PER_TASK_USD == 0.15
    finally:
        settings.LLM_BUDGET_PER_TASK_USD = original


def test_update_sensitive_field_empty_keeps_original():
    rc = get_runtime_config()
    from app.config import settings
    original = settings.LLM_CHEAP_API_KEY
    try:
        result = rc.update({"LLM_CHEAP_API_KEY": ""}, actor="test")
        # 留空 = 保持，但报告当前状态
        assert "LLM_CHEAP_API_KEY" in result["applied"]
        assert settings.LLM_CHEAP_API_KEY == original
    finally:
        settings.LLM_CHEAP_API_KEY = original


def test_update_sensitive_field_none_keeps_original():
    rc = get_runtime_config()
    from app.config import settings
    original = settings.LLM_EXPERT_API_KEY
    try:
        result = rc.update({"LLM_EXPERT_API_KEY": None}, actor="test")
        assert settings.LLM_EXPERT_API_KEY == original
    finally:
        settings.LLM_EXPERT_API_KEY = original


def test_update_sensitive_field_with_value_updates():
    rc = get_runtime_config()
    from app.config import settings
    original = settings.LLM_CHEAP_API_KEY
    try:
        result = rc.update({"LLM_CHEAP_API_KEY": "sk-newkey12345"}, actor="test")
        assert settings.LLM_CHEAP_API_KEY == "sk-newkey12345"
        # 报告里只返回 masked 状态
        assert "sk-newkey12345" not in str(result["applied"])
        assert "configured" in result["applied"]["LLM_CHEAP_API_KEY"]
    finally:
        settings.LLM_CHEAP_API_KEY = original


def test_update_unknown_field_skipped():
    rc = get_runtime_config()
    result = rc.update({"UNKNOWN_FIELD": "x"}, actor="test")
    assert "UNKNOWN_FIELD" in result["skipped"]


def test_update_invalid_type_skipped():
    rc = get_runtime_config()
    result = rc.update({"LLM_BUDGET_PER_TASK_USD": "not-a-number"}, actor="test")
    assert any("LLM_BUDGET_PER_TASK_USD" in s for s in result["skipped"])


def test_snapshot_masks_sensitive_fields():
    rc = get_runtime_config()
    snap = rc.snapshot()
    # 所有 API key 字段都应该是 masked
    for lane in ("cheap", "expert", "fallback"):
        for k, v in snap[lane].items():
            if "API_KEY" in k:
                assert "configured" in str(v) or v == "(not configured)"
                # 不含明文
                assert "sk-" not in str(v) or "sk-" == str(v)[:3] and "****" in str(v)


def test_audit_log_records_changes():
    rc = get_runtime_config()
    from app.config import settings
    original = settings.LLM_BUDGET_DAILY_USD
    try:
        rc.update({"LLM_BUDGET_DAILY_USD": 2.0}, actor="test_user")
        log = rc.get_audit_log()
        assert len(log) > 0
        entry = log[0]
        assert entry["field"] == "LLM_BUDGET_DAILY_USD"
        assert entry["actor"] == "test_user"
        assert entry["new"] == 2.0
    finally:
        settings.LLM_BUDGET_DAILY_USD = original


def test_audit_log_masks_key_values():
    rc = get_runtime_config()
    from app.config import settings
    original = settings.LLM_CHEAP_API_KEY
    try:
        rc.update({"LLM_CHEAP_API_KEY": "sk-supersecret987"}, actor="test")
        log = rc.get_audit_log()
        entry = log[0]
        # 审计日志里不能有明文 key
        assert "sk-supersecret987" not in str(entry)
        assert "configured" in str(entry["new"])
    finally:
        settings.LLM_CHEAP_API_KEY = original


# ---------- persistence ----------


def test_save_and_load_roundtrip():
    rc = get_runtime_config()
    from app.config import settings
    original = settings.LLM_BUDGET_PER_TASK_USD
    try:
        rc.save({"LLM_BUDGET_PER_TASK_USD": 0.20})
        # 重新加载
        rc.load()
        assert settings.LLM_BUDGET_PER_TASK_USD == 0.20
    finally:
        settings.LLM_BUDGET_PER_TASK_USD = original


def test_reset_clears_config():
    rc = get_runtime_config()
    rc.save({"LLM_BUDGET_PER_TASK_USD": 0.20})
    rc.reset()
    from app.core.runtime_config import _config_path
    assert not _config_path().is_file()


# ---------- API tests ----------


def test_api_get_llm_settings(client):
    r = client.get("/api/settings/llm")
    assert r.status_code == 200
    data = r.json()
    for lane in ("router", "global", "cheap", "expert", "fallback"):
        assert lane in data


def test_api_get_llm_settings_masks_keys(client):
    r = client.get("/api/settings/llm")
    data = r.json()
    # 没有任何明文 key
    flat = str(data)
    assert "sk-" not in flat or flat.count("sk-") == 0
    # API key 字段都是 masked
    for lane in ("cheap", "expert", "fallback"):
        for k, v in data[lane].items():
            if "API_KEY" in k:
                assert "configured" in str(v) or v == "(not configured)"


def test_api_put_updates_field(client):
    r = client.put("/api/settings/llm", json={"LLM_BUDGET_PER_TASK_USD": 0.12})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "LLM_BUDGET_PER_TASK_USD" in data["applied"]


def test_api_put_key_empty_keeps_original(client):
    # 先设置一个 key
    client.put("/api/settings/llm", json={"LLM_CHEAP_API_KEY": "sk-orig12345"})
    # 留空提交 = 保持
    r = client.put("/api/settings/llm", json={"LLM_CHEAP_API_KEY": ""})
    assert r.status_code == 200
    # GET 验证仍是 configured
    g = client.get("/api/settings/llm").json()
    assert "configured" in g["cheap"]["LLM_CHEAP_API_KEY"]


def test_api_put_key_not_in_response_plaintext(client):
    client.put("/api/settings/llm", json={"LLM_CHEAP_API_KEY": "sk-verysecret12345"})
    r = client.get("/api/settings/llm")
    flat = str(r.json())
    assert "sk-verysecret12345" not in flat


def test_api_disable_router_requires_confirmation(client):
    r = client.put("/api/settings/llm", json={"LLM_ROUTER_ENABLED": False})
    assert r.status_code == 400
    assert "危险" in r.json()["detail"] or "dangerous" in r.json()["detail"].lower()
    # 加确认头后成功
    r2 = client.put(
        "/api/settings/llm",
        json={"LLM_ROUTER_ENABLED": False},
        headers={"X-Confirm-Dangerous": "yes"},
    )
    assert r2.status_code == 200


def test_api_get_audit(client):
    client.put("/api/settings/llm", json={"LLM_BUDGET_PER_TASK_USD": 0.08})
    r = client.get("/api/settings/audit")
    assert r.status_code == 200
    entries = r.json()["entries"]
    assert len(entries) > 0


def test_api_reset_requires_confirmation(client):
    r = client.post("/api/settings/reset")
    assert r.status_code == 400
    r2 = client.post("/api/settings/reset", headers={"X-Confirm-Dangerous": "yes"})
    assert r2.status_code == 200


def test_api_fields_endpoint(client):
    r = client.get("/api/settings/fields")
    assert r.status_code == 200
    fields = r.json()["fields"]
    assert len(fields) > 10
    # 检查敏感字段标记
    sensitive = [f for f in fields if f["sensitive"]]
    assert all("API_KEY" in f["key"] for f in sensitive)


def test_api_put_only_reports_changed_fields(client):
    """只传一个字段，applied 里只应该有这一个。"""
    r = client.put("/api/settings/llm", json={"LLM_BUDGET_PER_TASK_USD": 0.07})
    data = r.json()
    assert list(data["applied"].keys()) == ["LLM_BUDGET_PER_TASK_USD"]
