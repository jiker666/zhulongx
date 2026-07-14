import os
import time
import pytest

pytestmark = [pytest.mark.worker, pytest.mark.e2e]

def _worker_ready():
    from app.core.worker_client import WorkerClient
    try:
        client = WorkerClient("http://127.0.0.1:8090")
        return client.sync(client.health()).get("status") == "ok"
    except Exception: return False

@pytest.mark.skipif(not _worker_ready(), reason="Docker worker-base is not reachable on localhost:8090")
def test_gateway_broker_worker_pty(monkeypatch):
    monkeypatch.setattr("app.config.settings.WORKER_BASE_URL", "http://127.0.0.1:8090")
    from app.core.competition_runtime import CompetitionController, ActionCandidate, CompetitionProfile
    controller = CompetitionController(); state = controller.create_challenge("e2e", "pty", "PTY integration")
    profile = CompetitionProfile(allow_interactive_terminal=True)
    create = ActionCandidate(tool_name="terminal.create", tool_arguments={"command": "/bin/sh"}, purpose="create PTY")
    made = controller.broker.execute(state, create, profile); assert made.success
    sid = made.structured_output["session_id"]; state.decision_history.append(create)
    send = ActionCandidate(tool_name="terminal.send", tool_arguments={"session_id": sid, "data": "export SESSION_MARK=ACTIVE; echo PTY_READY\n"}, purpose="send")
    assert controller.broker.execute(state, send, profile).success; state.decision_history.append(send)
    expect = ActionCandidate(tool_name="terminal.expect", tool_arguments={"session_id": sid, "pattern": "PTY_READY", "timeout": 3}, purpose="expect")
    matched = controller.broker.execute(state, expect, profile); assert matched.success and matched.structured_output["matched"]
    close = ActionCandidate(tool_name="terminal.close", tool_arguments={"session_id": sid}, purpose="close")
    assert controller.broker.execute(state, close, profile).success

@pytest.mark.skipif(not _worker_ready(), reason="Docker worker-base is not reachable on localhost:8090")
def test_worker_command_real_output(monkeypatch):
    monkeypatch.setattr("app.config.settings.WORKER_BASE_URL", "http://127.0.0.1:8090")
    from app.core.competition_runtime import CompetitionController, ActionCandidate, CompetitionProfile
    controller = CompetitionController(); state = controller.create_challenge("e2e", "command", "command integration")
    run = ActionCandidate(tool_name="worker.command.run", tool_arguments={"command": "printf", "arguments": ["COMMAND_READY"]}, purpose="run")
    started = controller.broker.execute(state, run, CompetitionProfile()); assert started.success
    command_id = started.structured_output["command_id"]
    time.sleep(.2)
    status = ActionCandidate(tool_name="worker.command.status", tool_arguments={"command_id": command_id}, purpose="status")
    done = controller.broker.execute(state, status, CompetitionProfile()); assert done.success
    assert done.structured_output["status"] == "COMPLETED" and done.structured_output["stdout"] == "COMMAND_READY"

@pytest.mark.skipif(not _worker_ready(), reason="Docker worker-base is not reachable on localhost:8090")
def test_task_cancel_reaps_command_tree_and_pty(monkeypatch):
    """Real worker check: a task cancellation kills a shell and its children."""
    monkeypatch.setattr("app.config.settings.WORKER_BASE_URL", "http://127.0.0.1:8090")
    from app.core.worker_client import WorkerClient
    client = WorkerClient("http://127.0.0.1:8090")
    task_id = "cancel-tree-e2e"
    started = client.sync(client.run_command({
        "competition_id": "e2e", "challenge_id": "lifecycle", "task_id": task_id,
        "command": "sleep 30 & sleep 30 & wait", "arguments": [],
        "cwd": f"/workspace/tasks/{task_id}", "environment": {}, "timeout_seconds": 60,
        "max_output_bytes": 2000, "shell": True,
    }))
    pty = client.sync(client.create_pty_session(task_id, "lifecycle", f"/workspace/tasks/{task_id}", "/bin/sh", 60, "e2e"))
    time.sleep(.15)
    result = client.sync(client.cancel_task(task_id))
    assert result["status"] == "CANCEL_REQUESTED"
    time.sleep(.15)
    command = client.sync(client.get_command(task_id, started["command_id"]))
    assert command["status"] == "CANCELLED"
    assert client.sync(client.list_task_sessions(task_id))["sessions"] == []
    # Cancellation is safe to retry, and ownership prevents accidental reuse.
    assert client.sync(client.cancel_task(task_id))["status"] == "CANCEL_REQUESTED"
    with pytest.raises(Exception):
        client.sync(client.read_pty_session(task_id, pty["session_id"]))
