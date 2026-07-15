from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Mapping


class TaskStatus(str, Enum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class TaskBudget:
    max_seconds: float = 120
    max_tool_calls: int = 20
    max_tokens: int = 20_000
    max_cost_usd: float = 1.0

    def __post_init__(self) -> None:
        if self.max_seconds <= 0 or self.max_tool_calls <= 0 or self.max_tokens <= 0 or self.max_cost_usd < 0:
            raise ValueError("task budget values must be positive")


@dataclass(frozen=True)
class TaskNode:
    task_id: str
    title: str
    role: str
    expected_output: str
    success_criteria: tuple[str, ...]
    dependencies: tuple[str, ...] = ()
    inputs: tuple[str, ...] = ()
    allowed_tools: tuple[str, ...] = ()
    budget: TaskBudget = field(default_factory=TaskBudget)
    status: TaskStatus = TaskStatus.PENDING
    fallback_strategies: tuple[str, ...] = ()
    trigger_conditions: tuple[str, ...] = ()
    objective: str = ""
    context_refs: tuple[str, ...] = ()
    expected_outputs: tuple[str, ...] = ()
    failure_signals: tuple[str, ...] = ()
    priority: int = 0
    parallel_group: str = ""
    workspace_policy: str = "isolated"
    verification_policy: str = "evidence_required"
    attempt: int = 1

    def __post_init__(self) -> None:
        if not self.task_id or not self.title or not self.role:
            raise ValueError("task id, title, and role are required")
        if not self.success_criteria:
            raise ValueError(f"task {self.task_id} has no success criteria")
        if self.attempt < 1:
            raise ValueError(f"task {self.task_id} has invalid attempt")
        if self.workspace_policy not in {"isolated", "shared_readonly", "worktree"}:
            raise ValueError(f"task {self.task_id} has invalid workspace policy")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["status"] = self.status.value
        return value

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "TaskNode":
        value = dict(raw)
        value["dependencies"] = tuple(value.get("dependencies", ()))
        value["inputs"] = tuple(value.get("inputs", ()))
        value["allowed_tools"] = tuple(value.get("allowed_tools", ()))
        value["success_criteria"] = tuple(value.get("success_criteria", ()))
        value["fallback_strategies"] = tuple(value.get("fallback_strategies", ()))
        value["trigger_conditions"] = tuple(value.get("trigger_conditions", ()))
        value["context_refs"] = tuple(value.get("context_refs", ()))
        value["expected_outputs"] = tuple(value.get("expected_outputs", ()))
        value["failure_signals"] = tuple(value.get("failure_signals", ()))
        value["budget"] = TaskBudget(**dict(value.get("budget", {})))
        value["status"] = TaskStatus(value.get("status", TaskStatus.PENDING.value))
        return cls(**value)
