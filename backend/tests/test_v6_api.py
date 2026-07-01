"""Tests for v6 API endpoints (blackboard / cost / router)."""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

os.environ["LLM_ENABLED"] = "false"
os.environ["APP_ENV"] = "dev"

from app.main import app
from app.core.blackboard import get_blackboard
from app.core.cost_accounting import reset_cost_accounting_for_test


@pytest.fixture
def client():
    return TestClient(app)


def test_router_status_endpoint(client):
    r = client.get("/api/ctf/llm/router/status")
    assert r.status_code == 200
    data = r.json()
    assert "router_enabled" in data
    assert "cheap" in data
    assert "expert" in data
    assert "fallback" in data
    # 不泄露 key
    assert "api_key" not in str(data).lower() or "api_key_configured" in str(data)
    # cheap 子对象只返回 host，不返回完整 base_url
    assert "base_url_host" in data["cheap"]
    assert "api_key_configured" in data["cheap"]


def test_blackboard_endpoint_empty(client):
    bb = get_blackboard()
    bb.reset_task("api_t1")
    r = client.get("/api/ctf/tasks/api_t1/blackboard")
    assert r.status_code == 200
    data = r.json()
    assert data["task_id"] == "api_t1"
    assert data["facts"] == []
    assert data["intents"] == []
    assert data["hints"] == []
    assert data["fact_count"] == 0


def test_add_hint_endpoint(client):
    bb = get_blackboard()
    bb.reset_task("api_t2")
    r = client.post(
        "/api/ctf/tasks/api_t2/hints",
        json={"content": "try xor 0x42", "source": "human"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["content"] == "try xor 0x42"
    assert data["source"] == "human"
    assert data["consumed"] is False
    # verify persisted
    snap = client.get("/api/ctf/tasks/api_t2/blackboard").json()
    assert len(snap["hints"]) == 1


def test_update_intent_endpoint(client):
    bb = get_blackboard()
    bb.reset_task("api_t3")
    i = bb.add_intent(task_id="api_t3", title="test intent")
    r = client.patch(
        f"/api/ctf/tasks/api_t3/intents/{i.intent_id}",
        json={"status": "in_progress"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "in_progress"


def test_update_intent_not_found(client):
    r = client.patch(
        "/api/ctf/tasks/api_t4/intents/intent_nonexistent",
        json={"status": "completed"},
    )
    assert r.status_code == 404


def test_cost_endpoint_empty(client):
    reset_cost_accounting_for_test()
    r = client.get("/api/ctf/tasks/api_t5/cost")
    assert r.status_code == 200
    data = r.json()
    assert data["task_id"] == "api_t5"
    assert data["total_calls"] == 0
    assert data["total_cost_usd"] == 0.0
    assert "budget_per_task_usd" in data


def test_cost_records_endpoint(client):
    reset_cost_accounting_for_test()
    from app.core.cost_accounting import get_cost_accounting
    acc = get_cost_accounting()
    acc.record(
        task_id="api_t6", step="classify",
        provider="deepseek", model="deepseek-v4-flash",
        input_text="x", output_text="{}",
        success=True, route_reason="cheap_default",
    )
    r = client.get("/api/ctf/tasks/api_t6/cost/records")
    assert r.status_code == 200
    data = r.json()
    assert data["task_id"] == "api_t6"
    assert len(data["records"]) == 1
    rec = data["records"][0]
    assert rec["provider"] == "deepseek"
    assert rec["step"] == "classify"
    # 不泄露 key
    assert "replace_me" not in str(data) or "api_key" not in str(data)
