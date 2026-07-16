from __future__ import annotations

from typing import Any, Mapping

from app.agent_engine.tools.types import ToolContext, ToolResult


class CompleteTaskExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        if not context.request.parent_run_id or not context.request.agent_role:
            return ToolResult(False, "task handoff is available only to coordinator child runs", error="root_handoff_denied")
        summary = str(arguments.get("summary") or "").strip()
        if not summary:
            return ToolResult(False, "task handoff summary is empty", error="empty_handoff")
        handoff = {
            "task_id": context.request.task_id,
            "status": str(arguments.get("status") or "completed"),
            "summary": summary,
            "facts": list(arguments.get("facts") or []),
            "hypotheses_supported": list(arguments.get("hypotheses_supported") or []),
            "hypotheses_refuted": list(arguments.get("hypotheses_refuted") or []),
            "evidence_refs": list(arguments.get("evidence_refs") or []),
            "artifact_refs": list(arguments.get("artifact_refs") or []),
            "commands_replay": list(arguments.get("commands_replay") or []),
            "unresolved_questions": list(arguments.get("unresolved_questions") or []),
            "recommended_next_actions": list(arguments.get("recommended_next_actions") or []),
            "confidence": float(arguments.get("confidence", 0.5)),
            "verdict": str(arguments.get("verdict") or ""),
        }
        return ToolResult(True, "structured child handoff accepted", metadata={"subtask_handoff": handoff})

