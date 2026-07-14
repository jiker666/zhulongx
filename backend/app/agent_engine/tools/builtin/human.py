from __future__ import annotations

from typing import Any, Mapping

from app.agent_engine.tools.types import ToolContext, ToolResult


class AskHumanExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        question = str(arguments["question"]).strip()
        return ToolResult(True, "human assistance requested", metadata={"question": question, "human_requested": True})
