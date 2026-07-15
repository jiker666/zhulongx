import os
import subprocess
import threading
import time

import pytest

from app.agent_engine.budget import BudgetLimits
from app.agent_engine.checkpoint import CheckpointStore
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.providers.base import AssistantTurn, ProviderToolCall
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.state import RunRequest, RunStatus
from app.agent_engine.validation.base import PredicateValidator


EXPECTED = "flag{walking_skeleton}"


def _request(workspace, *, allow_process=True):
    return RunRequest(
        task_id="task_session",
        title="Walking Skeleton",
        objective="Read the input, execute a reproducer, and submit validated evidence.",
        workspace=str(workspace),
        authorization={"authorized": True, "allow_process": allow_process},
    )


def _call(index, name, arguments):
    return AssistantTurn(
        text=f"calling {name}",
        tool_calls=(ProviderToolCall(f"call_{index}", name, arguments),),
        usage={"total_tokens": 10},
        finish_reason="tool_calls",
        raw_response_ref=f"mock://response/{index}",
    )


def _process_running(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    status = subprocess.run(
        ["ps", "-p", str(pid), "-o", "stat="],
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    return bool(status) and not status.startswith("Z")


def _wait_for_exit(pid, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _process_running(pid):
            return True
        time.sleep(0.02)
    return not _process_running(pid)


def test_session_end_to_end_read_python_candidate_validate(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "input.txt").write_text("derive the answer with a local script", encoding="utf-8")
    provider = ScriptedProvider([
        _call(1, "read_file", {"path": "input.txt"}),
        _call(2, "run_python", {"code": f"print('{EXPECTED}')"}),
        _call(3, "submit_candidate", {"candidate": EXPECTED, "reproduction": "run generated Python"}),
    ])
    events = AppendOnlyEventStore(tmp_path / "events.jsonl")
    session = AgentSession(
        _request(workspace),
        provider=provider,
        validator=PredicateValidator(lambda value: value == EXPECTED),
        events=events,
        sandbox=LocalTestSandbox(workspace),
    )

    state = session.run()

    assert state.status == RunStatus.SUCCEEDED
    assert state.final_output["candidate"] == EXPECTED
    assert state.final_output["evidence_event_ids"]
    event_types = [event.type for event in session.event_stream()]
    assert EventType.CANDIDATE_DETECTED.value in event_types
    assert EventType.CANDIDATE_VALIDATED.value in event_types
    assert event_types[-1] == EventType.RUN_SUCCEEDED.value
    assert [event.sequence for event in session.event_stream()] == list(range(1, len(event_types) + 1))
    assert session.event_stream(after_sequence=state.last_event_sequence) == []


def test_session_recovers_after_policy_denial(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "answer.txt").write_text(EXPECTED, encoding="utf-8")
    provider = ScriptedProvider([
        _call(1, "run_shell", {"command": "echo denied"}),
        _call(2, "read_file", {"path": "answer.txt"}),
        _call(3, "submit_candidate", {"candidate": EXPECTED}),
    ])
    session = AgentSession(
        _request(workspace, allow_process=False),
        provider=provider,
        validator=PredicateValidator(lambda value: value == EXPECTED),
        sandbox=LocalTestSandbox(workspace),
    )

    state = session.run()

    assert state.status == RunStatus.SUCCEEDED
    assert EventType.POLICY_DENIED.value in [event.type for event in session.event_stream()]
    second_request = provider.requests[1]
    assert "policy.denied" in str(second_request["messages"])


def test_session_recovers_after_tool_failure(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "answer.txt").write_text(EXPECTED, encoding="utf-8")
    provider = ScriptedProvider([
        _call(1, "read_file", {"path": "missing.txt"}),
        _call(2, "read_file", {"path": "answer.txt"}),
        _call(3, "submit_candidate", {"candidate": EXPECTED}),
    ])
    session = AgentSession(
        _request(workspace, allow_process=False),
        provider=provider,
        validator=PredicateValidator(lambda value: value == EXPECTED),
        sandbox=LocalTestSandbox(workspace),
    )

    assert session.run().status == RunStatus.SUCCEEDED
    assert EventType.TOOL_FAILED.value in [event.type for event in session.event_stream()]


def test_validator_rejects_decoy_before_accepting_evidenced_answer(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "answer.txt").write_text(EXPECTED, encoding="utf-8")
    provider = ScriptedProvider([
        _call(1, "read_file", {"path": "answer.txt"}),
        _call(2, "submit_candidate", {"candidate": "flag{decoy}"}),
        _call(3, "submit_candidate", {"candidate": EXPECTED}),
    ])
    session = AgentSession(
        _request(workspace, allow_process=False),
        provider=provider,
        validator=PredicateValidator(lambda value: value == EXPECTED),
        sandbox=LocalTestSandbox(workspace),
    )

    state = session.run()
    types = [event.type for event in session.event_stream()]

    assert state.status == RunStatus.SUCCEEDED
    assert EventType.CANDIDATE_REJECTED.value in types
    assert EventType.CANDIDATE_VALIDATED.value in types
    assert state.candidate_answers[0]["status"] == "rejected"
    assert state.candidate_answers[1]["status"] == "validated"


def test_session_terminal_event_is_idempotent(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "answer.txt").write_text(EXPECTED, encoding="utf-8")
    provider = ScriptedProvider([
        _call(1, "read_file", {"path": "answer.txt"}),
        _call(2, "submit_candidate", {"candidate": EXPECTED}),
    ])
    session = AgentSession(
        _request(workspace, allow_process=False),
        provider=provider,
        validator=PredicateValidator(lambda value: value == EXPECTED),
        sandbox=LocalTestSandbox(workspace),
    )

    first = session.run()
    count = len(session.event_stream())
    second = session.run()

    assert first is second
    assert len(session.event_stream()) == count


def test_checkpoint_resume_does_not_repeat_completed_tool(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "answer.txt").write_text(EXPECTED, encoding="utf-8")
    events = AppendOnlyEventStore(tmp_path / "resume-events.jsonl")
    checkpoints = CheckpointStore(tmp_path / "checkpoints")

    def crash_after_checkpoint(messages, tools):
        raise SystemExit("simulated process crash")

    first_provider = ScriptedProvider([
        _call(1, "read_file", {"path": "answer.txt"}),
        crash_after_checkpoint,
    ])
    first_session = AgentSession(
        _request(workspace, allow_process=False),
        provider=first_provider,
        validator=PredicateValidator(lambda value: value == EXPECTED),
        events=events,
        sandbox=LocalTestSandbox(workspace),
        checkpoint_store=checkpoints,
        run_id="run_resume_test",
    )
    with pytest.raises(SystemExit, match="simulated process crash"):
        first_session.run()
    assert checkpoints.exists("run_resume_test")
    read_started_before = [
        event for event in events.read("run_resume_test")
        if event.type == EventType.TOOL_STARTED.value and event.payload.get("name") == "read_file"
    ]
    assert len(read_started_before) == 1

    resumed_provider = ScriptedProvider([
        _call(1, "read_file", {"path": "answer.txt"}),
        _call(2, "submit_candidate", {"candidate": EXPECTED}),
    ])
    resumed = AgentSession.resume(
        _request(workspace, allow_process=False),
        run_id="run_resume_test",
        provider=resumed_provider,
        validator=PredicateValidator(lambda value: value == EXPECTED),
        events=events,
        checkpoint_store=checkpoints,
        sandbox=LocalTestSandbox(workspace),
    )

    state = resumed.run()
    read_started_after = [
        event for event in events.read("run_resume_test")
        if event.type == EventType.TOOL_STARTED.value and event.payload.get("name") == "read_file"
    ]

    assert state.status == RunStatus.SUCCEEDED
    assert len(read_started_after) == 1
    assert state.budget_usage["tool_calls"] == 2


def test_session_abort_kills_active_process_tree(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    provider = ScriptedProvider([
        _call(1, "run_python", {"code": """
import pathlib
import subprocess
import time
child = subprocess.Popen(['python3', '-c', 'import time; time.sleep(60)'])
pathlib.Path('session_child.pid').write_text(str(child.pid))
time.sleep(60)
""", "timeout_seconds": 30}),
    ])
    session = AgentSession(
        _request(workspace),
        provider=provider,
        validator=PredicateValidator(lambda value: False),
        sandbox=LocalTestSandbox(workspace),
    )
    holder = {}
    thread = threading.Thread(target=lambda: holder.setdefault("state", session.run()), daemon=True)
    thread.start()
    pid_file = workspace / "session_child.pid"
    deadline = time.monotonic() + 3
    while not pid_file.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert pid_file.exists()
    child_pid = int(pid_file.read_text())

    started = time.monotonic()
    session.abort("user stop")
    thread.join(timeout=3)

    assert not thread.is_alive()
    assert time.monotonic() - started < 3
    assert holder["state"].status == RunStatus.CANCELLED
    assert _wait_for_exit(child_pid)
    assert [event.type for event in session.event_stream()][-1] == EventType.RUN_CANCELLED.value


def test_session_deadline_kills_active_process_tree(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    request = RunRequest(
        task_id="task_timeout",
        title="timeout",
        objective="time out an active process",
        workspace=str(workspace),
        authorization={"authorized": True, "allow_process": True},
        budgets=BudgetLimits(max_seconds=0.7, max_model_requests=5, max_tool_calls=5),
    )
    provider = ScriptedProvider([
        _call(1, "run_python", {"code": """
import pathlib
import subprocess
import time
child = subprocess.Popen(['python3', '-c', 'import time; time.sleep(60)'])
pathlib.Path('timeout_child.pid').write_text(str(child.pid))
time.sleep(60)
""", "timeout_seconds": 30}),
    ])
    session = AgentSession(
        request,
        provider=provider,
        validator=PredicateValidator(lambda value: False),
        sandbox=LocalTestSandbox(workspace),
    )

    started = time.monotonic()
    state = session.run()
    child_pid = int((workspace / "timeout_child.pid").read_text())

    assert state.status == RunStatus.TIMED_OUT
    assert time.monotonic() - started < 3
    assert _wait_for_exit(child_pid)
    assert [event.type for event in session.event_stream()][-1] == EventType.RUN_TIMED_OUT.value


def test_ask_human_transitions_to_human_required(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    provider = ScriptedProvider([
        _call(1, "ask_human", {"question": "Provide the missing archive password"}),
    ])
    session = AgentSession(
        _request(workspace, allow_process=False),
        provider=provider,
        validator=PredicateValidator(lambda value: False),
        sandbox=LocalTestSandbox(workspace),
    )

    state = session.run()

    assert state.status == RunStatus.HUMAN_REQUIRED
    assert "archive password" in state.error
    assert [event.type for event in session.event_stream()][-1] == EventType.HUMAN_REQUESTED.value
