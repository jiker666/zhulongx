from __future__ import annotations

import json
import threading
import time

from app.agent_engine.abort import AbortToken
from app.agent_engine.agents.base import AgentSummary
from app.agent_engine.context import ContextBuilder
from app.agent_engine.context_budget import ContextBudget
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.hooks import HookPipeline
from app.agent_engine.orchestration.coordinator import CoordinatorSession
from app.agent_engine.orchestration.dynamic_scheduler import DynamicTaskScheduler, SchedulerOutcome
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.orchestration.task_graph_store import PlanPatch, PlanPatchOperation
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import AssistantTurn, ProviderToolCall
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.reducer import StateReducer
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.state import ModelConfig, RunRequest, SessionState
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.resource_locks import ResourceLockManager
from app.agent_engine.tools.selector import ToolCapabilitySelector
from app.agent_engine.tools.types import ToolCall, ToolContext, ToolDefinition, ToolResult
from app.agent_engine.validation.base import PredicateValidator
from app.scenarios import CTFScenario


class _ResultExecutor:
    def __init__(self, value: str = "ok") -> None:
        self.value = value
        self.calls = 0

    def execute(self, _context, _arguments):
        self.calls += 1
        return ToolResult(True, self.value, output=self.value)


def _definition(name: str, executor=None, *, locks=(), side_effect="read") -> ToolDefinition:
    return ToolDefinition(
        name=name,
        description=f"Fixture capability {name}",
        input_schema={"type": "object", "additionalProperties": False},
        risk_level="low",
        permissions=("local_read",),
        timeout_seconds=2,
        executor=executor or _ResultExecutor(name),
        idempotency="read_only" if side_effect == "read" else "idempotent",
        side_effect_level=side_effect,
        resource_locks=tuple(locks),
        parallel_safe=side_effect == "read",
    )


def test_context_pack_is_token_bounded_stable_and_keeps_recent_tool_pair(tmp_path):
    request = RunRequest(
        "context_pack",
        "Context pack",
        "Find needle evidence in the indexed artifact and preserve the most recent tool exchange.",
        str(tmp_path),
        model_config=ModelConfig(context_budget_tokens=32_768, max_tokens=4096),
    )
    state = SessionState("run_context_pack", request.objective)
    state.artifacts = [{
        "artifact_id": "artifact_fixture",
        "original_name": "fixture.txt",
        "media_type": "text/plain",
        "size": 100,
        "sha256": "a" * 64,
        "storage_path": ".agent_artifacts/inputs/fixture.txt",
        "extraction": {
            "chunks": ["ordinary material", "needle evidence is in this indexed chunk"],
            "summary": "two chunks",
        },
    }]
    events = AppendOnlyEventStore()
    latest_call = ""
    for index in range(30):
        latest_call = f"call_{index}"
        events.append(
            state.run_id,
            EventType.MODEL_RESPONDED,
            actor="provider",
            payload={
                "text": f"round {index}",
                "tool_calls": [{"id": latest_call, "name": "read_file", "arguments": {"path": "fixture.txt"}}],
            },
        )
        events.append(
            state.run_id,
            EventType.TOOL_FINISHED,
            actor="tool",
            payload={
                "tool_call_id": latest_call,
                "name": "read_file",
                "success": True,
                "output": (f"result {index} " * 1000),
            },
        )
    builder = ContextBuilder()

    first = builder.build_pack(request, state, events)
    state.open_hypotheses = [{"hypothesis_id": "h1", "statement": "dynamic state changes"}]
    second = builder.build_pack(request, state, events)

    budget = ContextBudget.for_request(request)
    assert first.stats.estimated_prompt_tokens <= budget.max_prompt_tokens
    assert first.stats.omitted_event_count > 0
    assert first.stats.stable_prefix_sha256 == second.stats.stable_prefix_sha256
    assistant_calls = [
        call["id"]
        for message in first.messages
        if message.get("role") == "assistant"
        for call in message.get("tool_calls", ())
    ]
    tool_calls = [
        message["tool_call_id"] for message in first.messages if message.get("role") == "tool"
    ]
    assert latest_call in assistant_calls
    assert latest_call in tool_calls
    assert "needle evidence" in first.messages[1]["content"]
    compactable = builder.compactable_events(request, state, events)
    assert compactable
    assert compactable[-1].sequence < min(first.stats.included_event_sequences)


def test_tool_selector_caps_functions_and_executor_rejects_unselected_call(tmp_path):
    registry = ToolRegistry()
    executors = {}
    for index in range(140):
        name = f"fixture_tool_{index:03d}"
        executors[name] = _ResultExecutor(name)
        registry.register(_definition(name, executors[name]))
    request = RunRequest("selector", "Selector", "Use the relevant fixture tool.", str(tmp_path))
    selection = ToolCapabilitySelector().select(request, SessionState("run_selector", request.objective), registry)

    assert len(selection.names) == 128
    assert len(selection.schemas()) == 128

    events = AppendOnlyEventStore()
    hook_errors: list[str] = []
    service = ToolExecutionService(
        registry,
        PolicyEngine(),
        events,
        hooks=HookPipeline({"on_tool_error": (lambda context: hook_errors.append(str(context.data["error"])),)}),
    )
    denied_name = next(name for name in executors if name not in set(selection.names))
    context = ToolContext(
        "run_selector",
        request,
        tmp_path,
        AbortToken(),
        LocalTestSandbox(tmp_path),
        exposed_tools=selection.names,
    )
    denied = service.execute(ToolCall("denied", denied_name, {}), context)

    assert denied.result.success is False
    assert denied.result.metadata["code"] == "tool_not_selected"
    assert executors[denied_name].calls == 0
    assert hook_errors == ["tool_not_selected"]


def test_hooks_observe_model_tool_evidence_completion_checkpoint_and_abort(tmp_path):
    workspace = tmp_path / "hooks"
    workspace.mkdir()
    (workspace / "answer.txt").write_text("flag{hooks}", encoding="utf-8")
    observed: list[str] = []
    names = (
        "before_model",
        "before_tool_selection",
        "before_tool_call",
        "after_tool_call",
        "on_tool_error",
        "after_evidence_extraction",
        "before_plan_patch",
        "before_completion",
        "on_checkpoint",
        "on_abort",
    )
    hooks = HookPipeline({name: (lambda _context, name=name: observed.append(name),) for name in names})
    session = AgentSession(
        RunRequest("hooks", "Hooks", "Find the fixture candidate.", str(workspace)),
        provider=ScriptedProvider([
            AssistantTurn(tool_calls=(ProviderToolCall("read", "read_file", {"path": "answer.txt"}),)),
            AssistantTurn(tool_calls=(ProviderToolCall("submit", "submit_candidate", {"candidate": "flag{hooks}"}),)),
        ]),
        validator=PredicateValidator(lambda value: value == "flag{hooks}"),
        sandbox=LocalTestSandbox(workspace),
        hooks=hooks,
    )

    session.run()

    assert "before_model" in observed
    assert "before_tool_selection" in observed
    assert "before_tool_call" in observed
    assert "after_tool_call" in observed
    assert "after_evidence_extraction" in observed
    assert "before_completion" in observed
    assert "on_checkpoint" in observed
    assert EventType.TOOLSET_SELECTED.value in [event.type for event in session.event_stream()]

    abort_workspace = tmp_path / "abort_hooks"
    abort_workspace.mkdir()
    abort_session = AgentSession(
        RunRequest("abort_hooks", "Abort hooks", "Abort before start.", str(abort_workspace)),
        provider=ScriptedProvider([]),
        validator=PredicateValidator(lambda _value: False),
        sandbox=LocalTestSandbox(abort_workspace),
        hooks=hooks,
    )
    abort_session.abort("fixture abort")
    assert "on_abort" in observed


def test_state_invariant_requires_known_evidence_before_fact_promotion(tmp_path):
    registry = ToolRegistry()
    from app.agent_engine.tools.builtin import build_builtin_registry

    registry = build_builtin_registry()
    events = AppendOnlyEventStore()
    request = RunRequest("facts", "Facts", "Record evidence-backed facts.", str(tmp_path))
    context = ToolContext("run_facts", request, tmp_path, AbortToken(), LocalTestSandbox(tmp_path))
    service = ToolExecutionService(registry, PolicyEngine(), events)
    arguments = {
        "fact_id": "f1",
        "statement": "fixture exists",
        "evidence_ids": ["missing"],
        "confidence": 1,
        "source": "fixture",
    }

    denied = service.execute(ToolCall("fact_missing", "record_fact", arguments), context)
    source = events.append(
        context.run_id,
        EventType.TOOL_FINISHED,
        actor="fixture",
        payload={"name": "read_file", "success": True},
    )
    accepted = service.execute(ToolCall(
        "fact_known",
        "record_fact",
        {**arguments, "evidence_ids": [source.event_id]},
    ), context)

    assert denied.result.metadata["code"] == "state_invariant"
    assert accepted.result.success is True

    invalid_events = AppendOnlyEventStore()
    invalid_events.append(
        "run_invalid_fact",
        EventType.FACT_CONFIRMED,
        actor="fixture",
        payload={"fact": {"fact_id": "invalid", "statement": "unsupported"}},
    )
    replayed = StateReducer().replay("run_invalid_fact", "fixture", invalid_events.read("run_invalid_fact"))
    assert replayed.confirmed_facts == []


def test_resource_locks_serialize_side_effects_across_executors(tmp_path):
    workspace = tmp_path / "resource_locks"
    workspace.mkdir()
    intervals: list[tuple[float, float]] = []
    guard = threading.Lock()

    class SlowWrite:
        def execute(self, _context, _arguments):
            started = time.monotonic()
            time.sleep(0.08)
            finished = time.monotonic()
            with guard:
                intervals.append((started, finished))
            return ToolResult(True, "written")

    registry = ToolRegistry()
    registry.register(_definition("shared_write", SlowWrite(), locks=("workspace_write",), side_effect="write"))
    locks = ResourceLockManager()
    request = RunRequest("locks", "Locks", "Serialize fixture writes.", str(workspace))
    context = ToolContext("run_locks", request, workspace, AbortToken(), LocalTestSandbox(workspace))
    first = ToolExecutionService(registry, PolicyEngine(), AppendOnlyEventStore(), resource_locks=locks)
    second = ToolExecutionService(registry, PolicyEngine(), AppendOnlyEventStore(), resource_locks=locks)
    threads = [
        threading.Thread(target=service.execute, args=(ToolCall(f"call_{index}", "shared_write", {}), context))
        for index, service in enumerate((first, second))
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(2)

    assert len(intervals) == 2
    intervals.sort()
    assert intervals[1][0] >= intervals[0][1]


def test_coordinator_plan_patch_runs_hook_before_graph_mutation(tmp_path):
    workspace = tmp_path / "plan_hook"
    workspace.mkdir()
    request = RunRequest("plan_hook", "Plan hook", "Revise the fixture graph.", str(workspace))
    scenario = CTFScenario()
    plan = scenario.build_plan(request.objective)
    workflow = scenario.workflow(request.objective)
    events = AppendOnlyEventStore()
    observed: list[tuple[str, int]] = []
    hooks = HookPipeline({
        "before_plan_patch": (
            lambda context: observed.append((str(context.data["reason"]), int(context.data["operation_count"]))),
        ),
    })

    def worker(record, _mailbox):
        return AgentSummary(
            record.agent_id, record.role, record.task.task_id, "completed", "fixture",
        )

    manager = SubagentManager("run_plan_hook", workspace, events, worker)
    session = CoordinatorSession(
        request,
        plan,
        workflow,
        manager,
        events=events,
        run_id="run_plan_hook",
        hooks=hooks,
    )
    session.dynamic_scheduler = DynamicTaskScheduler("run_plan_hook", session.graph, manager, events)
    patch = PlanPatch(reason="raise information gain", operations=[
        PlanPatchOperation(operation="reprioritize", task_id=plan.nodes[0].task_id, priority=7),
    ])
    outcome = SchedulerOutcome(False, (), (plan.nodes[0].task_id,), (), {}, (), "fixture")

    session._apply_patch(patch, outcome)

    assert observed == [("raise information gain", 1)]
    assert session.graph_store.plan.version == 2
    assert session.graph_store.graph.nodes[plan.nodes[0].task_id].priority == 7
    manager.shutdown()
