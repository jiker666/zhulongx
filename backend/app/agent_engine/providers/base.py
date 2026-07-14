from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence

from app.agent_engine.abort import AbortToken


class ProviderError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable

    def to_dict(self) -> dict[str, object]:
        return {"code": self.code, "message": str(self), "retryable": self.retryable}


@dataclass(frozen=True)
class ProviderToolCall:
    id: str
    name: str
    arguments: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AssistantTurn:
    text: str = ""
    tool_calls: tuple[ProviderToolCall, ...] = ()
    usage: Mapping[str, Any] = field(default_factory=dict)
    finish_reason: str = "stop"
    raw_response_ref: Optional[str] = None


class ModelProvider(ABC):
    @abstractmethod
    def complete(
        self,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]],
        *,
        timeout_seconds: float,
        abort_token: AbortToken,
    ) -> AssistantTurn:
        raise NotImplementedError
