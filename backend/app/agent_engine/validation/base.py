from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.state import SessionState


@dataclass(frozen=True)
class CandidateSubmission:
    value: str
    evidence_event_ids: tuple[str, ...]
    reproduction: str = ""


@dataclass(frozen=True)
class ValidationResult:
    accepted: bool
    level: str
    reason: str
    authoritative: bool = False


class Validator(ABC):
    @abstractmethod
    def validate(
        self,
        candidate: CandidateSubmission,
        *,
        state: SessionState,
        events: AppendOnlyEventStore,
        workspace: Path,
    ) -> ValidationResult:
        raise NotImplementedError


class PredicateValidator(Validator):
    """Deterministic offline evaluator used by tests and local benchmarks."""

    def __init__(
        self,
        predicate: Callable[[str], bool],
        *,
        level: str = "offline_evaluator",
        authoritative: bool = True,
        require_evidence: bool = True,
    ) -> None:
        self.predicate = predicate
        self.level = level
        self.authoritative = authoritative
        self.require_evidence = require_evidence

    def validate(
        self,
        candidate: CandidateSubmission,
        *,
        state: SessionState,
        events: AppendOnlyEventStore,
        workspace: Path,
    ) -> ValidationResult:
        if self.require_evidence:
            available = {event.event_id: event for event in events.read(state.run_id)}
            evidence = [available.get(event_id) for event_id in candidate.evidence_event_ids]
            if not evidence or any(item is None for item in evidence):
                return ValidationResult(False, "evidence_binding", "candidate has no valid evidence event")
            if not any(item and item.type == EventType.TOOL_FINISHED.value for item in evidence):
                return ValidationResult(False, "evidence_binding", "candidate evidence is not a successful tool result")
        matched = bool(self.predicate(candidate.value))
        if not matched:
            return ValidationResult(False, self.level, "offline evaluator rejected candidate", self.authoritative)
        if not self.authoritative:
            return ValidationResult(False, self.level, "non-authoritative validator cannot complete a run", False)
        return ValidationResult(True, self.level, "offline evaluator accepted candidate", True)
