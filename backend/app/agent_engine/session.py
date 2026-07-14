from __future__ import annotations

import threading
import uuid
from pathlib import Path

from app.agent_engine.abort import AbortToken, RunAborted
from app.agent_engine.artifacts.ingest import ArtifactIngestor
from app.agent_engine.budget import BudgetExceeded, BudgetTracker, BudgetUsage
from app.agent_engine.checkpoint import CheckpointSnapshot, CheckpointStore
from app.agent_engine.context import ContextBuilder
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.loop import AgentLoop, LoopOutcome
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.reducer import StateReducer
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.skills.index import SkillIndex
from app.agent_engine.skills.loader import SkillLoader
from app.agent_engine.state import PAUSED_STATUSES, RunRequest, RunStatus, SessionState, TERMINAL_STATUSES
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolCall, ToolContext
from app.agent_engine.validation.base import Validator


class AgentSession:
    """The sole lifecycle and terminal-state owner for one Agent Engine v3 run."""

    def __init__(
        self,
        request: RunRequest,
        *,
        provider: ModelProvider,
        validator: Validator,
        events: AppendOnlyEventStore | None = None,
        registry: ToolRegistry | None = None,
        policy: PolicyEngine | None = None,
        sandbox: Sandbox | None = None,
        run_id: str | None = None,
        checkpoint_store: CheckpointStore | None = None,
        skill_index: SkillIndex | None = None,
        skill_loader: SkillLoader | None = None,
    ) -> None:
        self.request = request
        self.run_id = run_id or f"run_{uuid.uuid4().hex}"
        self.workspace = Path(request.workspace).expanduser().resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.events = events or AppendOnlyEventStore()
        self.skill_index = skill_index
        self.skill_loader = skill_loader
        self.registry = registry or build_builtin_registry(skill_loader)
        self.policy = policy or PolicyEngine()
        self.sandbox = sandbox or ContainerSandbox(
            self.workspace,
            readonly_paths=[item.path for item in request.inputs if item.readonly],
        )
        self.provider = provider
        self.validator = validator
        self.abort_token = AbortToken()
        self._timed_out = False
        self.budget = BudgetTracker(request.budgets)
        self.reducer = StateReducer()
        self.state = SessionState(run_id=self.run_id, objective=request.objective)
        self.checkpoint_store = checkpoint_store or CheckpointStore(self.workspace / ".agent_state" / "checkpoints")
        self.executor = ToolExecutionService(self.registry, self.policy, self.events)
        self.loop = AgentLoop(
            provider=self.provider,
            registry=self.registry,
            executor=self.executor,
            validator=self.validator,
            context_builder=ContextBuilder(skill_index=skill_index),
            reducer=self.reducer,
            checkpoint_callback=self._save_checkpoint,
        )

    @classmethod
    def resume(
        cls,
        request: RunRequest,
        *,
        run_id: str,
        provider: ModelProvider,
        validator: Validator,
        events: AppendOnlyEventStore,
        checkpoint_store: CheckpointStore,
        registry: ToolRegistry | None = None,
        policy: PolicyEngine | None = None,
        sandbox: Sandbox | None = None,
        skill_index: SkillIndex | None = None,
        skill_loader: SkillLoader | None = None,
    ) -> "AgentSession":
        snapshot = checkpoint_store.load(run_id)
        session = cls(
            request,
            provider=provider,
            validator=validator,
            events=events,
            registry=registry,
            policy=policy,
            sandbox=sandbox,
            run_id=run_id,
            checkpoint_store=checkpoint_store,
            skill_index=skill_index,
            skill_loader=skill_loader,
        )
        session.state = SessionState.from_dict(snapshot.state)
        session.budget = BudgetTracker(request.budgets, BudgetUsage.from_dict(snapshot.budget_usage))
        if session.state.last_event_sequence > events.last_sequence(run_id):
            raise ValueError("checkpoint references events that are not present")
        restored = events.append(
            run_id,
            EventType.CHECKPOINT_RESTORED,
            actor="agent_session",
            payload={"checkpoint_sequence": snapshot.event_offset},
            agent_id="agent_root",
            task_id=request.task_id,
        )
        session.reducer.apply(session.state, restored)
        return session

    def run(self) -> SessionState:
        if self.state.status in TERMINAL_STATUSES:
            return self.state
        if self.state.status in PAUSED_STATUSES:
            return self.state
        if self.state.status == RunStatus.CREATED:
            created = self._append(
                EventType.RUN_CREATED,
                actor="control_plane",
                payload={
                    "task_id": self.request.task_id,
                    "title": self.request.title,
                    "scenario": self.request.scenario,
                    "workspace": str(self.workspace),
                },
            )
            if self.abort_token.is_aborted:
                return self._finish(LoopOutcome(RunStatus.CANCELLED, self.abort_token.reason), created.event_id)
            started = self._append(
                EventType.RUN_STARTED,
                actor="agent_session",
                parent_event_id=created.event_id,
                payload={"sandbox": type(self.sandbox).__name__, "release_capable": self.sandbox.release_capable},
            )
            self._ingest_inputs(started.event_id)
            self._ensure_initial_plan(started.event_id)
            self._save_checkpoint()
        else:
            self._append(
                EventType.STATE_UPDATED,
                actor="agent_session",
                payload={"changes": {"resumed": True, "checkpoint_sequence": self.state.last_event_sequence}},
            )
        tool_context = ToolContext(
            run_id=self.run_id,
            request=self.request,
            workspace=self.workspace,
            abort_token=self.abort_token,
            sandbox=self.sandbox,
        )
        remaining_seconds = max(0.01, self.request.budgets.max_seconds - self.budget.usage.elapsed_seconds)
        deadline = threading.Timer(remaining_seconds, self._timeout_abort)
        deadline.daemon = True
        deadline.start()
        try:
            try:
                outcome = self.loop.run(
                    self.request,
                    self.state,
                    self.events,
                    self.budget,
                    self.abort_token,
                    tool_context,
                )
            except RunAborted as exc:
                status = RunStatus.TIMED_OUT if self._timed_out else RunStatus.CANCELLED
                outcome = LoopOutcome(status, str(exc))
            except BudgetExceeded as exc:
                self._append(
                    EventType.BUDGET_EXCEEDED,
                    actor="budget_tracker",
                    payload={"dimension": exc.dimension, "usage": self.budget.usage.to_dict()},
                )
                status = RunStatus.TIMED_OUT if exc.dimension == "time" else RunStatus.HUMAN_REQUIRED
                output = None
                if status == RunStatus.HUMAN_REQUIRED:
                    output = {
                        "handoff": self.loop._human_handoff(
                            self.state,
                            "Increase the exhausted budget or choose a narrower strategy.",
                            str(exc),
                        )
                    }
                outcome = LoopOutcome(status, str(exc), output)
            except Exception as exc:
                outcome = LoopOutcome(RunStatus.FAILED, f"{type(exc).__name__}: {exc}")
        finally:
            deadline.cancel()
        return self._finish(outcome, self._last_event_id())

    def abort(self, reason: str = "cancelled by user") -> bool:
        changed = self.abort_token.abort(reason)
        self.sandbox.abort_all()
        if changed and self.state.status not in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            self._append(
                EventType.RUN_CANCELLED,
                actor="control_plane",
                payload={"status": RunStatus.CANCELLED.value, "error": reason, "output": {}},
            )
            self._persist_checkpoint()
        return changed

    def pause_for_human(self, reason: str = "paused by operator") -> SessionState:
        if self.state.status in PAUSED_STATUSES:
            return self.state
        if self.state.status in TERMINAL_STATUSES:
            raise ValueError("terminal run cannot be paused")
        self._append(
            EventType.HUMAN_REQUESTED,
            actor="human",
            payload={
                "status": RunStatus.HUMAN_REQUIRED.value,
                "error": reason,
                "handoff": {"question": reason, "reason": "operator pause"},
            },
        )
        self._persist_checkpoint()
        return self.state

    def record_human_evidence(self, content: str) -> dict[str, object]:
        if self.state.status in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            raise ValueError("terminal run cannot accept evidence")
        value = content.strip()
        if not value:
            raise ValueError("human evidence is empty")
        evidence = {
            "evidence_id": f"human_{uuid.uuid4().hex}",
            "evidence_type": "human_observation",
            "summary": value[:20_000],
            "source_event_ids": [],
            "confidence": 1.0,
            "source": "human",
        }
        self._append(EventType.EVIDENCE_RECORDED, actor="human", payload={"evidence": evidence})
        self._persist_checkpoint()
        return evidence

    def record_hypothesis(self, hypothesis: dict[str, object]) -> dict[str, object]:
        if self.state.status in TERMINAL_STATUSES - {RunStatus.HUMAN_REQUIRED}:
            raise ValueError("terminal run cannot accept hypotheses")
        value = dict(hypothesis)
        value.setdefault("hypothesis_id", f"hyp_{uuid.uuid4().hex}")
        self._append(EventType.HYPOTHESIS_PROPOSED, actor="human", payload={"hypothesis": value})
        self._persist_checkpoint()
        return value

    def execute_tool(self, call: ToolCall):
        """Execute an operator-requested tool through the canonical policy/event path."""
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
            self._append(
                EventType(str(state_event_type)),
                actor="state_tool",
                parent_event_id=execution.result_event.event_id,
                payload=state_event_payload,
            )
        self.state.budget_usage = self.budget.usage.to_dict()
        self._persist_checkpoint()
        return execution

    def _timeout_abort(self) -> None:
        self._timed_out = True
        self.abort_token.abort("run exceeded time budget")
        self.sandbox.abort_all()

    def event_stream(self, *, after_sequence: int = 0):
        return self.events.read(self.run_id, after_sequence=after_sequence)

    def _finish(self, outcome: LoopOutcome, parent_event_id: str | None) -> SessionState:
        if self.state.status in TERMINAL_STATUSES:
            return self.state
        active_node = next(
            (node for node in self.state.current_plan.get("nodes", []) if node.get("status") == "running"),
            None,
        )
        if active_node:
            plan_event_type = EventType.PLAN_COMPLETED if outcome.status == RunStatus.SUCCEEDED else EventType.PLAN_NODE_BLOCKED
            plan_event = self._append(
                plan_event_type,
                actor="agent_session",
                parent_event_id=parent_event_id,
                payload={"task_id": active_node.get("task_id"), "reason": outcome.error},
            )
            parent_event_id = plan_event.event_id
        decided = self._append(
            EventType.COMPLETION_DECIDED,
            actor="completion_policy",
            parent_event_id=parent_event_id,
            payload={"status": outcome.status.value, "error": outcome.error, "output": outcome.output or {}},
        )
        if outcome.status == RunStatus.PENDING_EXTERNAL:
            self.state.status = RunStatus.PENDING_EXTERNAL
            self._persist_checkpoint()
            return self.state
        event_type = {
            RunStatus.SUCCEEDED: EventType.RUN_SUCCEEDED,
            RunStatus.FAILED: EventType.RUN_FAILED,
            RunStatus.CANCELLED: EventType.RUN_CANCELLED,
            RunStatus.TIMED_OUT: EventType.RUN_TIMED_OUT,
            RunStatus.HUMAN_REQUIRED: EventType.HUMAN_REQUESTED,
        }[outcome.status]
        payload = {"status": outcome.status.value, "error": outcome.error, "output": outcome.output or {}}
        if outcome.output and isinstance(outcome.output.get("handoff"), dict):
            payload["handoff"] = outcome.output["handoff"]
        self._append(
            event_type,
            actor="agent_session",
            parent_event_id=decided.event_id,
            payload=payload,
        )
        self.state.budget_usage = self.budget.usage.to_dict()
        self._persist_checkpoint()
        return self.state

    def _last_event_id(self) -> str | None:
        events = self.events.read(self.run_id)
        return events[-1].event_id if events else None

    def _save_checkpoint(self) -> None:
        self._append(
            EventType.CHECKPOINT_SAVED,
            actor="agent_session",
            parent_event_id=self._last_event_id(),
            payload={"state_sequence": self.state.last_event_sequence},
        )
        self.state.budget_usage = self.budget.usage.to_dict()
        self._persist_checkpoint()

    def _persist_checkpoint(self) -> None:
        self.checkpoint_store.save(CheckpointSnapshot(
            run_id=self.run_id,
            state=self.state.to_dict(),
            budget_usage=self.state.budget_usage,
            event_offset=self.state.last_event_sequence,
        ))

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
        self._append(
            EventType.HUMAN_ANSWERED,
            actor="human",
            payload={
                "public_response": public_response or {},
                "secure_input_refs": list(secure_input_refs),
                "resume_status": resume_status.value,
            },
        )
        self.state.error = ""
        self._save_checkpoint()
        return self.state

    def submit_external_validation(self, *, accepted: bool, reason: str) -> SessionState:
        if self.state.status != RunStatus.PENDING_EXTERNAL:
            raise ValueError("run has no candidate pending external validation")
        pending = next(
            (item for item in reversed(self.state.candidate_answers) if item.get("status") == "submitted_pending_external"),
            None,
        )
        if pending is None:
            raise ValueError("pending candidate is missing")
        event_type = (
            EventType.CANDIDATE_EXTERNALLY_ACCEPTED if accepted else EventType.CANDIDATE_EXTERNALLY_REJECTED
        )
        event = self._append(
            event_type,
            actor="external_validator",
            payload={
                "candidate": pending.get("candidate", ""),
                "reason": reason,
                "authoritative": True,
            },
        )
        if accepted:
            return self._finish(
                LoopOutcome(
                    RunStatus.SUCCEEDED,
                    output={
                        "candidate": pending.get("candidate", ""),
                        "validation_level": "external",
                    },
                ),
                event.event_id,
            )
        self._save_checkpoint()
        return self.state

    def _append(
        self,
        event_type: EventType,
        *,
        actor: str,
        payload: dict[str, object] | None = None,
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
                actor="artifact_ingestor",
                parent_event_id=previous,
                payload={"artifact": artifact.to_dict()},
            )
            previous = event.event_id

    def _ensure_initial_plan(self, parent_event_id: str) -> None:
        if self.state.current_plan:
            return
        task_id = f"{self.request.task_id}:execute"
        plan = {
            "plan_id": f"plan_{self.run_id}",
            "version": 1,
            "goal": self.request.objective,
            "nodes": [{
                "task_id": task_id,
                "title": "Execute the scenario strategy and collect evidence",
                "role": "executor",
                "dependencies": [],
                "expected_output": "evidence-backed candidate or structured handoff",
                "success_criteria": ["completion policy accepts evidence-backed output"],
                "allowed_tools": [definition.name for definition in self.registry.definitions()],
                "status": "pending",
            }],
            "alternatives": ["review_refute", "switch_hypothesis"],
            "risks": ["budget exhaustion", "insufficient evidence"],
            "assumptions": [],
            "unknowns": [],
            "critical_path": [task_id],
            "rationale": "start with one bounded evidence-driven execution before replanning",
            "revision_reason": "",
        }
        proposed = self._append(
            EventType.PLAN_PROPOSED,
            actor="planner",
            parent_event_id=parent_event_id,
            payload={"plan": plan, "reason": plan["rationale"]},
        )
        accepted = self._append(
            EventType.PLAN_ACCEPTED,
            actor="coordinator",
            parent_event_id=proposed.event_id,
            payload={"plan": plan, "reason": "validated initial bounded plan"},
        )
        self._append(
            EventType.PLAN_NODE_STARTED,
            actor="coordinator",
            parent_event_id=accepted.event_id,
            payload={"task_id": task_id},
        )
