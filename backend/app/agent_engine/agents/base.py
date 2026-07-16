from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Mapping


@dataclass(frozen=True)
class ContextPolicy:
    include_goal: bool = True
    include_plan: bool = True
    fact_ids: tuple[str, ...] = ()
    hypothesis_ids: tuple[str, ...] = ()
    evidence_ids: tuple[str, ...] = ()
    artifact_ids: tuple[str, ...] = ()
    max_events: int = 30
    context_budget_tokens: int = 128_000


@dataclass(frozen=True)
class WorkspacePolicy:
    mode: str = "isolated"
    writable: bool = False
    allowed_artifact_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.mode not in {"isolated", "shared_readonly", "worktree"}:
            raise ValueError(f"unknown workspace policy: {self.mode}")


@dataclass(frozen=True)
class AgentSummary:
    agent_id: str
    role: str
    task_id: str
    status: str
    summary: str
    facts: tuple[Mapping[str, Any], ...] = ()
    hypotheses: tuple[Mapping[str, Any], ...] = ()
    evidence: tuple[Mapping[str, Any], ...] = ()
    artifacts: tuple[Mapping[str, Any], ...] = ()
    recommendations: tuple[str, ...] = ()
    error: str = ""
    verdict: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class AgentHandoff:
    task_id: str
    status: str
    summary: str
    facts: tuple[Mapping[str, Any], ...] = ()
    hypotheses_supported: tuple[str, ...] = ()
    hypotheses_refuted: tuple[str, ...] = ()
    evidence_refs: tuple[str, ...] = ()
    artifact_refs: tuple[str, ...] = ()
    commands_replay: tuple[str, ...] = ()
    unresolved_questions: tuple[str, ...] = ()
    recommended_next_actions: tuple[str, ...] = ()
    confidence: float = 0.0
    verdict: str = ""

    def __post_init__(self) -> None:
        if not self.task_id or not 0 <= self.confidence <= 1:
            raise ValueError("handoff requires a task id and confidence between 0 and 1")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
