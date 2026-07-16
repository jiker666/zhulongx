from __future__ import annotations

import json
import hashlib
import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from app.agent_engine.state import RunRequest


def estimate_tokens(value: object) -> int:
    """Conservative tokenizer-independent estimate suitable for preflight budgets."""
    if isinstance(value, str):
        text = value
    else:
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    if not text:
        return 0
    utf8 = len(text.encode("utf-8"))
    words = len(text.split())
    return max(1, math.ceil(utf8 / 3.5), math.ceil(words * 1.35))


@dataclass(frozen=True)
class ContextBudget:
    model_context_limit: int
    reserved_output_tokens: int
    reserved_tool_tokens: int
    max_prompt_tokens: int
    safety_margin: int

    @classmethod
    def for_request(cls, request: RunRequest) -> "ContextBudget":
        model_limit = max(4096, min(1_000_000, request.model_config.context_budget_tokens))
        reserved_output = min(request.model_config.max_tokens, max(512, model_limit // 3))
        reserved_tools = min(16_384, max(512, model_limit // 16))
        safety = min(8192, max(256, model_limit // 32))
        prompt = max(1024, model_limit - reserved_output - reserved_tools - safety)
        return cls(model_limit, reserved_output, reserved_tools, prompt, safety)


@dataclass(frozen=True)
class ContextPackStats:
    estimated_prompt_tokens: int
    max_prompt_tokens: int
    stable_prefix_tokens: int
    stable_prefix_sha256: str
    transcript_tokens: int
    artifact_tokens: int
    included_event_sequences: tuple[int, ...]
    omitted_event_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "estimated_prompt_tokens": self.estimated_prompt_tokens,
            "max_prompt_tokens": self.max_prompt_tokens,
            "stable_prefix_tokens": self.stable_prefix_tokens,
            "stable_prefix_sha256": self.stable_prefix_sha256,
            "transcript_tokens": self.transcript_tokens,
            "artifact_tokens": self.artifact_tokens,
            "included_event_sequences": list(self.included_event_sequences),
            "omitted_event_count": self.omitted_event_count,
        }


@dataclass(frozen=True)
class ContextPack:
    messages: tuple[Mapping[str, Any], ...]
    stats: ContextPackStats


def messages_tokens(messages: Sequence[Mapping[str, Any]]) -> int:
    return sum(estimate_tokens(message) + 4 for message in messages)


def stable_prefix_sha256(messages: Sequence[Mapping[str, Any]]) -> str:
    encoded = json.dumps(messages, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
