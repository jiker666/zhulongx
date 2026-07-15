from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any, Mapping

from app.agent_engine.agents.base import ContextPolicy, WorkspacePolicy
from app.agent_engine.abort import AbortToken
from app.agent_engine.artifacts.ingest import ArtifactIngestor
from app.agent_engine.budget import BudgetExceeded, BudgetTracker, BudgetUsage
from app.agent_engine.checkpoint import CheckpointSnapshot, CheckpointStore
from app.agent_engine.contracts.plan import Plan
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.scheduler import TaskDispatcher, WorkflowResult, WorkflowScheduler
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.orchestration.task_graph import TaskGraph
from app.agent_engine.orchestration.workflow import WorkflowSpec, WorkflowValidator
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.reducer import StateReducer
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.state import PAUSED_STATUSES, RunRequest, RunStatus, SessionState, TERMINAL_STATUSES
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolCall, ToolContext
from app.agent_engine.validation.base import Validator


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
        validator: Validator | None = None,
        registry: ToolRegistry | None = None,
        policy: PolicyEngine | None = None,
        sandbox: Sandbox | None = None,
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
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.reducer = StateReducer()
        self.state = SessionState(self.run_id, request.objective)
        self.checkpoint_store = checkpoint_store or CheckpointStore(self.workspace / ".agent_state" / "checkpoints")
        self.validator = validator
        self.registry = registry or build_builtin_registry()
        self.policy = policy or PolicyEngine()
        self.sandbox = sandbox or ContainerSandbox(
            self.workspace,
            readonly_paths=[item.path for item in request.inputs if item.readonly],
        )
        self.abort_token = AbortToken()
        self.budget = BudgetTracker(request.budgets)
        self.executor = ToolExecutionService(self.registry, self.policy, self.events)
        self._abort = threading.Event()
        self._timed_out = False
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

    @classmethod
    def resume(
        cls,
        request: RunRequest,
        plan: Plan,
        workflow: WorkflowSpec,
        manager: SubagentManager,
        *,
        events: AppendOnlyEventStore,
        run_id: str,
        checkpoint_store: CheckpointStore,
        validator: Validator | None = None,
        registry: ToolRegistry | None = None,
        policy: PolicyEngine | None = None,
        sandbox: Sandbox | None = None,
    ) -> "CoordinatorSession":
        snapshot = checkpoint_store.load(run_id)
        session = cls(
            request,
            plan,
            workflow,
            manager,
            events=events,
            run_id=run_id,
            checkpoint_store=checkpoint_store,
            validator=validator,
            registry=registry,
            policy=policy,
            sandbox=sandbox,
        )
        session.state = SessionState.from_dict(snapshot.state)
        session.budget = BudgetTracker(request.budgets, BudgetUsage.from_dict(snapshot.budget_usage))
        if session.state.last_event_sequence > events.last_sequence(run_id):
            raise ValueError("checkpoint references events that are not present")
        restored = events.append(
            run_id,
            EventType.CHECKPOINT_RESTORED,
            actor="coordinator",
            payload={"checkpoint_sequence": snapshot.event_offset},
            agent_id="agent_root",
            task_id=request.task_id,
        )
        session.reducer.apply(session.state, restored)
        return session

    def run(self) -> SessionState:
        with self._lock:
            if self.state.status in TERMINAL_STATUSES:
                return self.state
            if self.state.status in PAUSED_STATUSES:
                return self.state
            if self.state.status == RunStatus.CREATED:
                created = self._append(EventType.RUN_CREATED, "control_plane", {
                    "task_id": self.request.task_id,
                    "title": self.request.title,
                    "scenario": self.request.scenario,
                    "workspace": str(self.workspace),
                    "engine": "v3_coordinator",
                })
                started = self._append(
                    EventType.RUN_STARTED,
                    "coordinator",
                    {"workflow_id": self.workflow.workflow_id},
                    created.event_id,
                )
                self._ingest_inputs(started.event_id)
                proposed = self._append(EventType.PLAN_PROPOSED, "planner", {
                    "plan": self.plan.to_dict(), "reason": self.plan.rationale,
                })
                self._append(EventType.PLAN_ACCEPTED, "coordinator", {
                    "plan": self.plan.to_dict(), "reason": "DAG, roles, tools, termination, and budget validated",
                }, proposed.event_id)
                self._save_checkpoint()
            else:
                self._append(EventType.STATE_UPDATED, "coordinator", {
                    "changes": {"resumed": True, "checkpoint_sequence": self.state.last_event_sequence},
                })

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
        self.abort_token.abort(reason)
        for record in self.manager.records():
            self.manager.cancel(record.agent_id, reason)
        worker_abort = getattr(self.manager.worker, "abort_all", None)
        if callable(worker_abort):
            worker_abort(reason)
        self.sandbox.abort_all()
        if self.state.status not in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            self._finish(RunStatus.CANCELLED, reason, {})
        return True

    def pause_for_human(self, reason: str = "paused by operator") -> SessionState:
        if self.state.status in PAUSED_STATUSES:
            return self.state
        if self.state.status in TERMINAL_STATUSES:
            raise ValueError("terminal run cannot be paused")
        self._append(EventType.HUMAN_REQUESTED, "human", {
            "status": RunStatus.HUMAN_REQUIRED.value,
            "error": reason,
            "handoff": {"question": reason, "reason": "operator pause"},
        })
        self._persist_checkpoint()
        return self.state

    def answer_human(
        self,
        public_response: dict[str, object] | None = None,
        *,
        secure_input_refs: tuple[str, ...] = (),
    ) -> SessionState:
        if self.state.status != RunStatus.HUMAN_REQUIRED:
            raise ValueError("run is not waiting for human input")
        resume_status = (
            RunStatus.RUNNING
            if any(event.type == EventType.RUN_STARTED.value for event in self.event_stream())
            else RunStatus.CREATED
        )
        self._append(EventType.HUMAN_ANSWERED, "human", {
            "public_response": public_response or {},
            "secure_input_refs": list(secure_input_refs),
            "resume_status": resume_status.value,
        })
        self.state.error = ""
        self._save_checkpoint()
        return self.state

    def record_human_evidence(self, content: str) -> dict[str, object]:
        if self.state.status in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            raise ValueError("terminal run cannot accept evidence")
        value = content.strip()
        if not value:
            raise ValueError("human evidence is empty")
        evidence: dict[str, object] = {
            "evidence_id": f"human_{uuid.uuid4().hex}",
            "evidence_type": "human_observation",
            "summary": value[:20_000],
            "source_event_ids": [],
            "confidence": 1.0,
            "source": "human",
        }
        self._append(EventType.EVIDENCE_RECORDED, "human", {"evidence": evidence})
        self._persist_checkpoint()
        return evidence

    def record_hypothesis(self, hypothesis: dict[str, object]) -> dict[str, object]:
        if self.state.status in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            raise ValueError("terminal run cannot accept hypotheses")
        value = dict(hypothesis)
        value.setdefault("hypothesis_id", f"hyp_{uuid.uuid4().hex}")
        self._append(EventType.HYPOTHESIS_PROPOSED, "human", {"hypothesis": value})
        self._persist_checkpoint()
        return value

    def execute_tool(self, call: ToolCall):
        if self.state.status in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            raise ValueError("terminal run cannot execute tools")
        try:
            self.budget.check()
        except BudgetExceeded as exc:
            raise ValueError(str(exc)) from exc
        context = ToolContext(
            run_id=self.run_id,
            request=self.request,
            workspace=self.workspace,
            abort_token=self.abort_token,
            sandbox=self.sandbox,
        )
        execution = self.executor.execute(call, context, parent_event_id=self._last_event_id())
        if not execution.replayed:
            self.budget.record_tool_call()
        self.reducer.apply(self.state, execution.result_event)
        state_event_type = execution.result.metadata.get("state_event_type")
        state_event_payload = execution.result.metadata.get("state_event_payload")
        if execution.result.success and state_event_type and isinstance(state_event_payload, dict):
            self._append(EventType(str(state_event_type)), "state_tool", state_event_payload, execution.result_event.event_id)
        self.state.budget_usage = self.budget.usage.to_dict()
        self._persist_checkpoint()
        return execution

    def submit_external_validation(self, *, accepted: bool, reason: str) -> SessionState:
        if self.state.status != RunStatus.PENDING_EXTERNAL:
            raise ValueError("run has no candidate pending external validation")
        pending = next(
            (item for item in reversed(self.state.candidate_answers) if item.get("status") == "submitted_pending_external"),
            None,
        )
        if pending is None:
            raise ValueError("pending candidate is missing")
        event_type = EventType.CANDIDATE_EXTERNALLY_ACCEPTED if accepted else EventType.CANDIDATE_EXTERNALLY_REJECTED
        event = self._append(event_type, "external_validator", {
            "candidate": pending.get("candidate", ""),
            "reason": reason,
            "authoritative": True,
        })
        if accepted:
            return self._finish(
                RunStatus.SUCCEEDED,
                "external validator accepted candidate",
                {"candidate": pending.get("candidate", ""), "validation_level": "external"},
            )
        self._persist_checkpoint()
        return self.state

    def event_stream(self, *, after_sequence: int = 0):
        return self.events.read(self.run_id, after_sequence=after_sequence)

    def _finish(self, status: RunStatus, reason: str, output: dict[str, Any]) -> SessionState:
        if self.state.status in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            return self.state
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
        self._persist_checkpoint()
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
        self._persist_checkpoint(checkpoint.sequence)

    def _persist_checkpoint(self, event_offset: int | None = None) -> None:
        self.state.budget_usage = self.budget.usage.to_dict()
        self.checkpoint_store.save(CheckpointSnapshot(
            self.run_id,
            self.state.to_dict(),
            self.state.budget_usage,
            event_offset if event_offset is not None else self.state.last_event_sequence,
        ))

    def _ingest_inputs(self, parent_event_id: str) -> None:
        if any(event.type == EventType.ARTIFACT_INGESTED.value for event in self.event_stream()):
            return
        ingestor = ArtifactIngestor(self.workspace)
        previous = parent_event_id
        for item in self.request.inputs:
            try:
                artifact = ingestor.ingest(item.path, visibility="run")
            except (OSError, ValueError):
                continue
            event = self._append(
                EventType.ARTIFACT_INGESTED,
                "artifact_ingestor",
                {"artifact": artifact.to_dict()},
                previous,
            )
            previous = event.event_id

    def _last_event_id(self) -> str | None:
        events = self.events.read(self.run_id)
        return events[-1].event_id if events else None

    @staticmethod
    def _evidence_ids(result: WorkflowResult) -> tuple[str, ...]:
        values = list(result.evidence_ids)
        for child in result.children:
            values.extend(CoordinatorSession._evidence_ids(child))
        return tuple(dict.fromkeys(item for item in values if item))
