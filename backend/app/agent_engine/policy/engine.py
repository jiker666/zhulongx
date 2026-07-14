from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from app.agent_engine.state import RunRequest

if TYPE_CHECKING:
    from app.agent_engine.tools.types import ToolDefinition


@dataclass(frozen=True)
class PolicyContext:
    request: RunRequest
    workspace: Path


@dataclass(frozen=True)
class PolicyDecision:
    allowed: bool
    reason: str


class PolicyEngine:
    """Default-deny checks for capabilities that cross the workspace boundary."""

    def authorize(self, definition: ToolDefinition, context: PolicyContext) -> PolicyDecision:
        permissions = set(definition.permissions)
        if "network_access" in permissions:
            if not bool(context.request.authorization.get("authorized", False)):
                return PolicyDecision(False, "run is not authorized for network access")
            if context.request.network_policy.mode != "allowlist":
                return PolicyDecision(False, "network policy defaults to deny")
            if not context.request.network_policy.allowed_hosts:
                return PolicyDecision(False, "network allowlist is empty")
        if "process_execution" in permissions and not bool(context.request.authorization.get("allow_process", False)):
            return PolicyDecision(False, "process execution was not authorized")
        return PolicyDecision(True, "permissions satisfied")
