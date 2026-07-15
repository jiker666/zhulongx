import shutil
import time
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

import pytest

from app.agent_engine.events import EventType
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.service import agent_run_service
from app.agent_engine.state import NetworkPolicy, RunRequest, RunStatus
from app.agent_engine.tools.types import ToolCall
from app.config import settings
from app.core.worker_client import WorkerClient, WorkerError
from app.scenarios import CTFScenario


pytestmark = [pytest.mark.worker, pytest.mark.e2e]
REPO_ROOT = Path(__file__).resolve().parents[2]
SHARED_ROOT = REPO_ROOT / "data" / "worker_tasks"
WORKER_URL = "http://127.0.0.1:8090"


def _worker_ready():
    try:
        client = WorkerClient(WORKER_URL)
        return client.sync(client.health()).get("status") == "ok"
    except Exception:
        return False


requires_worker = pytest.mark.skipif(
    not _worker_ready(),
    reason="Docker worker-base is not reachable on localhost:8090",
)


@contextmanager
def _session(monkeypatch, label: str, *, network_policy: NetworkPolicy | None = None):
    SHARED_ROOT.mkdir(parents=True, exist_ok=True)
    workspace = SHARED_ROOT / f"pytest_{label}_{uuid.uuid4().hex[:8]}"
    workspace.mkdir(mode=0o777)
    workspace.chmod(0o777)
    monkeypatch.setattr(settings, "WORKER_BASE_URL", WORKER_URL)
    monkeypatch.setattr(settings, "WORKER_SHARED_ROOT", str(SHARED_ROOT))
    monkeypatch.setattr(settings, "WORKER_WORKSPACE_ROOT", "/workspace/tasks")
    request = RunRequest(
        task_id=f"worker-{label}-{uuid.uuid4().hex[:8]}",
        title=f"Worker {label}",
        objective=f"verify Worker {label}",
        workspace=str(workspace),
        authorization={
            "authorized": bool(network_policy and network_policy.mode == "allowlist"),
            "allow_worker": True,
            "allow_process": True,
        },
        network_policy=network_policy or NetworkPolicy(mode="deny"),
    )
    session = agent_run_service.create_session(
        request,
        CTFScenario().validator(),
        provider=ScriptedProvider([]),
        sandbox=LocalTestSandbox(workspace),
        register=False,
    )
    try:
        yield session
    finally:
        session.abort("worker e2e cleanup")
        shutil.rmtree(workspace, ignore_errors=True)


def _worker_workspace(session) -> str:
    relative = session.workspace.relative_to(SHARED_ROOT.resolve())
    return str(PurePosixPath("/workspace/tasks").joinpath(*relative.parts))


def _invocation(session, tool_call_id: str) -> dict:
    return {
        "run_id": session.run_id,
        "session_id": session.run_id,
        "task_id": session.request.task_id,
        "tool_call_id": tool_call_id,
        "workspace": _worker_workspace(session),
        "authorization": {
            "authorized": bool(session.request.authorization.get("authorized", False)),
            "allow_process": True,
            "allow_worker": True,
            "approval_mode": "",
        },
        "scope": {
            "network_mode": session.request.network_policy.mode,
            "allowed_hosts": list(session.request.network_policy.allowed_hosts),
            "allowed_ports": list(session.request.network_policy.allowed_ports),
        },
    }


def _response(execution):
    assert execution.result.success, execution.result.error
    return execution.result.metadata["worker_response"]


@requires_worker
def test_v3_worker_command_emits_canonical_events(monkeypatch):
    with _session(monkeypatch, "command") as session:
        health = _response(session.execute_tool(ToolCall("health", "worker.health", {})))
        assert health["status"] == "ok"
        started = _response(session.execute_tool(ToolCall(
            "command-run",
            "worker.command.run",
            {"command": "printf", "arguments": ["COMMAND_READY"]},
        )))
        assert started["run_id"] == session.run_id
        assert started["tool_call_id"] == "command-run"

        deadline = time.monotonic() + 5
        status = started
        attempt = 0
        while status["status"] not in {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"}:
            assert time.monotonic() < deadline
            attempt += 1
            time.sleep(0.05)
            status = _response(session.execute_tool(ToolCall(
                f"command-status-{attempt}",
                "worker.command.status",
                {"command_id": started["command_id"]},
            )))
        assert status["status"] == "COMPLETED"
        assert status["stdout"] == "COMMAND_READY"
        event_types = [event.type for event in session.event_stream()]
        assert EventType.TOOL_STARTED.value in event_types
        assert EventType.TOOL_FINISHED.value in event_types


@requires_worker
def test_v3_worker_pty_send_expect_and_close(monkeypatch):
    with _session(monkeypatch, "pty") as session:
        created = _response(session.execute_tool(ToolCall(
            "pty-create",
            "terminal.create",
            {"command": "/bin/sh", "timeout": 10},
        )))
        session_id = created["session_id"]
        _response(session.execute_tool(ToolCall(
            "pty-send",
            "terminal.send",
            {"session_id": session_id, "data": "echo PTY_READY\n"},
        )))
        matched = _response(session.execute_tool(ToolCall(
            "pty-expect",
            "terminal.expect",
            {"session_id": session_id, "pattern": "PTY_READY", "timeout": 3, "from_cursor": 0},
        )))
        assert matched["matched"] is True
        assert matched["match_text"] == "PTY_READY"
        closed = _response(session.execute_tool(ToolCall(
            "pty-close",
            "terminal.close",
            {"session_id": session_id},
        )))
        assert closed["status"] == "CANCELLED"


@requires_worker
def test_session_abort_reaps_worker_command_tree_and_pty(monkeypatch):
    with _session(monkeypatch, "cancel") as session:
        command = _response(session.execute_tool(ToolCall(
            "cancel-command",
            "worker.command.run",
            {"command": "sleep 30 & sleep 30 & wait", "shell": True, "timeout_seconds": 60},
        )))
        _response(session.execute_tool(ToolCall(
            "cancel-pty",
            "terminal.create",
            {"command": "sleep 30", "timeout": 60},
        )))
        time.sleep(0.15)
        assert session.abort("e2e cancellation") is True
        assert session.state.status == RunStatus.CANCELLED
        assert [event.type for event in session.event_stream()].count(EventType.RUN_CANCELLED.value) == 1

        client = WorkerClient(WORKER_URL)
        invocation = _invocation(session, "post-abort-inspection")
        deadline = time.monotonic() + 5
        status = {}
        while time.monotonic() < deadline:
            status = client.sync(client.get_command(
                session.request.task_id,
                command["command_id"],
                invocation=invocation,
            ))
            if status["status"] == "CANCELLED":
                break
            time.sleep(0.05)
        assert status["status"] == "CANCELLED"
        assert client.sync(client.list_task_sessions(
            session.request.task_id,
            invocation=invocation,
        ))["sessions"] == []
        assert client.sync(client.cancel_task(
            session.request.task_id,
            invocation=invocation,
        ))["status"] == "CANCEL_REQUESTED"
        with pytest.raises(WorkerError):
            client.sync(client.run_command({
                "challenge_id": session.request.task_id,
                "task_id": session.request.task_id,
                "command": "printf",
                "arguments": ["late"],
                "cwd": _worker_workspace(session),
            }, invocation=invocation))


@requires_worker
def test_worker_rejects_workspace_escape_and_allowlist_network(monkeypatch):
    with _session(monkeypatch, "escape") as session:
        traversal = session.execute_tool(ToolCall(
            "traversal",
            "worker.command.run",
            {"command": "pwd", "cwd": "../outside"},
        ))
        assert traversal.result.success is False
        assert traversal.result.metadata["code"] == "WORKSPACE_NOT_SHARED"

        (session.workspace / "outside-link").symlink_to("/tmp")
        symlink = session.execute_tool(ToolCall(
            "symlink-escape",
            "worker.command.run",
            {"command": "pwd", "cwd": "outside-link"},
        ))
        assert symlink.result.success is False
        assert "outside run workspace" in symlink.result.error

        sibling = SHARED_ROOT / f"sibling_{uuid.uuid4().hex[:8]}"
        sibling.mkdir(mode=0o777)
        sibling.chmod(0o777)
        secret = sibling / "secret.txt"
        secret.write_text("must-not-cross-run-boundary", encoding="utf-8")
        try:
            absolute = session.execute_tool(ToolCall(
                "absolute-escape",
                "worker.command.run",
                {"command": "cat", "arguments": [f"/workspace/tasks/{sibling.name}/secret.txt"]},
            ))
            response = _response(absolute)
            deadline = time.monotonic() + 5
            client = WorkerClient(WORKER_URL)
            invocation = _invocation(session, "absolute-status")
            while response["status"] not in {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"}:
                assert time.monotonic() < deadline
                time.sleep(0.05)
                response = client.sync(client.get_command(
                    session.request.task_id,
                    response["command_id"],
                    invocation=invocation,
                ))
            assert response["status"] == "FAILED"
            assert "Permission denied" in response["stderr"]
            assert "must-not-cross-run-boundary" not in response["stdout"]
        finally:
            shutil.rmtree(sibling, ignore_errors=True)

    policy = NetworkPolicy(mode="allowlist", allowed_hosts=("fixture.invalid",), allowed_ports=(443,))
    with _session(monkeypatch, "network", network_policy=policy) as session:
        network = session.execute_tool(ToolCall(
            "network-mode",
            "worker.command.run",
            {"command": "printf", "arguments": ["blocked"]},
        ))
        assert network.result.success is False
        assert "network_mode=deny" in network.result.error


@requires_worker
def test_worker_pty_timeout_reaps_session(monkeypatch):
    with _session(monkeypatch, "timeout") as session:
        created = _response(session.execute_tool(ToolCall(
            "timeout-pty",
            "terminal.create",
            {"command": "sleep 30", "timeout": 1},
        )))
        time.sleep(1.4)
        client = WorkerClient(WORKER_URL)
        invocation = _invocation(session, "timeout-inspection")
        sessions = client.sync(client.list_task_sessions(
            session.request.task_id,
            invocation=invocation,
        ))["sessions"]
        assert all(item["session_id"] != created["session_id"] for item in sessions)
