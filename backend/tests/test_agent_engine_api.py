import time

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_v2_run_api_exposes_incremental_canonical_events():
    created = client.post("/api/agent/runs", json={
        "task_id": "api_v2_test",
        "title": "API v2 test",
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


def test_v2_run_api_rejects_unknown_scenario():
    response = client.post("/api/agent/runs", json={
        "task_id": "bad_scenario",
        "title": "bad",
        "objective": "reject unknown scenario",
        "scenario": "not_registered",
    })
    assert response.status_code == 400
