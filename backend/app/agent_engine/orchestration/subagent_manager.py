from __future__ import annotations

import json
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping, Protocol

from app.agent_engine.agents.base import AgentSummary, ContextPolicy, WorkspacePolicy
from app.agent_engine.agents.roles import RoleProfile, default_role_profiles
from app.agent_engine.contracts.task import TaskBudget, TaskNode
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.mailbox import AgentMailbox


class SubagentWorker(Protocol):
    def __call__(self, record: "SubagentRecord", mailbox: AgentMailbox) -> AgentSummary:
        ...


@dataclass
class SubagentRecord:
    agent_id: str
    parent_agent_id: str | None
    role: str
    task: TaskNode
    context_policy: ContextPolicy
    budget: TaskBudget
    workspace_policy: WorkspacePolicy
    workspace: Path
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: float = 0.0
    completed_at: float = 0.0
    transcript: list[dict[str, Any]] = field(default_factory=list)
    summary: AgentSummary | None = None
    error: str = ""
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "parent_agent_id": self.parent_agent_id,
            "role": self.role,
            "task": self.task.to_dict(),
            "context_policy": asdict(self.context_policy),
            "budget": asdict(self.budget),
            "workspace_policy": asdict(self.workspace_policy),
            "workspace": str(self.workspace),
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "transcript": list(self.transcript),
            "summary": self.summary.to_dict() if self.summary else None,
            "error": self.error,
        }


@dataclass(frozen=True)
class JoinedResult:
    policy: str
    summaries: tuple[AgentSummary, ...]
    aggregate: Mapping[str, Any]


class SubagentManager:
    """Bounded, role-aware subagent lifecycle manager with durable handoffs."""

    def __init__(
        self,
        run_id: str,
        workspace: str | Path,
        events: AppendOnlyEventStore,
        worker: SubagentWorker,
        *,
        max_concurrency: int = 4,
        role_profiles: Mapping[str, RoleProfile] | None = None,
    ) -> None:
        self.run_id = run_id
        self.workspace = Path(workspace).expanduser().resolve()
        self.events = events
        self.worker = worker
        self.max_concurrency = max(1, max_concurrency)
        self.role_profiles = dict(role_profiles or default_role_profiles())
        self.mailbox = AgentMailbox(run_id, events)
        self._lock = threading.RLock()
        self._records: dict[str, SubagentRecord] = {}
        self._futures: dict[str, Future[AgentSummary]] = {}
        self._pool = ThreadPoolExecutor(max_workers=self.max_concurrency, thread_name_prefix="subagent")
        self._role_semaphores = {
            name: threading.BoundedSemaphore(max(1, profile.max_instances))
            for name, profile in self.role_profiles.items()
        }

    def spawn(
        self,
        role: str,
        task: TaskNode,
        context_policy: ContextPolicy | None = None,
        budget: TaskBudget | None = None,
        workspace_policy: WorkspacePolicy | None = None,
        *,
        parent_agent_id: str | None = "agent_root",
    ) -> str:
        if role not in self.role_profiles:
            raise ValueError(f"unknown subagent role: {role}")
        profile = self.role_profiles[role]
        forbidden = set(task.allowed_tools) - set(profile.allowed_tools)
        if forbidden:
            raise ValueError(f"role {role} cannot use tools: {sorted(forbidden)}")
        with self._lock:
            active_for_role = sum(
                1 for record in self._records.values()
                if record.role == role and record.status in {"queued", "running"}
            )
            if active_for_role >= profile.max_instances:
                raise ValueError(f"role concurrency limit reached: {role}")
            agent_id = f"agent_{uuid.uuid4().hex}"
            selected_workspace_policy = workspace_policy or WorkspacePolicy()
            agent_workspace = self._workspace_for(agent_id, selected_workspace_policy)
            record = SubagentRecord(
                agent_id=agent_id,
                parent_agent_id=parent_agent_id,
                role=role,
                task=task,
                context_policy=context_policy or ContextPolicy(),
                budget=budget or task.budget,
                workspace_policy=selected_workspace_policy,
                workspace=agent_workspace,
            )
            self._records[agent_id] = record
            self.events.append(
                self.run_id,
                EventType.AGENT_SPAWNED,
                actor=parent_agent_id or "coordinator",
                agent_id=agent_id,
                task_id=task.task_id,
                payload={"agent": self._public_record(record)},
            )
            self.events.append(
                self.run_id,
                EventType.TASK_SCHEDULED,
                actor="coordinator",
                agent_id=agent_id,
                task_id=task.task_id,
                payload={"task": task.to_dict()},
            )
            self._futures[agent_id] = self._pool.submit(self._execute, record)
            self._checkpoint(record)
            return agent_id

    def fork(self, parent_agent_id: str, focused_context: Mapping[str, Any]) -> str:
        parent = self.get(parent_agent_id)
        task = replace(
            parent.task,
            task_id=f"{parent.task.task_id}_fork_{uuid.uuid4().hex[:8]}",
            title=str(focused_context.get("title") or f"Focused fork of {parent.task.title}"),
            inputs=tuple(str(item) for item in focused_context.get("inputs", parent.task.inputs)),
        )
        context = replace(
            parent.context_policy,
            fact_ids=tuple(str(item) for item in focused_context.get("fact_ids", parent.context_policy.fact_ids)),
            hypothesis_ids=tuple(
                str(item) for item in focused_context.get("hypothesis_ids", parent.context_policy.hypothesis_ids)
            ),
            evidence_ids=tuple(
                str(item) for item in focused_context.get("evidence_ids", parent.context_policy.evidence_ids)
            ),
            artifact_ids=tuple(
                str(item) for item in focused_context.get("artifact_ids", parent.context_policy.artifact_ids)
            ),
        )
        return self.spawn(
            parent.role,
            task,
            context,
            parent.budget,
            parent.workspace_policy,
            parent_agent_id=parent_agent_id,
        )

    def resume(self, agent_id: str, new_input: Mapping[str, Any]) -> str:
        with self._lock:
            record = self.get(agent_id)
            if record.status in {"queued", "running"}:
                raise ValueError("subagent is already active")
            record.cancel_event = threading.Event()
            record.status = "queued"
            record.error = ""
            record.completed_at = 0
            record.transcript.append({"role": "user", "content": dict(new_input), "resumed_at": time.time()})
            self.events.append(
                self.run_id,
                EventType.AGENT_RESUMED,
                actor=record.parent_agent_id or "coordinator",
                agent_id=agent_id,
                task_id=record.task.task_id,
                payload={"agent": self._public_record(record), "new_input": dict(new_input)},
            )
            self._futures[agent_id] = self._pool.submit(self._execute, record)
            self._checkpoint(record)
            return agent_id

    def cancel(self, agent_id: str, reason: str = "cancelled by coordinator") -> bool:
        with self._lock:
            record = self.get(agent_id)
            if record.status not in {"queued", "running"}:
                return False
            record.cancel_event.set()
            record.status = "cancelled"
            record.error = reason
            future = self._futures.get(agent_id)
            if future:
                future.cancel()
            self.events.append(
                self.run_id,
                EventType.AGENT_CANCELLED,
                actor="coordinator",
                agent_id=agent_id,
                task_id=record.task.task_id,
                payload={"agent": self._public_record(record), "reason": reason},
            )
            self._checkpoint(record)
            return True

    def join(
        self,
        agent_ids: list[str] | tuple[str, ...],
        aggregation_policy: str = "synthesize",
        *,
        timeout: float | None = None,
    ) -> JoinedResult:
        summaries: list[AgentSummary] = []
        deadline = None if timeout is None else time.monotonic() + timeout
        for agent_id in agent_ids:
            future = self._futures.get(agent_id)
            if future is None:
                raise KeyError(agent_id)
            remaining = None if deadline is None else max(0, deadline - time.monotonic())
            try:
                summaries.append(future.result(timeout=remaining))
            except TimeoutError:
                self.cancel(agent_id, "join timeout")
                record = self.get(agent_id)
                summaries.append(self._failure_summary(record, "join timeout"))
        return JoinedResult(aggregation_policy, tuple(summaries), self._aggregate(summaries, aggregation_policy))

    def get(self, agent_id: str) -> SubagentRecord:
        record = self._records.get(agent_id)
        if record is None:
            raise KeyError(agent_id)
        return record

    def records(self) -> tuple[SubagentRecord, ...]:
        with self._lock:
            return tuple(self._records.values())

    def shutdown(self, *, cancel: bool = False) -> None:
        if cancel:
            for record in self.records():
                self.cancel(record.agent_id, "manager shutdown")
        self._pool.shutdown(wait=True, cancel_futures=cancel)

    def _execute(self, record: SubagentRecord) -> AgentSummary:
        semaphore = self._role_semaphores[record.role]
        with semaphore:
            if record.cancel_event.is_set():
                return self._failure_summary(record, record.error or "cancelled")
            record.status = "running"
            record.started_at = time.time()
            record.transcript.append({"role": "system", "content": {
                "role": record.role,
                "task": record.task.to_dict(),
                "context_policy": asdict(record.context_policy),
                "workspace_policy": asdict(record.workspace_policy),
            }})
            self.events.append(
                self.run_id,
                EventType.TASK_STARTED,
                actor=record.agent_id,
                agent_id=record.agent_id,
                task_id=record.task.task_id,
                payload={"task": record.task.to_dict()},
            )
            timer = threading.Timer(record.budget.max_seconds, record.cancel_event.set)
            timer.daemon = True
            timer.start()
            try:
                summary = self.worker(record, self.mailbox)
                if summary.agent_id != record.agent_id or summary.task_id != record.task.task_id:
                    raise ValueError("subagent summary identity mismatch")
                if record.cancel_event.is_set() and summary.status == "completed":
                    summary = self._failure_summary(record, "subagent budget or cancellation reached")
            except Exception as exc:
                summary = self._failure_summary(record, f"{type(exc).__name__}: {exc}")
            finally:
                timer.cancel()
            record.summary = summary
            record.status = summary.status
            record.error = summary.error
            record.completed_at = time.time()
            record.transcript.append({"role": "assistant", "content": summary.to_dict()})
            event_type = EventType.TASK_COMPLETED if summary.status == "completed" else EventType.TASK_BLOCKED
            self.events.append(
                self.run_id,
                event_type,
                actor=record.agent_id,
                agent_id=record.agent_id,
                task_id=record.task.task_id,
                payload={"task": {**record.task.to_dict(), "status": summary.status}, "summary": summary.to_dict()},
            )
            self.events.append(
                self.run_id,
                EventType.AGENT_COMPLETED,
                actor=record.agent_id,
                agent_id=record.agent_id,
                task_id=record.task.task_id,
                payload={"agent": self._public_record(record), "summary": summary.to_dict()},
            )
            self._checkpoint(record)
            return summary

    def _workspace_for(self, agent_id: str, policy: WorkspacePolicy) -> Path:
        if policy.mode == "shared_readonly":
            return self.workspace
        path = self.workspace / ".agent_subagents" / agent_id / "workspace"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _checkpoint(self, record: SubagentRecord) -> None:
        with self._lock:
            target = self.workspace / ".agent_subagents" / record.agent_id / ".agent_state" / "checkpoint.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(record.to_dict(), ensure_ascii=False, sort_keys=True), encoding="utf-8")
            temporary.replace(target)

    @staticmethod
    def _public_record(record: SubagentRecord) -> dict[str, Any]:
        return {
            "agent_id": record.agent_id,
            "parent_agent_id": record.parent_agent_id,
            "role": record.role,
            "task_id": record.task.task_id,
            "status": record.status,
            "workspace_policy": asdict(record.workspace_policy),
            "allowed_tools": list(record.task.allowed_tools),
        }

    @staticmethod
    def _failure_summary(record: SubagentRecord, error: str) -> AgentSummary:
        status = "cancelled" if record.cancel_event.is_set() else "blocked"
        return AgentSummary(record.agent_id, record.role, record.task.task_id, status, "subagent did not complete", error=error)

    @staticmethod
    def _aggregate(summaries: list[AgentSummary], policy: str) -> Mapping[str, Any]:
        if policy not in {"synthesize", "first_success", "vote"}:
            raise ValueError(f"unknown aggregation policy: {policy}")
        completed = [summary for summary in summaries if summary.status == "completed"]
        if policy == "first_success":
            return completed[0].to_dict() if completed else {}
        if policy == "vote":
            votes: dict[str, int] = {}
            for summary in completed:
                votes[summary.summary] = votes.get(summary.summary, 0) + 1
            winner = max(votes, key=votes.get) if votes else ""
            return {"winner": winner, "votes": votes}
        return {
            "summaries": [summary.summary for summary in completed],
            "facts": [dict(item) for summary in completed for item in summary.facts],
            "hypotheses": [dict(item) for summary in completed for item in summary.hypotheses],
            "evidence": [dict(item) for summary in completed for item in summary.evidence],
            "recommendations": [item for summary in completed for item in summary.recommendations],
        }
