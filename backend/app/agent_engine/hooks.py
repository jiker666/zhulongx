from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Mapping


HookName = Literal[
    "before_model",
    "before_tool_selection",
    "before_tool_call",
    "after_tool_call",
    "on_tool_error",
    "after_evidence_extraction",
    "before_plan_patch",
    "before_completion",
    "on_checkpoint",
    "on_abort",
]


@dataclass(frozen=True)
class HookContext:
    run_id: str
    task_id: str = ""
    agent_id: str = "agent_root"
    role: str = ""
    data: Mapping[str, Any] = field(default_factory=dict)


HookCallback = Callable[[HookContext], None]


class HookPipeline:
    """Typed observation/enforcement hooks; policy authorization remains authoritative."""

    def __init__(self, hooks: Mapping[HookName, tuple[HookCallback, ...]] | None = None) -> None:
        self._hooks = {name: tuple(callbacks) for name, callbacks in (hooks or {}).items()}

    def run(self, name: HookName, context: HookContext) -> None:
        for callback in self._hooks.get(name, ()):
            callback(context)
