from __future__ import annotations

import re
from pathlib import Path
from typing import Callable

from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.state import SessionState
from app.agent_engine.validation.base import CandidateSubmission, ValidationResult, Validator


AuthoritativeEvaluator = Callable[[str], bool]
Reproducer = Callable[[CandidateSubmission, Path], bool]


class CTFValidator(Validator):
    """Staged CTF validation with an evaluator kept outside session state."""

    def __init__(
        self,
        *,
        flag_pattern: str,
        evaluator: AuthoritativeEvaluator | None = None,
        reproducer: Reproducer | None = None,
    ) -> None:
        self.flag_pattern = re.compile(flag_pattern)
        self.evaluator = evaluator
        self.reproducer = reproducer

    def validate(
        self,
        candidate: CandidateSubmission,
        *,
        state: SessionState,
        events: AppendOnlyEventStore,
        workspace: Path,
    ) -> ValidationResult:
        if self.flag_pattern.fullmatch(candidate.value) is None:
            return ValidationResult(False, "format", "candidate does not match the configured flag format")

        event_by_id = {event.event_id: event for event in events.read(state.run_id)}
        evidence = [event_by_id.get(event_id) for event_id in candidate.evidence_event_ids]
        if not evidence or any(event is None for event in evidence):
            return ValidationResult(False, "evidence_binding", "candidate references missing evidence")
        if not any(event and event.type == EventType.TOOL_FINISHED.value for event in evidence):
            return ValidationResult(False, "evidence_binding", "candidate is not bound to a successful tool result")

        if self.reproducer is not None:
            try:
                reproduced = bool(self.reproducer(candidate, workspace))
            except Exception as exc:
                return ValidationResult(False, "reproduction", f"reproducer failed: {type(exc).__name__}")
            if not reproduced:
                return ValidationResult(False, "reproduction", "candidate reproduction failed")

        if self.evaluator is None:
            return ValidationResult(False, "authoritative", "no authoritative or offline evaluator is configured")
        try:
            accepted = bool(self.evaluator(candidate.value))
        except Exception as exc:
            return ValidationResult(False, "authoritative", f"evaluator failed: {type(exc).__name__}")
        if not accepted:
            return ValidationResult(False, "authoritative", "evaluator rejected candidate", True)
        return ValidationResult(True, "authoritative", "evaluator accepted candidate", True)
