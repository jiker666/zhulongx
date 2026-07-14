import threading
import time

import pytest

from app.agent_engine.agents.base import AgentSummary, ContextPolicy, WorkspacePolicy
from app.agent_engine.contracts.plan import Plan
from app.agent_engine.contracts.task import TaskBudget, TaskNode
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.primitives import human_gate, parallel, retry, series, task, vote
from app.agent_engine.orchestration.replanner import Replanner
from app.agent_engine.orchestration.scheduler import WorkflowResult, WorkflowScheduler
from app.agent_engine.orchestration.stuck_detector import StuckDetector
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.orchestration.workflow import WorkflowSpec, WorkflowValidationError, WorkflowValidator
from app.agent_engine.state import SessionState


def _task(task_id, role="scout", tools=("read_file",)):
    return TaskNode(
        task_id=task_id,
        title=task_id,
        role=role,
        expected_output="summary",
        success_criteria=("summary produced",),
        allowed_tools=tools,
    )


class _Dispatcher:
    def __init__(self):
        self.attempts = {}

    def dispatch(self, task_id, context):
        self.attempts[task_id] = self.attempts.get(task_id, 0) + 1
        if task_id == "flaky" and self.attempts[task_id] < 2:
            return WorkflowResult(False, "failed")
        return WorkflowResult(True, "completed", value=context.get("candidate_result", task_id))


def test_workflow_spec_validates_and_executes_series_retry_vote():
    root = series((
        retry(task("flaky", node_id="flaky_task"), {"max_attempts": 2}, node_id="retry_flaky"),
        vote((task("candidate_a", node_id="vote_a"), task("candidate_a", node_id="vote_b")), 2, node_id="vote"),
    ), node_id="root")
    spec = WorkflowSpec(
        "workflow_test",
        1,
        root,
        allowed_roles=("scout",),
        allowed_tools=("read_file",),
        max_budget_units=10,
    )
    task_ids = {"flaky", "candidate_a"}
    WorkflowValidator().validate(spec, task_ids=task_ids, task_roles={item: "scout" for item in task_ids})

    result = WorkflowScheduler(_Dispatcher()).execute(spec)

    assert result.success is True
    assert result.children[0].attempts == 2
    assert result.children[1].metadata["votes"] == {"'candidate_a'": 2}


def test_workflow_rejects_duplicate_nodes_unbounded_retry_and_bad_human_gate():
    duplicate = parallel((task("a", node_id="same"), task("b", node_id="same")), 2, node_id="root")
    spec = WorkflowSpec("bad", 1, duplicate, ("scout",), ("read_file",))
    with pytest.raises(WorkflowValidationError, match="unique"):
        WorkflowValidator().validate(spec, task_ids={"a", "b"}, task_roles={"a": "scout", "b": "scout"})

    bad_gate = WorkflowSpec("gate", 1, human_gate({}, node_id="gate"), ("human_liaison",), ())
    with pytest.raises(WorkflowValidationError, match="question schema"):
        WorkflowValidator().validate(bad_gate, task_ids=set(), task_roles={})


class _ParallelWorker:
    def __init__(self, barrier):
        self.barrier = barrier

    def __call__(self, record, mailbox):
        self.barrier.wait(timeout=2)
        mailbox.send(record.agent_id, "agent_root", "summary_ready", {"task_id": record.task.task_id})
        return AgentSummary(
            record.agent_id,
            record.role,
            record.task.task_id,
            "completed",
            f"completed {record.task.task_id}",
            evidence=({"evidence_id": f"e_{record.task.task_id}"},),
        )


def test_subagent_manager_parallel_join_mailbox_and_checkpoints(tmp_path):
    events = AppendOnlyEventStore()
    manager = SubagentManager(
        "run_subagents",
        tmp_path,
        events,
        _ParallelWorker(threading.Barrier(2)),
        max_concurrency=2,
    )
    first = manager.spawn("scout", _task("scan_a"), ContextPolicy(), TaskBudget(max_seconds=2), WorkspacePolicy())
    second = manager.spawn("scout", _task("scan_b"), ContextPolicy(), TaskBudget(max_seconds=2), WorkspacePolicy())

    joined = manager.join([first, second], "synthesize", timeout=3)

    assert [item.status for item in joined.summaries] == ["completed", "completed"]
    assert len(joined.aggregate["evidence"]) == 2
    assert len(manager.mailbox.receive("agent_root")) == 2
    assert manager.get(first).workspace != manager.get(second).workspace
    assert (tmp_path / ".agent_subagents" / first / ".agent_state" / "checkpoint.json").is_file()
    assert EventType.AGENT_COMPLETED.value in [event.type for event in events.read("run_subagents")]
    manager.shutdown()


def test_subagent_cancel_and_resume(tmp_path):
    class Worker:
        def __call__(self, record, mailbox):
            while not record.cancel_event.wait(0.01):
                if record.transcript and any(item.get("resumed_at") for item in record.transcript):
                    return AgentSummary(record.agent_id, record.role, record.task.task_id, "completed", "resumed")
            return AgentSummary(record.agent_id, record.role, record.task.task_id, "cancelled", "cancelled", error="cancelled")

    manager = SubagentManager("run_resume_agent", tmp_path, AppendOnlyEventStore(), Worker(), max_concurrency=1)
    agent_id = manager.spawn("scout", _task("scan"), budget=TaskBudget(max_seconds=2))
    deadline = time.monotonic() + 1
    while manager.get(agent_id).status == "queued" and time.monotonic() < deadline:
        time.sleep(0.01)
    assert manager.cancel(agent_id) is True
    assert manager.join([agent_id], timeout=2).summaries[0].status == "cancelled"

    manager.resume(agent_id, {"focus": "new evidence"})
    assert manager.join([agent_id], timeout=2).summaries[0].status == "completed"
    manager.shutdown()


def test_subagent_role_tool_scope_is_enforced(tmp_path):
    manager = SubagentManager(
        "run_scope",
        tmp_path,
        AppendOnlyEventStore(),
        lambda record, mailbox: AgentSummary(record.agent_id, record.role, record.task.task_id, "completed", "done"),
    )
    with pytest.raises(ValueError, match="cannot use tools"):
        manager.spawn("scout", _task("bad", tools=("run_shell",)))
    manager.shutdown()


def test_stuck_detector_and_replanner_escalate_with_reason():
    events = AppendOnlyEventStore()
    state = SessionState("run_stuck", "solve")
    for index in range(3):
        events.append(state.run_id, EventType.MODEL_RESPONDED, actor="provider", payload={"text": "thinking"})
        events.append(
            state.run_id,
            EventType.TOOL_REQUESTED,
            actor="model",
            payload={"name": "read_file", "arguments": {"path": "same.txt"}},
        )
        events.append(state.run_id, EventType.TOOL_FAILED, actor="tool", payload={"error": "missing"})

    report = StuckDetector(window=12).inspect(state, events.read(state.run_id))
    decision = Replanner().decide(report, previous_attempts=3, budget_ratio=0.5)
    revised = Replanner().revise(Plan("p", 1, "solve", (_task("a"),)), decision)

    assert report.stuck is True
    assert {"repeated_tool_call", "repeated_error", "no_new_evidence"} <= set(report.signals)
    assert decision.action == "review_refute"
    assert revised.version == 2
    assert revised.revision_reason
