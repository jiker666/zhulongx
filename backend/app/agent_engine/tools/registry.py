from __future__ import annotations

from app.agent_engine.tools.schema import validate_arguments
from app.agent_engine.tools.types import ToolDefinition


class ToolRegistry:
    def __init__(self) -> None:
        self._definitions: dict[str, ToolDefinition] = {}

    def register(self, definition: ToolDefinition) -> None:
        if definition.name in self._definitions:
            raise ValueError(f"tool already registered: {definition.name}")
        self._definitions[definition.name] = definition

    def get(self, name: str) -> ToolDefinition | None:
        return self._definitions.get(name)

    def validate(self, name: str, arguments: object) -> None:
        definition = self._definitions.get(name)
        if definition is None:
            raise KeyError(name)
        validate_arguments(definition.input_schema, arguments)

    def schemas(self) -> list[dict[str, object]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": definition.name,
                    "description": definition.description,
                    "parameters": dict(definition.input_schema),
                },
            }
            for definition in sorted(self._definitions.values(), key=lambda item: item.name)
        ]

    def definitions(self) -> tuple[ToolDefinition, ...]:
        return tuple(sorted(self._definitions.values(), key=lambda item: item.name))
