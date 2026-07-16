import json
import threading
import time

from app.agent_engine.abort import AbortToken
from app.agent_engine.agents.roles import default_role_execution_profiles
from app.agent_engine.budget import BudgetLimits
from app.agent_engine.contracts.task import TaskBudget, TaskNode
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.llm_subagent_worker import LLMSubagentWorker
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import AssistantTurn, ModelProvider, ProviderToolCall
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.service import agent_run_service
from app.agent_engine.state import InputReference, ModelConfig, RunRequest, RunStatus
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.validation.base import PredicateValidator


def _task(task_id: str, role: str = "scout") -> TaskNode:
    return TaskNode(
        task_id=task_id,
        title=f"Task {task_id}",
        role=role,
        expected_output="structured evidence handoff",
        success_criteria=("handoff is evidence backed",),
        allowed_tools=("read_file", "complete_task"),
        budget=TaskBudget(max_seconds=5, max_tool_calls=8, max_tokens=2000, max_cost_usd=1),
    )


def _root_request(workspace, input_path):
    return RunRequest(
        task_id="root_task",
        title="Root",
        objective="Coordinate child analysis.",
        workspace=str(workspace),
        inputs=(InputReference("evidence.txt", str(input_path)),),
        model_config=ModelConfig(provider="mock", model="scripted"),
        execution_mode="coordinator",
    )


def test_llm_subagent_uses_role_profile_and_projects_events_while_running(tmp_path):
    workspace = tmp_path / "root"
    workspace.mkdir()
    evidence_file = workspace / "evidence.txt"
    evidence_file.write_text("fixture evidence", encoding="utf-8")
    root_events = AppendOnlyEventStore()
    release_completion = threading.Event()
    captured_configs = []

    def complete_after_projection(messages, _tools):
        assert release_completion.wait(2)
        tool_message = next(message for message in reversed(messages) if message.get("role") == "tool")
        evidence_ref = json.loads(tool_message["content"])["event_id"]
        return AssistantTurn(tool_calls=(ProviderToolCall("handoff", "complete_task", {
            "summary": "scout found the fixture evidence",
            "facts": [{"fact_id": "fact_fixture", "statement": "fixture evidence exists"}],
            "evidence_refs": [evidence_ref],
            "recommended_next_actions": ["continue to verification"],
            "confidence": 0.9,
        }),))

    def provider_for_role(role, config):
        captured_configs.append((role, config))
        return ScriptedProvider([
            AssistantTurn(tool_calls=(ProviderToolCall("read", "read_file", {
                "path": "inputs/evidence.txt",
            }),)),
            complete_after_projection,
        ])

    worker = LLMSubagentWorker(
        _root_request(workspace, evidence_file),
        PredicateValidator(lambda _value: False),
        build_builtin_registry(),
        PolicyEngine(),
        provider_for_role,
        sandbox_for_workspace=lambda path, _readonly: LocalTestSandbox(path),
    )
    manager = SubagentManager("root_run", workspace, root_events, worker, max_concurrency=1)
    agent_id = manager.spawn("scout", _task("scout_fixture"))

    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if any(
            event.type == EventType.TOOL_FINISHED.value and event.agent_id == agent_id
            for event in root_events.read("root_run")
        ):
            break
        time.sleep(0.01)
    assert manager.get(agent_id).status == "running"
    projected_tool = next(
        event for event in root_events.read("root_run")
        if event.type == EventType.TOOL_FINISHED.value and event.agent_id == agent_id
    )
    assert projected_tool.payload["lineage"]["child_run_id"] == manager.get(agent_id).child_run_id
    assert projected_tool.payload["lineage"]["role"] == "scout"

    release_completion.set()
    joined = manager.join([agent_id], timeout=3)

    assert joined.summaries[0].status == "completed"
    assert joined.summaries[0].summary == "scout found the fixture evidence"
    assert joined.summaries[0].facts[0]["fact_id"] == "fact_fixture"
    assert joined.summaries[0].evidence
    assert captured_configs[0][0] == "scout"
    assert captured_configs[0][1].reasoning_effort == "high"
    assert captured_configs[0][1].temperature == 0.2
    assert captured_configs[0][1].max_parallel_tools == 2
    messages = manager.mailbox.receive("agent_root")
    assert messages[-1].payload["review_independence"] is False
    assert messages[-1].payload["confidence"] == 0.9
    assert manager.get(agent_id).workspace != workspace
    assert (manager.get(agent_id).workspace / "inputs" / "evidence.txt").is_file()
    projected_tool_count = len([
        event for event in root_events.read("root_run") if event.type == EventType.TOOL_STARTED.value
    ])
    manager.shutdown()

    unexpected_provider_calls = []
    restored_worker = LLMSubagentWorker(
        _root_request(workspace, evidence_file),
        PredicateValidator(lambda _value: False),
        build_builtin_registry(),
        PolicyEngine(),
        lambda role, config: unexpected_provider_calls.append((role, config)),
        sandbox_for_workspace=lambda path, _readonly: LocalTestSandbox(path),
    )
    restored_manager = SubagentManager("root_run", workspace, root_events, restored_worker, max_concurrency=1)
    restored_agent_id = restored_manager.spawn("scout", _task("scout_fixture"))
    restored = restored_manager.join([restored_agent_id], timeout=1).summaries[0]

    assert restored_agent_id == agent_id
    assert restored.status == "completed"
    assert unexpected_provider_calls == []
    assert len([
        event for event in root_events.read("root_run") if event.type == EventType.TOOL_STARTED.value
    ]) == projected_tool_count
    restored_manager.shutdown()


def test_verifier_profile_is_independent_and_read_only_by_capability():
    profile = default_role_execution_profiles()["verifier"]

    assert profile.review_independence is True
    assert profile.reasoning_effort == "max"
    assert profile.temperature == 0.0
    assert profile.max_parallel_tools == 1
    assert "write_file" not in profile.tool_capabilities
    assert "complete_task" in profile.tool_capabilities


def test_parent_cancel_aborts_active_leaf_session(tmp_path):
    workspace = tmp_path / "root"
    workspace.mkdir()
    evidence_file = workspace / "evidence.txt"
    evidence_file.write_text("fixture", encoding="utf-8")

    class BlockingProvider(ModelProvider):
        def complete(self, messages, tools, *, timeout_seconds: float, abort_token: AbortToken):
            abort_token.wait(timeout_seconds)
            abort_token.raise_if_aborted()
            return AssistantTurn(text="unexpected")

    worker = LLMSubagentWorker(
        _root_request(workspace, evidence_file),
        PredicateValidator(lambda _value: False),
        build_builtin_registry(),
        PolicyEngine(),
        lambda _role, _config: BlockingProvider(),
        sandbox_for_workspace=lambda path, _readonly: LocalTestSandbox(path),
    )
    events = AppendOnlyEventStore()
    manager = SubagentManager("cancel_root", workspace, events, worker, max_concurrency=1)
    agent_id = manager.spawn("scout", _task("cancel_child"))
    deadline = time.monotonic() + 1
    while manager.get(agent_id).status == "queued" and time.monotonic() < deadline:
        time.sleep(0.01)

    assert manager.cancel(agent_id, "parent cancelled") is True
    result = manager.join([agent_id], timeout=2).summaries[0]

    assert result.status == "cancelled"
    assert not worker._active
    assert EventType.AGENT_CANCELLED.value in [event.type for event in events.read("cancel_root")]
    manager.shutdown()


def test_complete_task_is_denied_outside_child_run(tmp_path):
    workspace = tmp_path / "single"
    workspace.mkdir()
    from app.agent_engine.tools.types import ToolContext

    registry = build_builtin_registry()
    definition = registry.get("complete_task")
    assert definition is not None
    result = definition.executor.execute(
        ToolContext(
            run_id="single",
            request=RunRequest("single", "single", "single", str(workspace), execution_mode="single"),
            workspace=workspace,
            abort_token=AbortToken(),
            sandbox=LocalTestSandbox(workspace),
        ),
        {"summary": "bypass", "confidence": 1.0},
    )

    assert result.success is False
    assert result.error == "root_handoff_denied"


def test_coordinator_abort_commits_terminal_event_after_child_cleanup(tmp_path):
    workspace = tmp_path / "coordinator"
    workspace.mkdir()

    class BlockingProvider(ModelProvider):
        def complete(self, messages, tools, *, timeout_seconds: float, abort_token: AbortToken):
            abort_token.wait(timeout_seconds)
            abort_token.raise_if_aborted()
            return AssistantTurn(text="unexpected")

    session = agent_run_service.create_session(
        RunRequest(
            "abort_root",
            "Abort root",
            "Run parallel child analysis and then cancel it.",
            str(workspace),
            execution_mode="coordinator",
            max_parallel_agents=2,
            budgets=BudgetLimits(max_seconds=5, max_model_requests=20, max_tool_calls=20),
        ),
        PredicateValidator(lambda _value: False),
        provider=BlockingProvider(),
        sandbox=LocalTestSandbox(workspace),
        register=False,
    )
    thread = threading.Thread(target=session.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 2
    while not session.manager.records() and time.monotonic() < deadline:
        time.sleep(0.01)

    assert session.abort("operator cancel") is True
    thread.join(3)

    assert not thread.is_alive()
    assert session.state.status == RunStatus.CANCELLED
    events = session.event_stream()
    terminal = next(event for event in events if event.type == EventType.RUN_CANCELLED.value)
    child_events = [
        event for event in events
        if event.type in {EventType.AGENT_CANCELLED.value, EventType.AGENT_COMPLETED.value}
    ]
    assert child_events
    assert terminal.sequence > max(event.sequence for event in child_events)
    assert not session.manager.worker._active
    session.manager.shutdown(cancel=True)
