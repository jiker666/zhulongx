from pathlib import Path

from app.agent_engine.events import EventType
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.service import agent_run_service
from app.agent_engine.state import NetworkPolicy, RunRequest
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.tools.types import ToolCall
from app.config import settings
from app.scenarios import CTFScenario


APP_ROOT = Path(__file__).resolve().parents[1] / "app"


def test_teammate_duplicate_runtime_modules_are_not_present():
    retired = (
        "core/competition_runtime.py",
        "core/agent_tool_gateway.py",
        "core/runtime_repository.py",
        "core/replay_service.py",
        "models/competition_runtime.py",
        "tools/worker.py",
    )
    assert all(not (APP_ROOT / path).exists() for path in retired)


def test_formal_competition_api_delegates_to_agent_engine_v3():
    source = (APP_ROOT / "api" / "competition.py").read_text(encoding="utf-8")
    assert "agent_run_service.create_session" in source
    assert "session.execute_tool" in source
    assert "run_manager" in source
    forbidden = ("competition_controller", "TaskState", "ToolBroker", "agent_tool_gateway")
    assert all(item not in source for item in forbidden)


def test_worker_tools_have_one_canonical_registration_path():
    registry = build_builtin_registry()
    names = [definition.name for definition in registry.definitions()]
    worker_names = [name for name in names if name.startswith("worker.") or name.startswith("terminal.")]
    assert len(worker_names) == len(set(worker_names)) == 11
    legacy_registry = (APP_ROOT / "core" / "tool_registry.py").read_text(encoding="utf-8")
    assert "WorkerCommandRunTool" not in legacy_registry
    assert "TerminalCreateTool" not in legacy_registry


def test_worker_invocation_carries_v3_identity_scope_and_events(monkeypatch, tmp_path):
    shared_root = tmp_path / "worker_tasks"
    workspace = shared_root / "run"
    workspace.mkdir(parents=True)
    monkeypatch.setattr(settings, "WORKER_SHARED_ROOT", str(shared_root))
    monkeypatch.setattr(settings, "WORKER_WORKSPACE_ROOT", "/workspace/tasks")
    captured = {}

    async def fake_run_command(client, payload, *, invocation):
        captured["payload"] = payload
        captured["invocation"] = dict(invocation)
        return {"command_id": "cmd_fixture", "status": "QUEUED"}

    monkeypatch.setattr("app.core.worker_client.WorkerClient.run_command", fake_run_command)
    request = RunRequest(
        task_id="worker-v3-contract",
        title="worker contract",
        objective="verify canonical worker invocation",
        workspace=str(workspace),
        authorization={"allow_worker": True, "allow_process": True},
        network_policy=NetworkPolicy(mode="deny"),
    )
    session = agent_run_service.create_session(
        request,
        CTFScenario().validator(),
        provider=ScriptedProvider([]),
        sandbox=LocalTestSandbox(workspace),
        register=False,
    )
    execution = session.execute_tool(ToolCall(
        "worker-call-fixture",
        "worker.command.run",
        {"command": "printf", "arguments": ["ok"]},
    ))
    assert execution.result.success is True
    assert captured["payload"]["cwd"] == "/workspace/tasks/run"
    assert captured["invocation"] == {
        "run_id": session.run_id,
        "session_id": session.run_id,
        "task_id": "worker-v3-contract",
        "tool_call_id": "worker-call-fixture",
        "workspace": "/workspace/tasks/run",
        "authorization": {
            "authorized": False,
            "allow_process": True,
            "allow_worker": True,
            "approval_mode": "",
        },
        "scope": {"network_mode": "deny", "allowed_hosts": [], "allowed_ports": []},
    }
    assert [event.type for event in session.event_stream()][-4:] == [
        EventType.TOOL_REQUESTED.value,
        EventType.POLICY_ALLOWED.value,
        EventType.TOOL_STARTED.value,
        EventType.TOOL_FINISHED.value,
    ]
