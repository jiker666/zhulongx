from __future__ import annotations

from typing import Any, Mapping

from app.agent_engine.skills.loader import SkillLoader
from app.agent_engine.tools.types import ToolContext, ToolResult


class LoadSkillExecutor:
    def __init__(self, loader: SkillLoader) -> None:
        self.loader = loader

    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        name = str(arguments["name"])
        try:
            content = self.loader.load(name)
        except KeyError as exc:
            return ToolResult(False, "skill is not registered", error=str(exc), metadata={"skill_name": name})
        return ToolResult(
            True,
            f"loaded skill {name}",
            output=content,
            metadata={"skill_name": name, "characters": len(content)},
        )
