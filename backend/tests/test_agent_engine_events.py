from app.agent_engine.events import AppendOnlyEventStore, EventType


def test_event_sequence_reconnect_and_persistence(tmp_path):
    path = tmp_path / "events.jsonl"
    store = AppendOnlyEventStore(path)
    first = store.append("run_1", EventType.RUN_CREATED, actor="test", payload={"value": 1})
    second = store.append("run_1", EventType.RUN_STARTED, actor="test", parent_event_id=first.event_id)
    third = store.append("run_1", EventType.STATE_UPDATED, actor="test", payload={"value": 3})

    assert [event.sequence for event in store.read("run_1")] == [1, 2, 3]
    assert [event.event_id for event in store.read("run_1", after_sequence=1)] == [second.event_id, third.event_id]

    reloaded = AppendOnlyEventStore(path)
    assert [event.sequence for event in reloaded.read("run_1")] == [1, 2, 3]
    fourth = reloaded.append("run_1", EventType.STATE_UPDATED, actor="test")
    assert fourth.sequence == 4


def test_event_redacts_secrets_before_storage(tmp_path):
    path = tmp_path / "events.jsonl"
    store = AppendOnlyEventStore(path)
    event = store.append(
        "run_secret",
        EventType.MODEL_REQUESTED,
        actor="test",
        payload={
            "api_key": "never-write-this-value",
            "header": "Bearer top-secret-token",
            "nested": {"password": "also-secret"},
            "text": "provider key sk-abcdefghijk123456",
        },
    )

    serialized = path.read_text(encoding="utf-8")
    assert "never-write-this-value" not in serialized
    assert "top-secret-token" not in serialized
    assert "also-secret" not in serialized
    assert "sk-abcdefghijk123456" not in serialized
    assert event.redaction_metadata["redacted_paths"]


def test_terminal_event_is_appended_once():
    store = AppendOnlyEventStore()
    store.append("run_terminal", EventType.RUN_CREATED, actor="test")
    succeeded = store.append("run_terminal", EventType.RUN_SUCCEEDED, actor="test")
    duplicate = store.append("run_terminal", EventType.RUN_FAILED, actor="test")
    late_tool = store.append("run_terminal", EventType.TOOL_FAILED, actor="test")

    assert duplicate.event_id == succeeded.event_id
    assert late_tool.event_id == succeeded.event_id
    terminal = [event for event in store.read("run_terminal") if event.type.startswith("run.") and event.type not in {"run.created", "run.started"}]
    assert len(terminal) == 1
    assert store.read("run_terminal")[-1].event_id == succeeded.event_id


def test_token_usage_metrics_are_not_mistaken_for_credentials():
    store = AppendOnlyEventStore()

    event = store.append(
        "run_usage",
        EventType.MODEL_RESPONDED,
        actor="provider",
        payload={"usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15}},
    )

    assert event.payload["usage"]["total_tokens"] == 15
    assert event.redaction_metadata["redacted_paths"] == []
