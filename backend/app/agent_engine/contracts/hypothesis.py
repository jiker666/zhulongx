from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any


class HypothesisStatus(str, Enum):
    OPEN = "open"
    TESTING = "testing"
    CONFIRMED = "confirmed"
    REFUTED = "refuted"


@dataclass(frozen=True)
class Hypothesis:
    hypothesis_id: str
    statement: str
    test_strategy: str
    success_signal: str
    priority: int = 0
    status: HypothesisStatus = HypothesisStatus.OPEN
    evidence_ids: tuple[str, ...] = ()
    failure_reason: str = ""

    def __post_init__(self) -> None:
        if not self.hypothesis_id or not self.statement or not self.test_strategy or not self.success_signal:
            raise ValueError("hypothesis identity, statement, strategy, and success signal are required")

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["status"] = self.status.value
        return value
