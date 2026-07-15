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
from app.agent_engine.contracts.completion import CompletionDecision
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.hooks import HookContext, HookPipeline
from app.agent_engine.orchestration.completion_policy import CoordinatorCompletionPolicy
from app.agent_engine.orchestration.dynamic_scheduler import DynamicTaskScheduler, SchedulerOutcome
from app.agent_engine.orchestration.graph_replanner import EvidenceDrivenGraphReplanner
from app.agent_engine.orchestration.planner import DynamicPlanner, PlanningError
from app.agent_engine.orchestration.scheduler import TaskDispatcher, WorkflowResult, WorkflowScheduler
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.orchestration.task_graph import TaskGraph
from app.agent_engine.orchestration.task_graph_store import PlanPatch, TaskGraphStore
from app.agent_engine.orchestration.workflow import WorkflowSpec, WorkflowValidator
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import ProviderError
from app.agent_engine.reducer import StateReducer
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.state import PAUSED_STATUSES, RunRequest, RunStatus, SessionState, TERMINAL_STATUSES
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.resource_locks import ResourceLockManager
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
        dynamic_planner: DynamicPlanner | None = None,
        graph_replanner: EvidenceDrivenGraphReplanner | None = None,
        completion_policy: CoordinatorCompletionPolicy | None = None,
        hooks: HookPipeline | None = None,
        resource_locks: ResourceLockManager | None = None,
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
        self.dynamic_planner = dynamic_planner
        self.graph_replanner = graph_replanner or EvidenceDrivenGraphReplanner()
        self.completion_policy = completion_policy
        self.hooks = hooks or HookPipeline()
        self.resource_locks = resource_locks or ResourceLockManager()
        self.executor = ToolExecutionService(
            self.registry,
            self.policy,
            self.events,
            hooks=self.hooks,
            resource_locks=self.resource_locks,
        )
        self.dynamic_scheduler: DynamicTaskScheduler | None = None
        self._abort = threading.Event()
        self._timed_out = False
        self._lock = threading.RLock()
        self.graph = TaskGraph(
            plan,
            allowed_roles=workflow.allowed_roles,
            available_tools=workflow.allowed_tools,
        )
        self.graph_store = TaskGraphStore(
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
        dynamic_planner: DynamicPlanner | None = None,
        graph_replanner: EvidenceDrivenGraphReplanner | None = None,
        completion_policy: CoordinatorCompletionPolicy | None = None,
        hooks: HookPipeline | None = None,
        resource_locks: ResourceLockManager | None = None,
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
            dynamic_planner=dynamic_planner,
            graph_replanner=graph_replanner,
            completion_policy=completion_policy,
            hooks=hooks,
            resource_locks=resource_locks,
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
        session.state = session.reducer.replay(
            run_id,
            request.objective,
            events.read(run_id),
        )
        if session.state.current_plan:
            restored_plan = Plan.from_dict(session.state.current_plan)
            session.plan = restored_plan
            session.graph_store = TaskGraphStore(
                restored_plan,
                allowed_roles=workflow.allowed_roles,
                available_tools=workflow.allowed_tools,
            )
            session.graph = session.graph_store.graph
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
                plan_source = "scenario_macro"
                if self.dynamic_planner is not None:
                    try:
                        planner_result = self.dynamic_planner.propose(
                            self.request,
                            self.plan,
                            self.events,
                            self.run_id,
                            self.abort_token,
                        )
                    except (PlanningError, ProviderError, ValueError) as exc:
                        self.state = self.reducer.replay(
                            self.run_id,
                            self.request.objective,
                            self.events.read(self.run_id),
                        )
                        handoff = self._human_handoff(f"dynamic planner failed: {type(exc).__name__}")
                        return self._finish(RunStatus.HUMAN_REQUIRED, handoff["minimal_blocker"], {"handoff": handoff})
                    self.plan = planner_result.plan
                    self.graph_store = TaskGraphStore(
                        self.plan,
                        allowed_roles=self.workflow.allowed_roles,
                        available_tools=self.workflow.allowed_tools,
                        max_total_tool_calls=max(
                            self.request.budgets.max_tool_calls,
                            sum(node.budget.max_tool_calls for node in self.plan.nodes),
                        ),
                    )
                    self.graph = self.graph_store.graph
                    plan_source = planner_result.source
                    self.state = self.reducer.replay(
                        self.run_id,
                        self.request.objective,
                        self.events.read(self.run_id),
                    )
                proposed = self._append(EventType.PLAN_PROPOSED, "planner", {
                    "plan": self.plan.to_dict(), "reason": self.plan.rationale, "source": plan_source,
                })
                self._append(EventType.PLAN_ACCEPTED, "coordinator", {
                    "plan": self.plan.to_dict(),
                    "reason": "DAG, roles, tools, completion contract, and aggregate budget validated",
                    "source": plan_source,
                }, proposed.event_id)
                self._save_checkpoint()
            else:
                self._append(EventType.STATE_UPDATED, "coordinator", {
                    "changes": {"resumed": True, "checkpoint_sequence": self.state.last_event_sequence},
                })

        if self._abort.is_set():
            status = RunStatus.TIMED_OUT if self._timed_out else RunStatus.CANCELLED
            return self._finish(status, "coordinator deadline exceeded" if self._timed_out else "coordinator cancelled", {})
        remaining_seconds = max(0.01, self.request.budgets.max_seconds - self.budget.usage.elapsed_seconds)
        deadline = threading.Timer(remaining_seconds, self._timeout_abort)
        deadline.daemon = True
        deadline.start()
        try:
            if self.dynamic_planner is not None:
                return self._run_dynamic()
            return self._run_static()
        finally:
            deadline.cancel()

    def _run_static(self) -> SessionState:
        dispatcher = SubagentTaskDispatcher(self.run_id, self.plan, self.manager, self.events)
        result = WorkflowScheduler(dispatcher).execute(self.workflow)
        self.state = self.reducer.replay(self.run_id, self.request.objective, self.events.read(self.run_id))
        evidence_ids = self._evidence_ids(result)
        if self._abort.is_set():
            status = RunStatus.TIMED_OUT if self._timed_out else RunStatus.CANCELLED
            return self._finish(status, "coordinator deadline exceeded" if self._timed_out else "coordinator cancelled", {})
        if result.success and evidence_ids:
            return self._finish(
                RunStatus.SUCCEEDED,
                "workflow completed with evidence",
                {"workflow": self.workflow.workflow_id, "result": result.value, "evidence_ids": list(evidence_ids)},
            )
        handoff = self._human_handoff("workflow did not produce independently verified evidence")
        return self._finish(RunStatus.HUMAN_REQUIRED, handoff["minimal_blocker"], {"handoff": handoff})

    def _run_dynamic(self) -> SessionState:
        self.dynamic_scheduler = self.dynamic_scheduler or DynamicTaskScheduler(
            self.run_id,
            self.graph_store.graph,
            self.manager,
            self.events,
            max_concurrency=self.request.max_parallel_agents,
            abort_token=self.abort_token,
        )
        for _revision_attempt in range(4):
            outcome = self.dynamic_scheduler.execute_until_blocked()
            self.state = self.reducer.replay(self.run_id, self.request.objective, self.events.read(self.run_id))
            self._persist_checkpoint()
            if self._abort.is_set():
                status = RunStatus.TIMED_OUT if self._timed_out else RunStatus.CANCELLED
                return self._finish(
                    status,
                    "coordinator deadline exceeded" if self._timed_out else "coordinator cancelled",
                    {},
                )
            if not outcome.success:
                replan = self.graph_replanner.propose(self.graph_store, outcome)
                if replan.patch is None:
                    handoff = self._human_handoff(replan.reason)
                    return self._finish(RunStatus.HUMAN_REQUIRED, handoff["minimal_blocker"], {"handoff": handoff})
                self._apply_patch(replan.patch, outcome)
                continue
            if self.completion_policy is None:
                handoff = self._human_handoff("dynamic completion policy is not configured")
                return self._finish(RunStatus.HUMAN_REQUIRED, handoff["minimal_blocker"], {"handoff": handoff})
            decision = self.completion_policy.decide(
                self.request,
                self.graph_store.plan,
                outcome,
                self.state,
                self.events,
                self.workspace,
            )
            self.state = self.reducer.replay(self.run_id, self.request.objective, self.events.read(self.run_id))
            if decision.status == "succeeded":
                return self._finish(RunStatus.SUCCEEDED, decision.reason, decision.output or {})
            if decision.status == "pending_external":
                output = decision.output or {}
                self._append(EventType.CANDIDATE_PENDING_EXTERNAL, "completion_policy", {
                    "candidate": output.get("candidate", ""),
                    "reason": decision.reason,
                    "authoritative": False,
                })
                return self._finish(RunStatus.PENDING_EXTERNAL, decision.reason, output)
            replan_task_id = self._completion_replan_task(decision, outcome)
            if not replan_task_id:
                handoff = self._human_handoff(decision.reason)
                return self._finish(RunStatus.HUMAN_REQUIRED, handoff["minimal_blocker"], {"handoff": handoff})
            synthetic = SchedulerOutcome(
                False,
                outcome.completed_task_ids,
                (replan_task_id,),
                outcome.cancelled_task_ids,
                outcome.summaries,
                outcome.evidence_ids,
                decision.reason,
            )
            replan = self.graph_replanner.propose(self.graph_store, synthetic)
            if replan.patch is None:
                handoff = self._human_handoff(replan.reason)
                return self._finish(RunStatus.HUMAN_REQUIRED, handoff["minimal_blocker"], {"handoff": handoff})
            self._apply_patch(replan.patch, synthetic)
        handoff = self._human_handoff("dynamic replanning limit reached")
        return self._finish(RunStatus.HUMAN_REQUIRED, handoff["minimal_blocker"], {"handoff": handoff})

    def _apply_patch(self, patch: PlanPatch, outcome: SchedulerOutcome) -> None:
        self.hooks.run("before_plan_patch", self._hook_context({
            "reason": patch.reason,
            "operation_count": len(patch.operations),
            "evidence_refs": list(patch.evidence_refs),
        }))
        proposed = self._append(EventType.PLAN_PATCH_PROPOSED, "replanner", {
            "patch": patch.model_dump(),
            "reason": patch.reason,
            "evidence_refs": list(patch.evidence_refs),
            "old_version": self.graph_store.plan.version,
        })
        accepted_evidence = {
            str(evidence_id)
            for candidate in self.state.candidate_answers
            if candidate.get("status") in {"validated", "externally_accepted"}
            for evidence_id in candidate.get("evidence_event_ids", ())
        }
        protected = {
            event.task_id
            for event in self.events.read(self.run_id)
            if event.event_id in accepted_evidence and event.task_id
        }
        revision = self.graph_store.apply(
            patch,
            protected_task_ids=protected,
            completed_task_ids=set(outcome.completed_task_ids),
            failed_task_ids=set(outcome.failed_task_ids),
        )
        self.plan = revision.plan
        self.graph = self.graph_store.graph
        self._append(EventType.PLAN_REVISED, "replanner", {
            "plan": revision.plan.to_dict(),
            "reason": revision.reason,
            "old_version": revision.old_version,
            "new_version": revision.new_version,
            "diff": list(revision.diff),
            "evidence_refs": list(revision.evidence_refs),
        }, proposed.event_id)
        assert self.dynamic_scheduler is not None
        self.dynamic_scheduler.update_graph(self.graph)
        self._save_checkpoint()

    def _completion_replan_task(self, decision: CompletionDecision, outcome: SchedulerOutcome) -> str:
        preferred_role = "verifier" if decision.status == "rejected" else "synthesizer"
        candidates = [
            node for node in self.graph_store.plan.nodes
            if node.role == preferred_role and node.task_id in outcome.completed_task_ids
        ]
        if not candidates and preferred_role != "verifier":
            candidates = [
                node for node in self.graph_store.plan.nodes
                if node.role == "verifier" and node.task_id in outcome.completed_task_ids
            ]
        return candidates[-1].task_id if candidates else ""

    def _human_handoff(self, blocker: str) -> dict[str, Any]:
        return {
            "completed_work": [item.summary.summary for item in self.manager.records() if item.summary],
            "confirmed_facts": list(self.state.confirmed_facts),
            "evidence": list(self.state.evidence),
            "failed_paths": [item.error for item in self.manager.records() if item.error],
            "minimal_blocker": blocker,
            "questions": [{
                "id": "coordinator_blocker",
                "type": "text",
                "question": "Provide the smallest missing input or select a revised strategy.",
            }],
            "recommended_next_step": "Resume blocked tasks from their subagent checkpoints.",
            "risk": "No final conclusion is accepted without evidence.",
            "checkpoint_sequence": self.state.last_event_sequence,
        }

    def abort(self, reason: str = "cancelled by user") -> bool:
        if self._abort.is_set():
            return False
        had_active_children = any(record.status in {"queued", "running"} for record in self.manager.records())
        self._abort.set()
        self.abort_token.abort(reason)
        self.hooks.run("on_abort", self._hook_context({"reason": reason}))
        for record in self.manager.records():
            self.manager.cancel(record.agent_id, reason)
        worker_abort = getattr(self.manager.worker, "abort_all", None)
        if callable(worker_abort):
            worker_abort(reason)
        self.sandbox.abort_all()
        if not had_active_children and self.state.status not in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            self._finish(RunStatus.CANCELLED, reason, {})
        return True

    def _timeout_abort(self) -> None:
        if self._abort.is_set():
            return
        self._timed_out = True
        self._abort.set()
        self.abort_token.abort("coordinator deadline exceeded")
        self.hooks.run("on_abort", self._hook_context({"reason": "coordinator deadline exceeded"}))
        for record in self.manager.records():
            self.manager.cancel(record.agent_id, "coordinator deadline exceeded")
        worker_abort = getattr(self.manager.worker, "abort_all", None)
        if callable(worker_abort):
            worker_abort("coordinator deadline exceeded")
        self.sandbox.abort_all()

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
        self.hooks.run("before_completion", self._hook_context({
            "status": status.value,
            "evidence_count": len(self.state.evidence),
        }))
        decided = self._append(EventType.COMPLETION_DECIDED, "completion_policy", {
            "status": status.value, "error": reason, "output": output,
        })
        if status == RunStatus.PENDING_EXTERNAL:
            self._persist_checkpoint()
            return self.state
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
        self.hooks.run("on_checkpoint", self._hook_context({
            "event_offset": event_offset if event_offset is not None else self.state.last_event_sequence,
        }))

    def _hook_context(self, data: dict[str, object]) -> HookContext:
        return HookContext(
            self.run_id,
            self.request.task_id,
            "agent_root",
            "coordinator",
            data,
        )

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
