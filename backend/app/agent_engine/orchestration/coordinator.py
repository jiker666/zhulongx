from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any, Mapping

from app.agent_engine.agents.base import ContextPolicy, WorkspacePolicy
from app.agent_engine.checkpoint import CheckpointSnapshot, CheckpointStore
from app.agent_engine.contracts.plan import Plan
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.scheduler import TaskDispatcher, WorkflowResult, WorkflowScheduler
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.orchestration.task_graph import TaskGraph
from app.agent_engine.orchestration.workflow import WorkflowSpec, WorkflowValidator
from app.agent_engine.reducer import StateReducer
from app.agent_engine.state import RunRequest, RunStatus, SessionState, TERMINAL_STATUSES


class SubagentTaskDispatcher(TaskDispatcher):
    def __init__(self, run_id: str, plan: Plan, manager: SubagentManager, events: AppendOnlyEventStore) -> None:
        self.run_id = run_id
        self.nodes = {node.task_id: node for node in plan.nodes}
        self.manager = manager
        self.events = events

    def dispatch(self, task_id: str, context: Mapping[str, Any]) -> WorkflowResult:
        node = self.nodes[task_id]
        started = self.events.append(
            self.run_id,
            EventType.PLAN_NODE_STARTED,
            actor="coordinator",
            task_id=task_id,
            payload={"task_id": task_id},
        )
        agent_id = self.manager.spawn(
            node.role,
            node,
            ContextPolicy(
                fact_ids=tuple(str(item) for item in context.get("fact_ids", ())),
                hypothesis_ids=tuple(str(item) for item in context.get("hypothesis_ids", ())),
                evidence_ids=tuple(str(item) for item in context.get("evidence_ids", ())),
                artifact_ids=tuple(str(item) for item in context.get("artifact_ids", ())),
            ),
            node.budget,
            WorkspacePolicy(mode="isolated", writable=node.role == "executor"),
        )
        joined = self.manager.join([agent_id], "first_success", timeout=node.budget.max_seconds + 1)
        summary = joined.summaries[0]
        event_type = EventType.PLAN_COMPLETED if summary.status == "completed" else EventType.PLAN_NODE_BLOCKED
        self.events.append(
            self.run_id,
            event_type,
            actor="coordinator",
            parent_event_id=started.event_id,
            agent_id=agent_id,
            task_id=task_id,
            payload={"task_id": task_id, "reason": summary.error, "summary": summary.to_dict()},
        )
        evidence_ids = tuple(
            str(item.get("evidence_id") or item.get("event_id"))
            for item in summary.evidence
            if item.get("evidence_id") or item.get("event_id")
        )
        return WorkflowResult(
            summary.status == "completed",
            summary.status,
            value=summary.to_dict(),
            evidence_ids=evidence_ids,
            metadata={"agent_id": agent_id, "verified": node.role == "verifier" and summary.status == "completed"},
        )


class CoordinatorSession:
    """Lifecycle authority for a declarative multi-agent workflow run."""

    def __init__(
        self,
        request: RunRequest,
        plan: Plan,
        workflow: WorkflowSpec,
        manager: SubagentManager,
        *,
        events: AppendOnlyEventStore | None = None,
        run_id: str | None = None,
        checkpoint_store: CheckpointStore | None = None,
    ) -> None:
        self.request = request
        self.plan = plan
        self.workflow = workflow
        self.manager = manager
        self.events = events or manager.events
        self.run_id = run_id or manager.run_id or f"run_{uuid.uuid4().hex}"
        if self.run_id != manager.run_id:
            raise ValueError("coordinator and subagent manager run ids must match")
        self.workspace = Path(request.workspace).expanduser().resolve()
        self.reducer = StateReducer()
        self.state = SessionState(self.run_id, request.objective)
        self.checkpoint_store = checkpoint_store or CheckpointStore(self.workspace / ".agent_state" / "checkpoints")
        self._abort = threading.Event()
        self._lock = threading.RLock()
        self.graph = TaskGraph(
            plan,
            allowed_roles=workflow.allowed_roles,
            available_tools=workflow.allowed_tools,
        )
        WorkflowValidator().validate(
            workflow,
            task_ids=set(self.graph.nodes),
            task_roles={task_id: node.role for task_id, node in self.graph.nodes.items()},
        )

    def run(self) -> SessionState:
        with self._lock:
            if self.state.status in TERMINAL_STATUSES:
                return self.state
            created = self._append(EventType.RUN_CREATED, "control_plane", {
                "task_id": self.request.task_id,
                "title": self.request.title,
                "scenario": self.request.scenario,
                "workspace": str(self.workspace),
                "engine": "v3_coordinator",
            })
            self._append(EventType.RUN_STARTED, "coordinator", {"workflow_id": self.workflow.workflow_id}, created.event_id)
            proposed = self._append(EventType.PLAN_PROPOSED, "planner", {
                "plan": self.plan.to_dict(), "reason": self.plan.rationale,
            })
            self._append(EventType.PLAN_ACCEPTED, "coordinator", {
                "plan": self.plan.to_dict(), "reason": "DAG, roles, tools, termination, and budget validated",
            }, proposed.event_id)
            self._save_checkpoint()

        if self._abort.is_set():
            return self._finish(RunStatus.CANCELLED, "coordinator cancelled", {})
        dispatcher = SubagentTaskDispatcher(self.run_id, self.plan, self.manager, self.events)
        result = WorkflowScheduler(dispatcher).execute(self.workflow)
        self.state = self.reducer.replay(self.run_id, self.request.objective, self.events.read(self.run_id))
        evidence_ids = self._evidence_ids(result)
        if self._abort.is_set():
            return self._finish(RunStatus.CANCELLED, "coordinator cancelled", {})
        if result.success and evidence_ids:
            return self._finish(
                RunStatus.SUCCEEDED,
                "workflow completed with evidence",
                {"workflow": self.workflow.workflow_id, "result": result.value, "evidence_ids": list(evidence_ids)},
            )
        handoff = {
            "completed_work": [item.summary.summary for item in self.manager.records() if item.summary],
            "confirmed_facts": list(self.state.confirmed_facts),
            "evidence": list(self.state.evidence),
            "failed_paths": [item.error for item in self.manager.records() if item.error],
            "minimal_blocker": "workflow did not produce independently verified evidence",
            "questions": [{
                "id": "coordinator_blocker",
                "type": "text",
                "question": "Provide the smallest missing input or select a revised strategy.",
            }],
            "recommended_next_step": "Resume blocked tasks from their subagent checkpoints.",
            "risk": "No final conclusion is accepted without evidence.",
            "checkpoint_sequence": self.state.last_event_sequence,
        }
        return self._finish(RunStatus.HUMAN_REQUIRED, handoff["minimal_blocker"], {"handoff": handoff})

    def abort(self, reason: str = "cancelled by user") -> bool:
        if self._abort.is_set():
            return False
        self._abort.set()
        for record in self.manager.records():
            self.manager.cancel(record.agent_id, reason)
        return True

    def event_stream(self, *, after_sequence: int = 0):
        return self.events.read(self.run_id, after_sequence=after_sequence)

    def _finish(self, status: RunStatus, reason: str, output: dict[str, Any]) -> SessionState:
        decided = self._append(EventType.COMPLETION_DECIDED, "completion_policy", {
            "status": status.value, "error": reason, "output": output,
        })
        event_type = {
            RunStatus.SUCCEEDED: EventType.RUN_SUCCEEDED,
            RunStatus.FAILED: EventType.RUN_FAILED,
            RunStatus.CANCELLED: EventType.RUN_CANCELLED,
            RunStatus.TIMED_OUT: EventType.RUN_TIMED_OUT,
            RunStatus.HUMAN_REQUIRED: EventType.HUMAN_REQUESTED,
        }[status]
        payload = {"status": status.value, "error": reason, "output": output}
        if "handoff" in output:
            payload["handoff"] = output["handoff"]
        self._append(event_type, "coordinator", payload, decided.event_id)
        self._save_checkpoint()
        return self.state

    def _append(
        self,
        event_type: EventType,
        actor: str,
        payload: dict[str, Any],
        parent_event_id: str | None = None,
    ):
        event = self.events.append(
            self.run_id,
            event_type,
            actor=actor,
            payload=payload,
            parent_event_id=parent_event_id,
            agent_id="agent_root",
            task_id=self.request.task_id,
        )
        self.reducer.apply(self.state, event)
        return event

    def _save_checkpoint(self) -> None:
        checkpoint = self._append(EventType.CHECKPOINT_SAVED, "coordinator", {
            "state_sequence": self.state.last_event_sequence,
        })
        self.checkpoint_store.save(CheckpointSnapshot(
            self.run_id,
            self.state.to_dict(),
            self.state.budget_usage,
            checkpoint.sequence,
        ))

    @staticmethod
    def _evidence_ids(result: WorkflowResult) -> tuple[str, ...]:
        values = list(result.evidence_ids)
        for child in result.children:
            values.extend(CoordinatorSession._evidence_ids(child))
        return tuple(dict.fromkeys(item for item in values if item))
