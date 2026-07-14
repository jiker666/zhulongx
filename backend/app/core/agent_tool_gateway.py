"""Compatibility gateway for legacy runtimes.

Legacy AgentRuntime keeps its public methods, but all controlled tool
execution is translated into the competition ToolBroker. The gateway is the
only adapter allowed to construct TaskState for legacy calls.
"""
from __future__ import annotations

import json
from typing import Any, Dict, Tuple

from app.config import settings
from app.core.competition_runtime import ActionCandidate, CompetitionProfile, TaskState, ToolBroker


class AgentToolGateway:
    def __init__(self, *, task_id: str, workspace: str, category: str = "unknown", authorized: bool = False, allow_network: bool = False) -> None:
        self.state = TaskState(task_id=task_id, challenge_id=task_id, competition_id="legacy", objective="legacy agent execution", category=category, workspace=workspace)
        self.profile = CompetitionProfile(
            allow_shell=True,
            allow_python=True,
            allow_network=bool(allow_network and authorized),
            allow_auto_submission=False,
            max_tool_runtime=settings.COMPETITION_MAX_TOOL_RUNTIME,
        )
        self.broker = ToolBroker()

    def execute(self, tool_name: str, arguments: Dict[str, Any], *, specialist: str = "general") -> Tuple[str, str, bool]:
        action = ActionCandidate(tool_name=tool_name, tool_arguments=arguments, purpose="legacy runtime compatibility execution")
        result = self.broker.execute(self.state, action, self.profile, specialist)
        if result.success:
            details = result.structured_output or {}
            output = result.stdout or details.get("content") or details.get("body_excerpt") or json.dumps(details, ensure_ascii=False, default=str)
            return str(output), "", True
        return "", result.error_message or result.error_type or "tool broker denied execution", False

    def execute_raw(self, tool_name: str, arguments: Dict[str, Any], *, specialist: str = "general"):
        action = ActionCandidate(tool_name=tool_name, tool_arguments=arguments, purpose="legacy runtime compatibility execution")
        return self.broker.execute(self.state, action, self.profile, specialist)
