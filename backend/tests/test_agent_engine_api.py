import time
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import _cleanup_ghost_tasks, app
from app.agent_engine.manager import run_manager
from app.database import SessionLocal
from app.models.ctf import CtfTask


client = TestClient(app)


def test_v3_run_api_exposes_incremental_canonical_events():
    created = client.post("/api/agent/runs", json={
        "task_id": "api_v3_test",
        "title": "API v3 test",
        "objective": "Request a deterministic no-provider run without network.",
        "scenario": "ctf",
        "authorized": False,
        "allow_process": False,
        "max_seconds": 5,
        "max_model_requests": 5,
        "max_tool_calls": 5,
    })
    assert created.status_code == 200
    body = created.json()
    run_id = body["run_id"]
    assert isinstance(body["release_ready"], bool)
    assert body["release_blocker"] == (
        "" if body["release_ready"] else "container runtime or preloaded sandbox image unavailable"
    )

    started = client.post(f"/api/agent/runs/{run_id}/start")
    assert started.status_code == 200
    deadline = time.monotonic() + 3
    state = {}
    while time.monotonic() < deadline:
        state = client.get(f"/api/agent/runs/{run_id}").json()
        if not state["is_running"]:
            break
        time.sleep(0.02)
    assert state["status"] == "human_required"

    first_page = client.get(f"/api/agent/runs/{run_id}/events?after_sequence=0").json()
    sequences = [event["sequence"] for event in first_page["events"]]
    assert sequences == list(range(1, len(sequences) + 1))
    assert first_page["events"][-1]["type"] == "human.requested"
    empty_page = client.get(
        f"/api/agent/runs/{run_id}/events?after_sequence={first_page['last_sequence']}"
    ).json()
    assert empty_page["events"] == []

    projection = client.get(f"/api/agent/runs/{run_id}/projection").json()
    assert projection["state"] == "human_required"
    assert projection["after_sequence"] == first_page["last_sequence"]


def test_v3_run_api_rejects_unknown_scenario():
    response = client.post("/api/agent/runs", json={
        "task_id": "bad_scenario",
        "title": "bad",
        "objective": "reject unknown scenario",
        "scenario": "not_registered",
    })
    assert response.status_code == 400


def test_v3_api_exposes_workflow_projection_audit_and_human_resume():
    created = client.post("/api/agent/runs", json={
        "task_id": "api_v3_contract",
        "title": "API v3",
        "objective": "exercise canonical projection",
        "scenario": "ctf",
        "provider": "mock",
        "model": "per-run-model",
        "gateway_profile": "default",
        "temperature": 0.1,
        "max_tokens": 1234,
        "max_seconds": 5,
        "max_model_requests": 5,
        "max_tool_calls": 5,
    })
    assert created.status_code == 200
    run_id = created.json()["run_id"]
    session = run_manager.get(run_id)
    assert session is not None
    assert session.request.model_config.model == "per-run-model"
    assert session.request.model_config.max_tokens == 1234

    workflow = client.get(f"/api/agent/runs/{run_id}/workflow")
    assert workflow.status_code == 200
    assert workflow.json()["workflow"]["workflow_id"] == "ctf_workflow_v1"
    assert len(workflow.json()["plan"]["nodes"]) >= 5

    assert client.post(f"/api/agent/runs/{run_id}/start").status_code == 200
    deadline = time.monotonic() + 3
    while run_manager.is_running(run_id) and time.monotonic() < deadline:
        time.sleep(0.02)

    projection = client.get(f"/api/agent/runs/{run_id}/projection").json()
    assert projection["plan"]["plan_id"].startswith("plan_")
    assert projection["plan_history"][0]["reason"]
    assert projection["human_handoff"]["questions"]
    audit = client.get(f"/api/agent/runs/{run_id}/audit").json()
    assert audit["schema_version"] == 1
    assert all(event["schema_version"] == 1 for event in audit["events"])

    answered = client.post(f"/api/agent/runs/{run_id}/human-answer", json={
        "public_response": {"strategy": "narrow scope"},
        "secure_input_refs": [],
        "resume": False,
    })
    assert answered.status_code == 200
    assert answered.json()["status"] == "running"


def test_formal_api_has_no_legacy_runtime_imports():
    root = Path(__file__).resolve().parents[1] / "app"
    formal_files = list((root / "api").glob("*.py")) + [
        root / "main.py",
        root / "agent_engine" / "service.py",
        root / "scenarios" / "ctf" / "service.py",
    ]
    forbidden = (
        "app.core.ctf_agent_orchestrator",
        "app.core.agent_runtime",
        "app.core.cc_bridge_runtime",
    )
    for path in formal_files:
        source = path.read_text(encoding="utf-8")
        assert all(item not in source for item in forbidden), path


def test_restart_cleanup_preserves_v3_and_compatibility_engine_tasks():
    with SessionLocal() as db:
        db.add_all([
            CtfTask(task_id="active_v3", title="v3", engine="v3", is_running=True, state="RUNNING"),
            CtfTask(task_id="active_v2", title="v2", engine="v2", is_running=True, state="RUNNING"),
            CtfTask(task_id="legacy", title="legacy", engine="legacy", is_running=True, state="RUNNING"),
        ])
        db.commit()

    _cleanup_ghost_tasks()

    with SessionLocal() as db:
        active_v3 = db.get(CtfTask, "active_v3")
        active_v2 = db.get(CtfTask, "active_v2")
        legacy = db.get(CtfTask, "legacy")
        assert active_v3 is not None and active_v3.is_running is True
        assert active_v2 is not None and active_v2.is_running is True
        assert legacy is not None and legacy.is_running is False
        assert legacy.state == "HUMAN_REQUIRED"
