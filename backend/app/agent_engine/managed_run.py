from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from app.agent_engine.events import AgentEvent, AppendOnlyEventStore
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.state import RunRequest, SessionState
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolCall


@runtime_checkable
class ManagedRun(Protocol):
    """Common control-plane surface for root coordinators and single runs."""

    run_id: str
    request: RunRequest
    workspace: Path
    state: SessionState
    events: AppendOnlyEventStore
    registry: ToolRegistry
    sandbox: Sandbox

    def run(self) -> SessionState:
        ...

    def abort(self, reason: str = "cancelled by user") -> bool:
        ...

    def pause_for_human(self, reason: str = "paused by operator") -> SessionState:
        ...

    def answer_human(
        self,
        public_response: dict[str, object] | None = None,
        *,
        secure_input_refs: tuple[str, ...] = (),
    ) -> SessionState:
        ...

    def submit_external_validation(self, *, accepted: bool, reason: str) -> SessionState:
        ...

    def record_human_evidence(self, content: str) -> dict[str, object]:
        ...

    def record_hypothesis(self, hypothesis: dict[str, object]) -> dict[str, object]:
        ...

    def execute_tool(self, call: ToolCall):
        ...

    def event_stream(self, *, after_sequence: int = 0) -> list[AgentEvent]:
        ...

