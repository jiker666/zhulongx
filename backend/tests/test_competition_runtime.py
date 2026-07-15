from fastapi.testclient import TestClient

from app.agent_engine.events import EventType
from app.agent_engine.manager import run_manager
from app.agent_engine.state import RunStatus
from app.main import app


client = TestClient(app)


def _create(**overrides):
    payload = {
        "competition_id": "merge-test",
        "challenge_id": "single-runtime",
        "objective": "inspect the canonical run workspace",
        "provider": "mock",
        "model": "scripted",
    }
    payload.update(overrides)
    response = client.post("/api/competition/challenges", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_competition_facade_uses_agent_run_service_and_canonical_events():
    created = _create()
    run_id = created["run_id"]
    session = run_manager.get(run_id)
    assert session is not None
    assert session.request.authorization["competition_id"] == "merge-test"
    assert created["state"] == RunStatus.CREATED.value

    hypothesis = client.post(
        f"/api/competition/challenges/{run_id}/hypotheses",
        json={
            "statement": "the workspace inventory contains useful evidence",
            "test_strategy": "list the workspace",
            "success_signal": "a canonical tool result",
        },
    )
    assert hypothesis.status_code == 200
    assert session.state.open_hypotheses[0]["statement"].startswith("the workspace")

    executed = client.post(
        f"/api/competition/challenges/{run_id}/actions/execute",
        json={
            "action": {
                "tool_call_id": "competition-list-dir",
                "tool_name": "list_dir",
                "tool_arguments": {},
            }
        },
    )
    assert executed.status_code == 200
    assert executed.json()["success"] is True
    event_types = [event.type for event in session.event_stream()]
    assert EventType.HYPOTHESIS_PROPOSED.value in event_types
    assert event_types[-4:] == [
        EventType.TOOL_REQUESTED.value,
        EventType.POLICY_ALLOWED.value,
        EventType.TOOL_STARTED.value,
        EventType.TOOL_FINISHED.value,
    ]


def test_competition_facade_worker_action_is_default_denied():
    created = _create(challenge_id="worker-denied")
    run_id = created["run_id"]
    response = client.post(
        f"/api/competition/challenges/{run_id}/actions/execute",
        json={"action": {"tool_name": "worker.health", "tool_arguments": {}}},
    )
    assert response.status_code == 200
    assert response.json()["success"] is False
    assert response.json()["metadata"]["code"] == "policy_denied"
    session = run_manager.get(run_id)
    assert session is not None
    assert EventType.POLICY_DENIED.value in [event.type for event in session.event_stream()]


def test_competition_pause_evidence_and_cancel_share_one_state_authority():
    created = _create(challenge_id="lifecycle")
    run_id = created["run_id"]
    paused = client.post(
        f"/api/competition/challenges/{run_id}/pause",
        json={"reason": "review evidence"},
    )
    assert paused.status_code == 200
    assert paused.json()["state"] == RunStatus.HUMAN_REQUIRED.value

    evidence = client.post(
        f"/api/competition/challenges/{run_id}/evidence/human",
        json={"content": "operator-confirmed fixture observation"},
    )
    assert evidence.status_code == 200

    cancelled = client.post(f"/api/competition/challenges/{run_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == RunStatus.CANCELLED.value
    session = run_manager.get(run_id)
    assert session is not None and session.state.status == RunStatus.CANCELLED
    assert [event.type for event in session.event_stream()].count(EventType.RUN_CANCELLED.value) == 1

    rejected = client.post(
        f"/api/competition/challenges/{run_id}/evidence/human",
        json={"content": "late evidence"},
    )
    assert rejected.status_code == 409


def test_competition_created_run_can_pause_and_resume_before_start():
    created = _create(challenge_id="pre-start-pause")
    run_id = created["run_id"]
    assert client.post(
        f"/api/competition/challenges/{run_id}/pause",
        json={"reason": "review before start"},
    ).json()["state"] == RunStatus.HUMAN_REQUIRED.value
    resumed = client.post(f"/api/competition/challenges/{run_id}/resume")
    assert resumed.status_code == 200
    assert resumed.json()["started"] is True
    assert run_manager.wait(run_id, 3)


def test_competition_capabilities_are_the_v3_registry():
    response = client.get("/api/competition/capabilities")
    assert response.status_code == 200
    names = {item["name"] for item in response.json()}
    assert {"list_dir", "record_evidence", "worker.command.run", "terminal.create"} <= names
