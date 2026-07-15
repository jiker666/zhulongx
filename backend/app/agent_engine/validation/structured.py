from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.state import SessionState
from app.agent_engine.validation.base import CandidateSubmission, ValidationResult, Validator


class StructuredOutputValidator(Validator):
    def __init__(
        self,
        *,
        required_fields: tuple[str, ...],
        result_type: str,
        evaluator: Callable[[dict[str, object]], bool] | None = None,
    ) -> None:
        self.required_fields = required_fields
        self.result_type = result_type
        self.evaluator = evaluator

    def validate(
        self,
        candidate: CandidateSubmission,
        *,
        state: SessionState,
        events: AppendOnlyEventStore,
        workspace: Path,
    ) -> ValidationResult:
        try:
            document = json.loads(candidate.value)
        except (TypeError, json.JSONDecodeError):
            return ValidationResult(False, "schema", "result is not a JSON object")
        if not isinstance(document, dict):
            return ValidationResult(False, "schema", "result is not a JSON object")
        missing = [field for field in self.required_fields if not document.get(field)]
        if missing:
            return ValidationResult(False, "schema", f"missing required fields: {', '.join(missing)}")
        available = {event.event_id: event for event in events.read(state.run_id)}
        evidence = [available.get(event_id) for event_id in candidate.evidence_event_ids]
        if not evidence or not any(event and event.type == EventType.TOOL_FINISHED.value for event in evidence):
            return ValidationResult(False, "evidence_binding", "result is not bound to successful tool evidence")
        if self.evaluator is not None:
            try:
                accepted = bool(self.evaluator(document))
            except Exception as exc:
                return ValidationResult(False, "authoritative", f"evaluator failed: {type(exc).__name__}")
            if not accepted:
                return ValidationResult(False, "authoritative", "evaluator rejected structured result", True)
            return ValidationResult(True, "authoritative", f"validated {self.result_type} output", True, "accepted")
        return ValidationResult(True, "local_schema_and_evidence", f"validated {self.result_type} output", True, "accepted")
