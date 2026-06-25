"""
Tests for CTF API endpoints.
"""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Force mock mode
os.environ["LLM_ENABLED"] = "false"
os.environ["APP_ENV"] = "dev"
os.environ["CTF_DEMO_DIR"] = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "examples", "ctf_demo")
)

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    data = r.json()
    assert "烛龙" in data["app"]
    assert data["version"] == "5.0.0-zhulongx"


def test_version(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    data = r.json()
    assert "烛龙" in data["app"]
    assert data["edition"].startswith("烛龙·玄枢")


def test_list_demos(client):
    r = client.get("/api/ctf/demos")
    assert r.status_code == 200
    data = r.json()
    demos = data["demos"]
    assert isinstance(demos, list)
    assert len(demos) >= 4
    ids = [d["id"] for d in demos]
    assert "crypto_xor" in ids
    assert "misc_exif" in ids
    # Should include LLM mode info
    assert "llm" in data


def test_create_task(client):
    r = client.post(
        "/api/ctf/tasks",
        json={
            "title": "API test task",
            "description": "test",
            "category": "crypto",
            "authorized": True,
            "allow_network": False,
            "max_rounds": 3,
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert "task_id" in data
    assert data["state"] == "INIT"


def test_list_tasks(client):
    # first create one
    client.post("/api/ctf/tasks", json={"title": "x", "description": ""})
    r = client.get("/api/ctf/tasks")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_get_unknown_task_404(client):
    r = client.get("/api/ctf/tasks/nonexistent_task")
    assert r.status_code == 404


def test_run_demo_crypto_xor(client):
    # Use sync=true to make this test deterministic
    r = client.post("/api/ctf/demos/crypto_xor/run?max_rounds=8&sync=true")
    assert r.status_code == 200
    data = r.json()
    tid = data["task_id"]
    # Poll for completion (sync should already be done)
    import time
    for _ in range(30):
        r = client.get(f"/api/ctf/tasks/{tid}")
        state = r.json()["state"]
        if state in ("DONE", "FAILED", "HUMAN_REQUIRED"):
            break
        time.sleep(0.3)
    assert state == "DONE", f"state={state}"
    assert r.json()["best_flag"] == "flag{xor_crypto_is_simple_but_classic}"
    # Match via expected_flag
    assert data.get("expected_flag") == "flag{xor_crypto_is_simple_but_classic}"
    assert r.json()["best_flag"] == data["expected_flag"]


def test_benchmark(client):
    # ensure at least one task exists (sync)
    client.post("/api/ctf/demos/crypto_xor/run?max_rounds=4&sync=true")
    r = client.get("/api/ctf/benchmark")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= 1
    assert "success_rate" in data
    assert "category_breakdown" in data


def test_solve_manual_mode(client):
    r = client.post("/api/ctf/tasks", json={"title": "m", "description": ""})
    tid = r.json()["task_id"]
    r = client.post(f"/api/ctf/tasks/{tid}/solve", json={"mode": "manual", "max_rounds": 1})
    assert r.status_code == 200
    assert r.json()["state"] == "MANUAL"
