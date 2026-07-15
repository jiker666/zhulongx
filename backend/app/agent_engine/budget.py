from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Mapping


class BudgetExceeded(RuntimeError):
    def __init__(self, dimension: str) -> None:
        super().__init__(f"budget exceeded: {dimension}")
        self.dimension = dimension


@dataclass(frozen=True)
class BudgetLimits:
    max_seconds: float = 600
    max_model_requests: int = 50
    max_tool_calls: int = 100
    max_tokens: int = 200_000
    max_cost_usd: float = 10.0


@dataclass
class BudgetUsage:
    started_at: float = field(default_factory=time.monotonic)
    model_requests: int = 0
    tool_calls: int = 0
    tokens: int = 0
    cost_usd: float = 0.0

    @property
    def elapsed_seconds(self) -> float:
        return max(0.0, time.monotonic() - self.started_at)

    def to_dict(self) -> dict[str, Any]:
        return {
            "elapsed_seconds": round(self.elapsed_seconds, 3),
            "model_requests": self.model_requests,
            "tool_calls": self.tool_calls,
            "tokens": self.tokens,
            "cost_usd": round(self.cost_usd, 8),
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "BudgetUsage":
        elapsed = float(raw.get("elapsed_seconds", 0.0) or 0.0)
        return cls(
            started_at=time.monotonic() - max(0.0, elapsed),
            model_requests=int(raw.get("model_requests", 0) or 0),
            tool_calls=int(raw.get("tool_calls", 0) or 0),
            tokens=int(raw.get("tokens", 0) or 0),
            cost_usd=float(raw.get("cost_usd", 0.0) or 0.0),
        )


class BudgetTracker:
    def __init__(self, limits: BudgetLimits, usage: BudgetUsage | None = None) -> None:
        self.limits = limits
        self.usage = usage or BudgetUsage()

    def check(self) -> None:
        checks = (
            ("time", self.usage.elapsed_seconds > self.limits.max_seconds),
            ("model_requests", self.usage.model_requests >= self.limits.max_model_requests),
            ("tool_calls", self.usage.tool_calls >= self.limits.max_tool_calls),
            ("tokens", self.usage.tokens >= self.limits.max_tokens),
            ("cost", self.usage.cost_usd >= self.limits.max_cost_usd),
        )
        for dimension, exceeded in checks:
            if exceeded:
                raise BudgetExceeded(dimension)

    def record_model_request(self, usage: Mapping[str, Any] | None = None) -> None:
        self.usage.model_requests += 1
        usage = usage or {}
        self.usage.tokens += int(usage.get("total_tokens", 0) or 0)
        self.usage.cost_usd += float(usage.get("cost_usd", 0.0) or 0.0)

    def record_tool_call(self) -> None:
        self.usage.tool_calls += 1
