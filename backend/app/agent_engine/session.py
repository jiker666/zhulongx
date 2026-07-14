from __future__ import annotations

import threading
import uuid
from pathlib import Path

from app.agent_engine.abort import AbortToken, RunAborted
from app.agent_engine.budget import BudgetExceeded, BudgetTracker, BudgetUsage
from app.agent_engine.checkpoint import CheckpointSnapshot, CheckpointStore
from app.agent_engine.context import ContextBuilder
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.loop import AgentLoop, LoopOutcome
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.skills.index import SkillIndex
from app.agent_engine.skills.loader import SkillLoader
from app.agent_engine.state import RunRequest, RunStatus, SessionState, TERMINAL_STATUSES
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolContext
from app.agent_engine.validation.base import Validator


class AgentSession:
    """The sole lifecycle and terminal-state owner for one v2 run."""

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
        self.state = SessionState(run_id=self.run_id, objective=request.objective)
        self.checkpoint_store = checkpoint_store or CheckpointStore(self.workspace / ".agent_state" / "checkpoints")
        self.executor = ToolExecutionService(self.registry, self.policy, self.events)
        self.loop = AgentLoop(
            provider=self.provider,
            registry=self.registry,
            executor=self.executor,
            validator=self.validator,
            context_builder=ContextBuilder(skill_index=skill_index),
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
        return session

    def run(self) -> SessionState:
        if self.state.status in TERMINAL_STATUSES:
            return self.state
        if self.state.status == RunStatus.CREATED:
            created = self.events.append(
                self.run_id,
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
            started = self.events.append(
                self.run_id,
                EventType.RUN_STARTED,
                actor="agent_session",
                parent_event_id=created.event_id,
                payload={"sandbox": type(self.sandbox).__name__, "release_capable": self.sandbox.release_capable},
            )
            self.state.status = RunStatus.RUNNING
            self.state.last_event_sequence = started.sequence
            self._save_checkpoint()
        else:
            resumed = self.events.append(
                self.run_id,
                EventType.STATE_UPDATED,
                actor="agent_session",
                payload={"changes": {"resumed": True, "checkpoint_sequence": self.state.last_event_sequence}},
            )
            self.state.last_event_sequence = resumed.sequence
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
                status = RunStatus.TIMED_OUT if exc.dimension == "time" else RunStatus.HUMAN_REQUIRED
                outcome = LoopOutcome(status, str(exc))
            except Exception as exc:
                outcome = LoopOutcome(RunStatus.FAILED, f"{type(exc).__name__}: {exc}")
        finally:
            deadline.cancel()
        return self._finish(outcome, self._last_event_id())

    def abort(self, reason: str = "cancelled by user") -> bool:
        changed = self.abort_token.abort(reason)
        self.sandbox.abort_all()
        return changed

    def _timeout_abort(self) -> None:
        self._timed_out = True
        self.abort_token.abort("run exceeded time budget")
        self.sandbox.abort_all()

    def event_stream(self, *, after_sequence: int = 0):
        return self.events.read(self.run_id, after_sequence=after_sequence)

    def _finish(self, outcome: LoopOutcome, parent_event_id: str | None) -> SessionState:
        if self.state.status in TERMINAL_STATUSES:
            return self.state
        self.state.status = outcome.status
        self.state.error = outcome.error
        self.state.final_output = outcome.output
        event_type = {
            RunStatus.SUCCEEDED: EventType.RUN_SUCCEEDED,
            RunStatus.FAILED: EventType.RUN_FAILED,
            RunStatus.CANCELLED: EventType.RUN_CANCELLED,
            RunStatus.TIMED_OUT: EventType.RUN_TIMED_OUT,
            RunStatus.HUMAN_REQUIRED: EventType.HUMAN_REQUESTED,
        }[outcome.status]
        terminal = self.events.append(
            self.run_id,
            event_type,
            actor="agent_session",
            parent_event_id=parent_event_id,
            payload={"status": outcome.status.value, "error": outcome.error, "output": outcome.output or {}},
        )
        self.state.last_event_sequence = terminal.sequence
        self.state.budget_usage = self.budget.usage.to_dict()
        self.checkpoint_store.save(CheckpointSnapshot(
            run_id=self.run_id,
            state=self.state.to_dict(),
            budget_usage=self.state.budget_usage,
            event_offset=self.state.last_event_sequence,
        ))
        return self.state

    def _last_event_id(self) -> str | None:
        events = self.events.read(self.run_id)
        return events[-1].event_id if events else None

    def _save_checkpoint(self) -> None:
        checkpoint_event = self.events.append(
            self.run_id,
            EventType.CHECKPOINT_SAVED,
            actor="agent_session",
            parent_event_id=self._last_event_id(),
            payload={"state_sequence": self.state.last_event_sequence},
        )
        self.state.last_event_sequence = checkpoint_event.sequence
        self.state.budget_usage = self.budget.usage.to_dict()
        self.checkpoint_store.save(CheckpointSnapshot(
            run_id=self.run_id,
            state=self.state.to_dict(),
            budget_usage=self.state.budget_usage,
            event_offset=self.state.last_event_sequence,
        ))
