from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any


class CandidateState(str, Enum):
    FOUND = "candidate_found"
    LOCALLY_VALIDATED = "locally_validated"
    PENDING_EXTERNAL = "submitted_pending_external"
    EXTERNALLY_ACCEPTED = "externally_accepted"
    EXTERNALLY_REJECTED = "externally_rejected"
    HUMAN_REQUIRED = "human_required"


@dataclass(frozen=True)
class CompletionDecision:
    status: str
    reason: str
    evidence_ids: tuple[str, ...]
    candidate_state: CandidateState | None = None
    output: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.status == "succeeded" and not self.evidence_ids:
            raise ValueError("successful completion requires evidence")


@dataclass(frozen=True)
class HumanQuestion:
    question_id: str
    prompt: str
    answer_type: str = "text"
    choices: tuple[str, ...] = ()


@dataclass(frozen=True)
class HumanHandoff:
    completed_work: tuple[str, ...]
    confirmed_fact_ids: tuple[str, ...]
    evidence_ids: tuple[str, ...]
    failed_paths: tuple[str, ...]
    minimal_blocker: str
    questions: tuple[HumanQuestion, ...]
    recommended_next_step: str
    risk: str
    checkpoint_sequence: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
