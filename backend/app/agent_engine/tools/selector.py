from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping

from app.agent_engine.state import RunRequest, SessionState
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolDefinition


@dataclass(frozen=True)
class ToolSelection:
    definitions: tuple[ToolDefinition, ...]
    reasons: Mapping[str, str]

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(item.name for item in self.definitions)

    def schemas(self) -> list[dict[str, object]]:
        return ToolRegistry.schemas_for(self.definitions)


class ToolCapabilitySelector:
    """Bound model exposure by role, active node, scenario, and objective relevance."""

    CONTROL_TOOLS = {
        "complete_task", "submit_candidate", "record_evidence", "record_fact",
        "record_hypothesis", "refute_hypothesis", "ask_human", "load_skill",
    }

    def __init__(self, *, max_functions: int = 128) -> None:
        if not 1 <= max_functions <= 128:
            raise ValueError("tool selector limit must be between 1 and 128")
        self.max_functions = max_functions

    def select(self, request: RunRequest, state: SessionState, registry: ToolRegistry) -> ToolSelection:
        definitions = registry.definitions()
        if len(definitions) <= self.max_functions:
            return ToolSelection(definitions, {item.name: "role and task capability scope" for item in definitions})
        query = " ".join((request.scenario, request.agent_role, request.objective, self._active_node_text(state))).casefold()
        terms = set(re.findall(r"[a-z0-9_]{3,}", query))

        def score(definition: ToolDefinition) -> tuple[int, str]:
            text = f"{definition.name} {definition.description} {' '.join(definition.permissions)}".casefold()
            relevance = sum(2 for term in terms if term in text)
            relevance += 100 if definition.name in self.CONTROL_TOOLS else 0
            relevance += 10 if definition.side_effect_level in {"none", "read"} else 0
            return relevance, definition.name

        ranked = sorted(definitions, key=lambda item: (-score(item)[0], score(item)[1]))
        selected = tuple(sorted(ranked[: self.max_functions], key=lambda item: item.name))
        return ToolSelection(selected, {
            item.name: "control capability" if item.name in self.CONTROL_TOOLS else "objective relevance"
            for item in selected
        })

    @staticmethod
    def _active_node_text(state: SessionState) -> str:
        for node in state.current_plan.get("nodes", []):
            if node.get("status") in {"running", "ready", "pending"}:
                return " ".join(str(node.get(key, "")) for key in ("title", "objective", "expected_output"))
        return ""
