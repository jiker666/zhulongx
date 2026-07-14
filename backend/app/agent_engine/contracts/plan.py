from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping

from app.agent_engine.contracts.task import TaskNode


@dataclass(frozen=True)
class Plan:
    plan_id: str
    version: int
    goal: str
    nodes: tuple[TaskNode, ...]
    alternatives: tuple[str, ...] = ()
    risks: tuple[str, ...] = ()
    assumptions: tuple[str, ...] = ()
    unknowns: tuple[str, ...] = ()
    critical_path: tuple[str, ...] = ()
    rationale: str = ""
    revision_reason: str = ""

    def __post_init__(self) -> None:
        if not self.plan_id or self.version < 1 or not self.goal:
            raise ValueError("plan id, positive version, and goal are required")
        if not self.nodes:
            raise ValueError("plan must contain at least one task node")
        if self.version > 1 and not self.revision_reason:
            raise ValueError("revised plans require a revision reason")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["nodes"] = [node.to_dict() for node in self.nodes]
        return value

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "Plan":
        value = dict(raw)
        value["nodes"] = tuple(TaskNode.from_dict(item) for item in value.get("nodes", ()))
        for key in ("alternatives", "risks", "assumptions", "unknowns", "critical_path"):
            value[key] = tuple(value.get(key, ()))
        return cls(**value)
