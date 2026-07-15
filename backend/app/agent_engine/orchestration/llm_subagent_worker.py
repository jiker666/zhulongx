from __future__ import annotations

import shutil
import threading
from dataclasses import replace
from pathlib import Path
from typing import Callable

from app.agent_engine.agents.base import AgentSummary
from app.agent_engine.budget import BudgetLimits
from app.agent_engine.events import AppendOnlyEventStore
from app.agent_engine.orchestration.mailbox import AgentMailbox
from app.agent_engine.orchestration.subagent_manager import SubagentRecord
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.state import InputReference, RunRequest, RunStatus
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.validation.base import Validator


ProviderForRole = Callable[[str], ModelProvider]
SandboxForWorkspace = Callable[[Path, tuple[Path, ...]], Sandbox]


class LLMSubagentWorker:
    """Run one coordinator task through the canonical leaf AgentSession."""

    def __init__(
        self,
        root_request: RunRequest,
        validator: Validator,
        registry: ToolRegistry,
        policy: PolicyEngine,
        provider_for_role: ProviderForRole,
        *,
        sandbox_for_workspace: SandboxForWorkspace | None = None,
    ) -> None:
        self.root_request = root_request
        self.validator = validator
        self.registry = registry
        self.policy = policy
        self.provider_for_role = provider_for_role
        self.sandbox_for_workspace = sandbox_for_workspace
        self._lock = threading.RLock()
        self._active: dict[str, AgentSession] = {}

    def __call__(self, record: SubagentRecord, mailbox: AgentMailbox) -> AgentSummary:
        inputs = self._materialize_inputs(record.workspace)
        child_request = replace(
            self.root_request,
            task_id=record.task.task_id,
            title=record.task.title,
            objective=self._objective(record),
            workspace=str(record.workspace),
            inputs=inputs,
            budgets=BudgetLimits(
                max_seconds=min(self.root_request.budgets.max_seconds, record.budget.max_seconds),
                max_model_requests=max(1, min(50, record.budget.max_tool_calls)),
                max_tool_calls=record.budget.max_tool_calls,
                max_tokens=record.budget.max_tokens,
                max_cost_usd=record.budget.max_cost_usd,
            ),
            execution_mode="single",
            max_parallel_agents=1,
            max_agent_depth=1,
        )
        child_events = AppendOnlyEventStore(record.workspace / ".agent_state" / "events.jsonl")
        readonly = tuple(Path(item.path) for item in inputs if item.readonly)
        sandbox = (
            self.sandbox_for_workspace(record.workspace, readonly)
            if self.sandbox_for_workspace is not None
            else ContainerSandbox(record.workspace, readonly_paths=readonly)
        )
        session = AgentSession(
            child_request,
            run_id=record.child_run_id,
            provider=self.provider_for_role(record.role),
            validator=self.validator,
            events=child_events,
            registry=self._registry_for(record),
            policy=self.policy,
            sandbox=sandbox,
        )
        with self._lock:
            self._active[record.agent_id] = session
        finished = threading.Event()
        watcher = threading.Thread(
            target=self._watch_cancel,
            args=(record, session, finished),
            daemon=True,
            name=f"subagent-cancel-{record.agent_id}",
        )
        watcher.start()
        try:
            state = session.run()
        finally:
            finished.set()
            with self._lock:
                self._active.pop(record.agent_id, None)
        status = "completed" if state.status in {RunStatus.SUCCEEDED, RunStatus.PENDING_EXTERNAL} else "blocked"
        if state.status == RunStatus.CANCELLED:
            status = "cancelled"
        summary = self._summary_text(record, state.status, state.error)
        mailbox.send(
            record.agent_id,
            record.parent_agent_id or "agent_root",
            "agent_handoff",
            {
                "root_run_id": record.root_run_id,
                "child_run_id": record.child_run_id,
                "task_id": record.task.task_id,
                "status": status,
                "summary": summary,
                "evidence_refs": [item.get("evidence_id", "") for item in state.evidence],
                "artifact_refs": [item.get("artifact_id", item.get("path", "")) for item in state.artifacts],
                "unresolved_questions": [state.error] if state.error else [],
            },
        )
        return AgentSummary(
            agent_id=record.agent_id,
            role=record.role,
            task_id=record.task.task_id,
            status=status,
            summary=summary,
            facts=tuple(state.confirmed_facts),
            hypotheses=tuple(state.open_hypotheses),
            evidence=tuple(state.evidence),
            artifacts=tuple(state.artifacts),
            recommendations=("inspect child handoff and referenced evidence",),
            error=state.error if status != "completed" else "",
        )

    def abort_all(self, reason: str) -> None:
        with self._lock:
            active = tuple(self._active.values())
        for session in active:
            session.abort(reason)

    @staticmethod
    def _watch_cancel(record: SubagentRecord, session: AgentSession, finished: threading.Event) -> None:
        while not finished.wait(0.05):
            if record.cancel_event.is_set():
                session.abort(record.error or "cancelled by coordinator")
                return

    def _registry_for(self, record: SubagentRecord) -> ToolRegistry:
        selected = ToolRegistry()
        allowed = set(record.task.allowed_tools)
        for definition in self.registry.definitions():
            if definition.name in allowed:
                selected.register(definition)
        return selected

    def _materialize_inputs(self, workspace: Path) -> tuple[InputReference, ...]:
        inputs: list[InputReference] = []
        input_root = workspace / "inputs"
        for item in self.root_request.inputs:
            source = Path(item.path).expanduser().resolve()
            if not source.is_file():
                continue
            input_root.mkdir(parents=True, exist_ok=True)
            target = input_root / Path(item.name).name
            if not target.exists():
                shutil.copy2(source, target)
            target.chmod(target.stat().st_mode & ~0o222)
            inputs.append(InputReference(item.name, str(target), item.media_type, True))
        return tuple(inputs)

    @staticmethod
    def _objective(record: SubagentRecord) -> str:
        return (
            f"Role: {record.role}. Task: {record.task.title}. "
            f"Expected output: {record.task.expected_output}. "
            f"Success criteria: {'; '.join(record.task.success_criteria)}. "
            "Use only the assigned tools and return evidence-backed results."
        )

    @staticmethod
    def _summary_text(record: SubagentRecord, status: RunStatus, error: str) -> str:
        suffix = f": {error}" if error else ""
        return f"{record.role} task {record.task.task_id} ended with {status.value}{suffix}"
