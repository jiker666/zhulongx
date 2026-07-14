import json
import uuid

import pytest

from app.agent_engine.bootstrap import restore_persisted_sessions
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.manager import run_manager
from app.agent_engine.providers.base import AssistantTurn, ProviderToolCall
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.run_store import RunMetadataStore
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.state import InputReference, NetworkPolicy, RunRequest, RunStatus
from app.agent_engine.validation.base import PredicateValidator


def test_run_request_metadata_round_trip_is_secret_free(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "input.txt"
    source.write_text("evidence", encoding="utf-8")
    request = RunRequest(
        task_id="metadata_roundtrip",
        title="metadata",
        objective="Inspect evidence; accidental key sk-do-not-persist-123456.",
        workspace=str(workspace),
        inputs=(InputReference("input.txt", str(source)),),
        authorization={"authorized": True, "allow_process": False, "api_token": "top-secret"},
        network_policy=NetworkPolicy(mode="allowlist", allowed_hosts=("example.test",), allowed_ports=(443,)),
    )
    store = RunMetadataStore.for_workspace(workspace)

    store.save("run_metadata_roundtrip", request, scenario_config={"api_key": "also-secret"})
    raw = store.path.read_text(encoding="utf-8")
    restored = store.load()

    assert "top-secret" not in raw
    assert "also-secret" not in raw
    assert "sk-do-not-persist" not in raw
    assert restored.request.authorization == {"authorized": True, "allow_process": False}
    assert restored.request.inputs == request.inputs
    assert restored.request.network_policy == request.network_policy


def test_startup_reconstructs_terminal_session_from_metadata_and_checkpoint(tmp_path):
    workspace = tmp_path / "persisted" / "workspace"
    workspace.mkdir(parents=True)
    run_id = f"run_restore_{uuid.uuid4().hex}"
    request = RunRequest(
        task_id="restore_task",
        title="restore",
        objective="Pause through the canonical session.",
        workspace=str(workspace),
    )
    session = AgentSession(
        request,
        run_id=run_id,
        provider=ScriptedProvider([
            AssistantTurn(
                text="Need input.",
                tool_calls=(ProviderToolCall("human", "ask_human", {"question": "Provide evidence"}),),
            ),
        ]),
        validator=PredicateValidator(lambda _value: False),
        events=AppendOnlyEventStore(workspace / ".agent_state" / "events.jsonl"),
        sandbox=LocalTestSandbox(workspace),
    )
    assert session.run().status == RunStatus.HUMAN_REQUIRED
    RunMetadataStore.for_workspace(workspace).save(
        run_id,
        request,
        scenario_config={"flag_pattern": r"flag\{[^}]+\}", "evaluator_ref": "none"},
    )

    result = restore_persisted_sessions(tmp_path / "persisted")
    restored = run_manager.get(run_id)

    assert result["restored"] == [run_id]
    assert result["failures"] == []
    assert restored is not None
    assert restored.state.status == RunStatus.HUMAN_REQUIRED
    assert run_manager.start(run_id) is False


def test_corrupt_metadata_isolated_during_startup_restore(tmp_path):
    broken = tmp_path / "broken" / ".agent_state"
    broken.mkdir(parents=True)
    (broken / "run.json").write_text(json.dumps({"version": 99}), encoding="utf-8")

    result = restore_persisted_sessions(tmp_path)

    assert result["restored"] == []
    assert result["failures"] == [{"path": str((broken / "run.json").resolve()), "error": "ValueError"}]


def test_startup_resume_does_not_repeat_tool_completed_before_crash(tmp_path):
    workspace = tmp_path / "running" / "workspace"
    workspace.mkdir(parents=True)
    (workspace / "evidence.txt").write_text("confirmed", encoding="utf-8")
    run_id = f"run_restore_running_{uuid.uuid4().hex}"
    request = RunRequest(
        task_id="restore_running",
        title="restore running",
        objective="Read the evidence and continue after restart.",
        workspace=str(workspace),
    )
    events = AppendOnlyEventStore(workspace / ".agent_state" / "events.jsonl")

    def crash(_messages, _tools):
        raise SystemExit("simulated service loss")

    session = AgentSession(
        request,
        run_id=run_id,
        provider=ScriptedProvider([
            AssistantTurn(
                text="Read evidence.",
                tool_calls=(ProviderToolCall("read_once", "read_file", {"path": "evidence.txt"}),),
            ),
            crash,
        ]),
        validator=PredicateValidator(lambda _value: False),
        events=events,
        sandbox=LocalTestSandbox(workspace),
    )
    with pytest.raises(SystemExit, match="service loss"):
        session.run()
    RunMetadataStore.for_workspace(workspace).save(
        run_id,
        request,
        scenario_config={"flag_pattern": r"flag\{[^}]+\}", "evaluator_ref": "none"},
    )

    result = restore_persisted_sessions(tmp_path / "running")
    restored = run_manager.get(run_id)

    assert result["restored"] == [run_id]
    assert restored is not None
    assert restored.state.status == RunStatus.RUNNING
    assert run_manager.start(run_id) is True
    assert run_manager.wait(run_id, timeout=3) is True
    assert restored.state.status == RunStatus.HUMAN_REQUIRED
    completed_reads = [
        event for event in restored.event_stream()
        if event.type == EventType.TOOL_STARTED.value and event.payload.get("name") == "read_file"
    ]
    assert len(completed_reads) == 1
