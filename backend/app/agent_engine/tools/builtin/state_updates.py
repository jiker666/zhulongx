from __future__ import annotations

from typing import Any, Mapping

from app.agent_engine.events import EventType
from app.agent_engine.tools.types import ToolContext, ToolResult


class StateUpdateExecutor:
    def __init__(self, event_type: EventType, payload_key: str) -> None:
        self.event_type = event_type
        self.payload_key = payload_key

    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        value = dict(arguments)
        if self.event_type in {EventType.FACT_CONFIRMED, EventType.EVIDENCE_RECORDED}:
            evidence = value.get("evidence_ids") or value.get("source_event_ids")
            if not evidence:
                return ToolResult(False, "state update requires evidence references", error="missing_evidence")
        if self.event_type == EventType.PLAN_REVISED and not str(value.get("revision_reason", "")).strip():
            return ToolResult(False, "plan revision requires a reason", error="missing_revision_reason")
        event_payload = {self.payload_key: value}
        if self.event_type == EventType.PLAN_REVISED:
            event_payload["reason"] = str(value.get("revision_reason", ""))
        return ToolResult(
            True,
            f"{self.payload_key} state update accepted",
            metadata={
                "state_event_type": self.event_type.value,
                "state_event_payload": event_payload,
            },
        )
