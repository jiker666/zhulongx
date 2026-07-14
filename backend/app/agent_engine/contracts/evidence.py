from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Evidence:
    evidence_id: str
    evidence_type: str
    summary: str
    source_event_ids: tuple[str, ...]
    artifact_id: str = ""
    locator: str = ""
    confidence: float = 1.0

    def __post_init__(self) -> None:
        if not self.evidence_id or not self.evidence_type or not self.summary or not self.source_event_ids:
            raise ValueError("evidence requires identity, type, summary, and source events")
        if not 0 <= self.confidence <= 1:
            raise ValueError("evidence confidence must be between zero and one")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Fact:
    fact_id: str
    statement: str
    evidence_ids: tuple[str, ...]
    confidence: float
    source: str

    def __post_init__(self) -> None:
        if not self.fact_id or not self.statement or not self.evidence_ids:
            raise ValueError("facts must be evidence-backed")
        if not 0 <= self.confidence <= 1:
            raise ValueError("fact confidence must be between zero and one")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Contradiction:
    contradiction_id: str
    target_id: str
    evidence_ids: tuple[str, ...]
    explanation: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class DecisionRecord:
    decision_id: str
    decision: str
    rationale: str
    evidence_ids: tuple[str, ...]
    rejected_alternatives: tuple[str, ...] = ()
    risks: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if not self.decision_id or not self.decision or not self.rationale:
            raise ValueError("decision identity, value, and rationale are required")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
