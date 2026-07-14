from __future__ import annotations

import threading
from typing import Callable, Mapping, Sequence

from app.agent_engine.abort import AbortToken
from app.agent_engine.providers.base import AssistantTurn, ModelProvider


ScriptStep = AssistantTurn | Callable[[Sequence[Mapping[str, object]], Sequence[Mapping[str, object]]], AssistantTurn]


class ScriptedProvider(ModelProvider):
    """Deterministic provider for session and recovery tests."""

    def __init__(self, steps: Sequence[ScriptStep]) -> None:
        self._steps = list(steps)
        self._lock = threading.Lock()
        self.requests: list[dict[str, object]] = []

    def complete(
        self,
        messages: Sequence[Mapping[str, object]],
        tools: Sequence[Mapping[str, object]],
        *,
        timeout_seconds: float,
        abort_token: AbortToken,
    ) -> AssistantTurn:
        abort_token.raise_if_aborted()
        with self._lock:
            self.requests.append({"messages": list(messages), "tools": list(tools), "timeout_seconds": timeout_seconds})
            if not self._steps:
                return AssistantTurn(text="", finish_reason="no_script_step")
            step = self._steps.pop(0)
        if callable(step):
            return step(messages, tools)
        return step
