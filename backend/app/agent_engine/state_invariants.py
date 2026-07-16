from __future__ import annotations

from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.tools.types import ToolCall, ToolContext


class StateInvariantError(ValueError):
    pass


class StateInvariantGuard:
    """Validate model state proposals against the canonical event log."""

    def validate_tool_call(
        self,
        call: ToolCall,
        context: ToolContext,
        events: AppendOnlyEventStore,
    ) -> None:
        if call.name not in {"record_fact", "record_evidence", "refute_hypothesis"}:
            return
        references = call.arguments.get("evidence_ids") or call.arguments.get("source_event_ids") or ()
        if not references:
            raise StateInvariantError("state update requires evidence references")
        known: set[str] = set()
        for event in events.read(context.run_id):
            known.add(event.event_id)
            if event.type == EventType.EVIDENCE_RECORDED.value:
                evidence = event.payload.get("evidence") or event.payload
                evidence_id = evidence.get("evidence_id") if isinstance(evidence, dict) else None
                if evidence_id:
                    known.add(str(evidence_id))
        missing = {str(item) for item in references} - known
        if missing:
            raise StateInvariantError(f"state update references unknown evidence: {sorted(missing)}")
