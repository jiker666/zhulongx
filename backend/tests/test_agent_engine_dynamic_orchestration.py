from __future__ import annotations

import json
import threading
import time
from dataclasses import replace

import pytest

from app.agent_engine.abort import AbortToken
from app.agent_engine.agents.base import AgentSummary
from app.agent_engine.budget import BudgetLimits
from app.agent_engine.checkpoint import CheckpointStore
from app.agent_engine.contracts.plan import Plan
from app.agent_engine.contracts.task import TaskBudget, TaskNode, TaskStatus
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.completion_policy import CoordinatorCompletionPolicy
from app.agent_engine.orchestration.coordinator import CoordinatorSession
from app.agent_engine.orchestration.dynamic_scheduler import DynamicTaskScheduler, SchedulerOutcome
from app.agent_engine.orchestration.graph_replanner import EvidenceDrivenGraphReplanner
from app.agent_engine.orchestration.planner import DynamicPlanner, PlanNodeProposal, TaskBudgetProposal
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.orchestration.task_graph import TaskGraph
from app.agent_engine.orchestration.task_graph_store import PlanPatch, PlanPatchOperation, TaskGraphStore
from app.agent_engine.providers.base import AssistantTurn, ModelProvider, ProviderToolCall
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.service import agent_run_service
from app.agent_engine.state import RunRequest, RunStatus, SessionState
from app.agent_engine.validation.base import PredicateValidator
from app.agent_engine.validation.ctf import CTFValidator
from app.scenarios import CTFScenario


def _request(tmp_path, *, task_id: str = "dynamic") -> RunRequest:
    workspace = tmp_path / task_id
    workspace.mkdir()
    return RunRequest(
        task_id,
        "Dynamic fixture",
        "Analyze the fixture through parallel hypotheses and independent verification.",
        str(workspace),
        scenario="ctf",
        execution_mode="coordinator",
    )


def _planner(request: RunRequest, provider: ModelProvider) -> tuple[DynamicPlanner, Plan]:
    scenario = CTFScenario()
    manifest = scenario.manifest()
    return (
        DynamicPlanner(
            provider,
            allowed_roles=manifest.roles,
            allowed_tools=manifest.allowed_tools,
            required_outputs=manifest.required_outputs,
        ),
        scenario.build_plan(request.objective),
    )


def _small_node(
    task_id: str,
    *,
    role: str = "scout",
    dependencies: tuple[str, ...] = (),
    status: TaskStatus = TaskStatus.PENDING,
    priority: int = 0,
) -> TaskNode:
    return TaskNode(
        task_id,
        task_id.replace("_", " ").title(),
        role,
        "evidence handoff",
        ("evidence is reproducible",),
        dependencies=dependencies,
        allowed_tools=("list_dir", "complete_task"),
        budget=TaskBudget(3, 4, 1000, 0.1),
        status=status,
        priority=priority,
        workspace_policy="shared_readonly" if role in {"scout", "analyst"} else "isolated",
        verification_policy="independent" if role in {"verifier", "refuter"} else "evidence_required",
    )


def _small_plan(*nodes: TaskNode, version: int = 1, reason: str = "") -> Plan:
    return Plan(
        "plan_dynamic_test",
        version,
        "Exercise the dynamic graph.",
        nodes,
        critical_path=tuple(node.task_id for node in nodes),
        revision_reason=reason,
        completion_contract={"pending_external_allowed": True},
    )


def _proposal_node(node: TaskNode, *, task_id: str | None = None) -> PlanNodeProposal:
    return PlanNodeProposal(
        task_id=task_id or node.task_id,
        title=node.title,
        role=node.role,
        objective=node.objective or node.title,
        dependencies=list(node.dependencies),
        allowed_capabilities=list(node.allowed_tools),
        expected_outputs=[node.expected_output],
        success_criteria=list(node.success_criteria),
        budget=TaskBudgetProposal(**node.budget.__dict__),
        priority=node.priority,
        workspace_policy=node.workspace_policy,
        verification_policy=node.verification_policy,
        attempt=node.attempt,
    )


def test_model_planner_repairs_invalid_json_and_emits_capability_event(tmp_path):
    request = _request(tmp_path, task_id="planner_repair")
    bootstrap, macro = _planner(request, ScriptedProvider([]))
    valid = bootstrap._offline_proposal(request, macro).model_dump_json()
    provider = ScriptedProvider([
        AssistantTurn(text="{not-json"),
        AssistantTurn(
            text=valid,
            provider_metadata={"capability_negotiation": {"downgraded_fields": ["response_format"]}},
        ),
    ])
    planner, macro = _planner(request, provider)
    events = AppendOnlyEventStore()

    result = planner.propose(request, macro, events, "run_planner_repair", AbortToken())

    assert result.source == "model"
    assert result.attempts == 2
    assert len(result.proposal.hypotheses) >= 2
    assert TaskGraph(result.plan, allowed_roles=planner.allowed_roles, available_tools=planner.allowed_tools)
    types = [event.type for event in events.read("run_planner_repair")]
    assert types.count(EventType.MODEL_REQUESTED.value) == 2
    assert EventType.PROVIDER_CAPABILITY_NEGOTIATED.value in types


def test_offline_planner_builds_two_hypotheses_and_budgeted_valid_dag(tmp_path):
    request = _request(tmp_path, task_id="offline_plan")
    planner, macro = _planner(request, ScriptedProvider([]))

    result = planner.propose(request, macro, AppendOnlyEventStore(), "run_offline", AbortToken())

    assert result.source == "offline_deterministic"
    assert len(result.proposal.hypotheses) == 2
    assert len({item.falsification_test for item in result.proposal.hypotheses}) == 2
    assert sum(node.budget.max_tool_calls for node in result.plan.nodes) <= request.budgets.max_tool_calls
    assert TaskGraph(result.plan, allowed_roles=planner.allowed_roles, available_tools=planner.allowed_tools).topological_order()


def test_plan_patch_rejects_cycles_tools_budget_and_protected_replacement():
    first = _small_node("first")
    second = _small_node("second", dependencies=("first",))
    plan = _small_plan(first, second)

    with pytest.raises(ValueError, match="cycle"):
        TaskGraphStore(
            plan,
            allowed_roles=("scout",),
            available_tools=("list_dir", "complete_task"),
        ).apply(PlanPatch(reason="cycle", operations=[
            PlanPatchOperation(operation="add_dependency", task_id="first", dependency_id="second"),
        ]))

    with pytest.raises(ValueError, match="unavailable"):
        TaskGraphStore(
            plan,
            allowed_roles=("scout",),
            available_tools=("list_dir", "complete_task"),
        ).apply(PlanPatch(reason="tool scope", operations=[
            PlanPatchOperation(operation="change_tool_scope", task_id="first", allowed_capabilities=["run_shell"]),
        ]))

    with pytest.raises(ValueError, match="total tool budget"):
        TaskGraphStore(
            plan,
            allowed_roles=("scout",),
            available_tools=("list_dir", "complete_task"),
            max_total_tool_calls=9,
        ).apply(PlanPatch(reason="budget", operations=[
            PlanPatchOperation(operation="change_budget", task_id="first", budget={"max_tool_calls": 8}),
        ]))

    replacement = _proposal_node(first, task_id="first_v2")
    with pytest.raises(ValueError, match="protected evidence task"):
        TaskGraphStore(
            plan,
            allowed_roles=("scout",),
            available_tools=("list_dir", "complete_task"),
        ).apply(
            PlanPatch(reason="replace", operations=[
                PlanPatchOperation(operation="replace_node", task_id="first", node=replacement),
            ]),
            protected_task_ids={"first"},
        )


def test_failure_patch_rewires_and_scheduler_executes_replacement(tmp_path):
    workspace = tmp_path / "replace_scheduler"
    workspace.mkdir()
    events = AppendOnlyEventStore()
    calls: list[str] = []

    def worker(record, _mailbox):
        calls.append(record.task.task_id)
        blocked = record.task.task_id == "first"
        return AgentSummary(
            record.agent_id,
            record.role,
            record.task.task_id,
            "blocked" if blocked else "completed",
            "blocked primary" if blocked else "completed alternate",
            evidence=({"evidence_id": f"ev_{record.task.task_id}"},) if not blocked else (),
            error="fixture failure" if blocked else "",
        )

    plan = _small_plan(_small_node("first"), _small_node("second", dependencies=("first",)))
    store = TaskGraphStore(
        plan,
        allowed_roles=("scout",),
        available_tools=("list_dir", "complete_task"),
    )
    manager = SubagentManager("run_replace", workspace, events, worker, max_concurrency=2)
    scheduler = DynamicTaskScheduler("run_replace", store.graph, manager, events, max_concurrency=2)

    failed = scheduler.execute_until_blocked()
    replan = EvidenceDrivenGraphReplanner().propose(store, failed)
    assert replan.patch is not None
    revision = store.apply(
        replan.patch,
        completed_task_ids=set(failed.completed_task_ids),
        failed_task_ids=set(failed.failed_task_ids),
    )
    scheduler.update_graph(store.graph)
    completed = scheduler.execute_until_blocked()

    replacement_id = "first_alternative_v2"
    assert revision.plan.version == 2
    assert store.graph.nodes["first"].status == TaskStatus.CANCELLED
    assert store.graph.nodes["second"].dependencies == (replacement_id,)
    assert completed.success is True
    assert calls == ["first", replacement_id, "second"]
    manager.shutdown()


def test_two_readonly_nodes_overlap_and_respect_role_capacity(tmp_path):
    workspace = tmp_path / "parallel"
    workspace.mkdir()
    events = AppendOnlyEventStore()
    barrier = threading.Barrier(2)
    intervals: dict[str, tuple[float, float]] = {}

    def worker(record, _mailbox):
        started = time.monotonic()
        barrier.wait(timeout=2)
        time.sleep(0.05)
        intervals[record.task.task_id] = (started, time.monotonic())
        return AgentSummary(
            record.agent_id,
            record.role,
            record.task.task_id,
            "completed",
            "read-only triage complete",
            evidence=({"evidence_id": f"ev_{record.task.task_id}"},),
        )

    plan = _small_plan(_small_node("left", priority=2), _small_node("right", priority=1))
    graph = TaskGraph(plan, allowed_roles=("scout",), available_tools=("list_dir", "complete_task"))
    manager = SubagentManager("run_parallel", workspace, events, worker, max_concurrency=4)

    outcome = DynamicTaskScheduler("run_parallel", graph, manager, events, max_concurrency=4).execute_until_blocked()

    assert outcome.success is True
    assert max(value[0] for value in intervals.values()) < min(value[1] for value in intervals.values())
    manager.shutdown()


def test_rejected_verifier_creates_independent_refuter_and_replacement():
    evidence = _small_node("evidence", role="scout", status=TaskStatus.COMPLETED)
    verifier = _small_node(
        "verify",
        role="verifier",
        dependencies=("evidence",),
        status=TaskStatus.COMPLETED,
    )
    plan = _small_plan(evidence, verifier)
    store = TaskGraphStore(
        plan,
        allowed_roles=("scout", "verifier", "refuter"),
        available_tools=("list_dir", "complete_task"),
    )
    summaries = {
        "evidence": AgentSummary("a", "scout", "evidence", "completed", "evidence"),
        "verify": AgentSummary("v", "verifier", "verify", "completed", "rejected", verdict="rejected"),
    }
    outcome = SchedulerOutcome(True, ("evidence", "verify"), (), (), summaries, ("ev",))
    synthetic = replace(outcome, success=False, failed_task_ids=("verify",), reason="verifier rejected")

    result = EvidenceDrivenGraphReplanner().propose(store, synthetic)
    assert result.patch is not None
    revision = store.apply(
        result.patch,
        completed_task_ids=set(outcome.completed_task_ids),
        failed_task_ids={"verify"},
    )

    assert result.action == "review_refute"
    assert "verify_refuter_v2" in {node.task_id for node in revision.plan.nodes if node.role == "refuter"}
    assert store.graph.nodes["verify"].status == TaskStatus.CANCELLED
    assert store.graph.nodes["verify_alternative_v2"].dependencies[-1] == "verify_refuter_v2"


def _completion_fixture(tmp_path, *, validator):
    request = _request(tmp_path, task_id="completion")
    events = AppendOnlyEventStore()
    tool = events.append(
        "run_completion",
        EventType.TOOL_FINISHED,
        actor="fixture",
        task_id="solve",
        payload={"name": "read_file", "success": True},
    )
    state = SessionState("run_completion", request.objective, status=RunStatus.RUNNING)
    state.candidate_answers = [{
        "candidate": "flag{dynamic}",
        "status": "detected",
        "evidence_event_ids": [tool.event_id],
        "reproduction": "read fixture",
    }]
    solve = _small_node("solve", role="scout", status=TaskStatus.COMPLETED)
    verify = _small_node("verify", role="verifier", dependencies=("solve",), status=TaskStatus.COMPLETED)
    plan = _small_plan(solve, verify)
    summaries = {
        "solve": AgentSummary("s", "scout", "solve", "completed", "solved", evidence=({"evidence_id": tool.event_id},)),
        "verify": AgentSummary("v", "verifier", "verify", "completed", "verified", verdict="accepted"),
    }
    outcome = SchedulerOutcome(True, ("solve", "verify"), (), (), summaries, (tool.event_id,))
    return request, events, state, plan, outcome, CoordinatorCompletionPolicy(validator)


def test_completion_requires_accepted_verdict_and_scenario_validator(tmp_path):
    fixture = _completion_fixture(tmp_path, validator=PredicateValidator(lambda value: value == "flag{dynamic}"))
    request, events, state, plan, outcome, policy = fixture

    accepted = policy.decide(request, plan, outcome, state, events, tmp_path)
    rejected_verifier = replace(outcome, summaries={
        **outcome.summaries,
        "verify": replace(outcome.summaries["verify"], verdict="rejected"),
    })
    rejected = policy.decide(request, plan, rejected_verifier, state, events, tmp_path)

    assert accepted.status == "succeeded"
    assert accepted.evidence_ids
    assert rejected.status == "rejected"


def test_ctf_completion_enters_pending_external_without_evaluator(tmp_path):
    fixture = _completion_fixture(tmp_path, validator=CTFValidator(flag_pattern=r"flag\{[^}]+\}"))
    request, events, state, plan, outcome, policy = fixture

    decision = policy.decide(request, plan, outcome, state, events, tmp_path)

    assert decision.status == "pending_external"
    assert decision.output["candidate"] == "flag{dynamic}"


def test_resume_replays_events_after_lagging_checkpoint_without_repeating_nodes(tmp_path):
    request = _request(tmp_path, task_id="resume_graph")
    scenario = CTFScenario()
    plan = scenario.build_plan(request.objective)
    workflow = scenario.workflow(request.objective)
    events = AppendOnlyEventStore()
    checkpoints = CheckpointStore(tmp_path / "resume_checkpoints")
    calls: list[str] = []

    def worker(record, _mailbox):
        calls.append(record.task.task_id)
        return AgentSummary(record.agent_id, record.role, record.task.task_id, "completed", "unexpected")

    manager = SubagentManager("run_resume_graph", request.workspace, events, worker, max_concurrency=2)
    session = CoordinatorSession(
        request,
        plan,
        workflow,
        manager,
        events=events,
        run_id="run_resume_graph",
        checkpoint_store=checkpoints,
    )
    session._append(EventType.RUN_STARTED, "fixture", {"workflow_id": workflow.workflow_id})
    session._append(EventType.PLAN_ACCEPTED, "fixture", {"plan": plan.to_dict(), "reason": "fixture"})
    session._append(EventType.PLAN_COMPLETED, "fixture", {"task_id": plan.nodes[0].task_id})
    session._save_checkpoint()
    for node in plan.nodes[1:]:
        events.append(
            "run_resume_graph",
            EventType.PLAN_COMPLETED,
            actor="fixture_after_checkpoint",
            task_id=node.task_id,
            payload={"task_id": node.task_id},
        )

    restored_manager = SubagentManager("run_resume_graph", request.workspace, events, worker, max_concurrency=2)
    restored = CoordinatorSession.resume(
        request,
        plan,
        workflow,
        restored_manager,
        events=events,
        run_id="run_resume_graph",
        checkpoint_store=checkpoints,
    )
    scheduler = DynamicTaskScheduler("run_resume_graph", restored.graph, restored_manager, events)

    assert scheduler.execute_until_blocked().success is True
    assert calls == []
    assert all(node.status == TaskStatus.COMPLETED for node in restored.graph.nodes.values())
    manager.shutdown()
    restored_manager.shutdown()


class _FormalFixtureProvider(ModelProvider):
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counter = 0

    def complete(self, messages, tools, *, timeout_seconds: float, abort_token: AbortToken):
        abort_token.raise_if_aborted()
        transcript = json.dumps(messages, ensure_ascii=False)
        role = next((name for name in ("verifier", "synthesizer", "executor", "scout", "analyst", "planner")
                     if f"Assigned role: {name}." in transcript), "scout")
        tool_messages = [message for message in messages if message.get("role") == "tool"]
        with self._lock:
            self._counter += 1
            call_id = f"formal_{self._counter}"
        if not tool_messages:
            return AssistantTurn(tool_calls=(ProviderToolCall(call_id, "list_dir", {"path": "."}),))
        evidence_id = json.loads(tool_messages[-1]["content"])["event_id"]
        if "Task: Format Scout:" in transcript and "Alternate strategy:" not in transcript:
            return AssistantTurn(tool_calls=(ProviderToolCall(call_id, "complete_task", {
                "status": "blocked",
                "summary": "injected scout failure",
                "evidence_refs": [evidence_id],
                "confidence": 0,
            }),))
        if role == "executor":
            return AssistantTurn(tool_calls=(ProviderToolCall(call_id, "submit_candidate", {
                "candidate": "flag{dynamic}",
                "evidence_event_ids": [evidence_id],
                "reproduction": "list the isolated workspace",
            }),))
        summary = (
            json.dumps({"candidate": "flag{dynamic}", "evidence_event_ids": [evidence_id], "reproduction": "listed"})
            if role == "synthesizer"
            else f"{role} completed with evidence"
        )
        return AssistantTurn(tool_calls=(ProviderToolCall(call_id, "complete_task", {
            "summary": summary,
            "evidence_refs": [evidence_id],
            "confidence": 1,
            "verdict": "accepted" if role == "verifier" else "",
        }),))


def test_formal_auto_run_emits_dynamic_parallel_replan_and_completion_sequence(tmp_path):
    workspace = tmp_path / "formal_auto"
    workspace.mkdir()
    request = RunRequest(
        "formal_auto",
        "Formal auto",
        "Solve this difficult open fixture with parallel analysis, failure recovery, and independent verification.",
        str(workspace),
        scenario="ctf",
        execution_mode="auto",
        max_parallel_agents=4,
        budgets=BudgetLimits(max_seconds=20, max_model_requests=100, max_tool_calls=100),
    )
    session = agent_run_service.create_session(
        request,
        PredicateValidator(lambda value: value == "flag{dynamic}"),
        provider=_FormalFixtureProvider(),
        sandbox=LocalTestSandbox(workspace),
        register=False,
    )

    state = session.run()
    event_types = [event.type for event in session.event_stream()]

    assert state.status == RunStatus.SUCCEEDED
    assert EventType.PLAN_PROPOSED.value in event_types
    assert EventType.PLAN_ACCEPTED.value in event_types
    assert event_types.count(EventType.AGENT_SPAWNED.value) >= 2
    assert EventType.TASK_STARTED.value in event_types
    assert EventType.TOOL_STARTED.value in event_types
    assert EventType.TOOL_FINISHED.value in event_types
    assert EventType.AGENT_COMPLETED.value in event_types
    assert EventType.PLAN_REVISED.value in event_types
    assert EventType.COMPLETION_DECIDED.value in event_types
    assert EventType.RUN_SUCCEEDED.value in event_types
    session.manager.shutdown()


def test_operator_retry_of_blocked_branch_uses_structural_replanner(tmp_path):
    workspace = tmp_path / "operator_retry"
    workspace.mkdir()
    request = RunRequest("operator_retry", "Operator retry", "Retry one blocked branch.", str(workspace))
    scenario = CTFScenario()
    plan = scenario.build_plan(request.objective)
    workflow = scenario.workflow(request.objective)
    events = AppendOnlyEventStore()

    def worker(record, _mailbox):
        return AgentSummary(
            record.agent_id,
            record.role,
            record.task.task_id,
            "blocked",
            "fixture blocked",
            error="fixture blocked",
        )

    manager = SubagentManager("run_operator_retry", workspace, events, worker)
    session = CoordinatorSession(
        request,
        plan,
        workflow,
        manager,
        events=events,
        run_id="run_operator_retry",
    )
    node = plan.nodes[0]
    agent_id = manager.spawn(node.role, node)
    assert manager.join([agent_id], timeout=2).summaries[0].status == "blocked"

    result = session.retry_branch(node.task_id, "operator selected alternate strategy")

    assert result["status"] == "scheduled"
    assert result["replacement_task_id"]
    assert session.graph_store.graph.nodes[node.task_id].status == TaskStatus.CANCELLED
    assert session.plan.version == 2
    manager.shutdown()
