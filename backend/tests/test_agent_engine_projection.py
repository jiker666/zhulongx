from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.projections import LegacyTaskProjection


def test_legacy_projection_consumes_events_once_and_resumes_by_sequence():
    store = AppendOnlyEventStore()
    run_id = "run_projection"
    store.append(run_id, EventType.RUN_CREATED, actor="test")
    store.append(run_id, EventType.RUN_STARTED, actor="test")
    tool = store.append(
        run_id,
        EventType.TOOL_FINISHED,
        actor="tool_executor",
        payload={
            "tool_call_id": "call_1",
            "name": "run_shell",
            "success": True,
            "output": "result",
            "duration_ms": 10,
        },
    )
    projection = LegacyTaskProjection(run_id)

    first_offset = projection.consume(store.read(run_id))
    projection.consume(store.read(run_id))

    assert first_offset == tool.sequence
    assert len(projection.shell_history) == 1
    assert len(projection.events) == 3

    detected = store.append(
        run_id,
        EventType.CANDIDATE_DETECTED,
        actor="validator",
        payload={"candidate": "flag{projected}", "evidence_event_ids": [tool.event_id]},
    )
    store.append(
        run_id,
        EventType.CANDIDATE_VALIDATED,
        actor="validator",
        payload={"candidate": "flag{projected}", "reason": "accepted"},
    )
    terminal = store.append(run_id, EventType.RUN_SUCCEEDED, actor="session")

    projection.consume(store.read(run_id, after_sequence=first_offset))

    assert projection.after_sequence == terminal.sequence
    assert projection.best_flag == "flag{projected}"
    assert projection.candidate_flags == [{
        "flag": "flag{projected}",
        "source": "agent_session",
        "confidence": 1.0,
        "status": "validated",
        "evidence_event_ids": [tool.event_id],
        "validation": "accepted",
    }]
    assert projection.state == "succeeded"
