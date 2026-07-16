from __future__ import annotations

from abc import ABC, abstractmethod
import hashlib
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
class ReasoningBlock:
    sequence: int
    content: str = field(repr=False)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.content.encode("utf-8")).hexdigest()

    def public_metadata(self) -> dict[str, object]:
        return {
            "sequence": self.sequence,
            "characters": len(self.content),
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class AssistantTurn:
    text: str = ""
    tool_calls: tuple[ProviderToolCall, ...] = ()
    private_reasoning_ref: Optional[str] = None
    private_reasoning_blocks: tuple[ReasoningBlock, ...] = field(default=(), repr=False)
    decision_summary: str = ""
    usage: Mapping[str, Any] = field(default_factory=dict)
    finish_reason: str = "stop"
    raw_response_ref: Optional[str] = None
    provider_metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def public_text(self) -> str:
        return self.text

    def public_metadata(self) -> dict[str, object]:
        return {
            "private_reasoning_ref": self.private_reasoning_ref,
            "private_reasoning_blocks": [block.public_metadata() for block in self.private_reasoning_blocks],
            "decision_summary": self.decision_summary,
            "provider_metadata": dict(self.provider_metadata),
        }


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
