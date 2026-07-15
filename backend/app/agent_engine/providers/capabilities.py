from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class ModelCapabilities:
    model: str
    context_window: int
    max_output_tokens: int
    max_functions: int
    supports_thinking: bool = False
    supports_reasoning_effort: bool = False
    supports_interleaved_thinking: bool = False
    supports_preserved_thinking: bool = False
    supports_tool_stream: bool = False
    supports_structured_output: bool = False
    supports_context_cache: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


GLM52_CAPABILITIES = ModelCapabilities(
    model="glm-5.2",
    context_window=1_000_000,
    max_output_tokens=131_072,
    max_functions=128,
    supports_thinking=True,
    supports_reasoning_effort=True,
    supports_interleaved_thinking=True,
    supports_preserved_thinking=True,
    supports_tool_stream=True,
    supports_structured_output=True,
    supports_context_cache=True,
)

