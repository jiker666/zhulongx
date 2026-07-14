from __future__ import annotations

from typing import Any, Mapping

from app.agent_engine.tools.types import ToolContext, ToolResult


class SubmitCandidateExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        candidate = str(arguments["candidate"]).strip()
        if not candidate:
            return ToolResult(False, "candidate is empty", error="empty_candidate")
        return ToolResult(
            True,
            "candidate recorded for validation",
            metadata={
                "candidate": candidate,
                "evidence_event_ids": list(arguments.get("evidence_event_ids", [])),
                "reproduction": str(arguments.get("reproduction", "")),
            },
        )
