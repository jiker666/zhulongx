from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Iterable

from app.agent_engine.events import AgentEvent, EventType
from app.agent_engine.state import SessionState


@dataclass(frozen=True)
class CompactedContext:
    through_sequence: int
    plan: dict[str, Any]
    facts: tuple[dict[str, Any], ...]
    open_hypotheses: tuple[dict[str, Any], ...]
    failed_hypotheses: tuple[dict[str, Any], ...]
    evidence_index: tuple[dict[str, Any], ...]
    artifacts: tuple[dict[str, Any], ...]
    decisions: tuple[dict[str, Any], ...]
    notable_failures: tuple[dict[str, Any], ...]
    candidate_answers: tuple[dict[str, Any], ...]
    source_event_ids: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ContextCompactor:
    """Build a structured summary without promoting hypotheses into facts."""

    def compact(self, state: SessionState, events: Iterable[AgentEvent]) -> CompactedContext:
        ordered = sorted(events, key=lambda item: item.sequence)
        failures: list[dict[str, Any]] = []
        source_ids: list[str] = []
        for event in ordered:
            if event.type in {
                EventType.TOOL_FAILED.value,
                EventType.POLICY_DENIED.value,
                EventType.PLAN_NODE_BLOCKED.value,
                EventType.HYPOTHESIS_REFUTED.value,
            }:
                failures.append({
                    "event_id": event.event_id,
                    "type": event.type,
                    "tool_call_id": event.payload.get("tool_call_id"),
                    "error": event.payload.get("error") or event.payload.get("reason", ""),
                })
                source_ids.append(event.event_id)
        for collection in (state.confirmed_facts, state.open_hypotheses, state.failed_hypotheses, state.evidence):
            for item in collection:
                for event_id in item.get("source_event_ids", item.get("evidence_event_ids", [])):
                    if event_id not in source_ids:
                        source_ids.append(str(event_id))
        return CompactedContext(
            through_sequence=ordered[-1].sequence if ordered else 0,
            plan=dict(state.current_plan),
            facts=tuple(dict(item) for item in state.confirmed_facts),
            open_hypotheses=tuple(dict(item) for item in state.open_hypotheses),
            failed_hypotheses=tuple(dict(item) for item in state.failed_hypotheses),
            evidence_index=tuple(dict(item) for item in state.evidence),
            artifacts=tuple(dict(item) for item in state.artifacts),
            decisions=tuple(dict(item) for item in state.decisions),
            notable_failures=tuple(failures[-50:]),
            candidate_answers=tuple(dict(item) for item in state.candidate_answers),
            source_event_ids=tuple(source_ids),
        )
