from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol

from app.agent_engine.abort import AbortToken
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.state import RunRequest


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolResult:
    success: bool
    summary: str
    output: str = ""
    error: str = ""
    artifacts: tuple[Mapping[str, Any], ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolContext:
    run_id: str
    request: RunRequest
    workspace: Path
    abort_token: AbortToken
    sandbox: Sandbox


class ToolExecutor(Protocol):
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        ...


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: Mapping[str, Any]
    risk_level: str
    permissions: tuple[str, ...]
    timeout_seconds: int
    executor: ToolExecutor
