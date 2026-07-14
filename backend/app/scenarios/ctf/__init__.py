from __future__ import annotations

from typing import Callable, Mapping, Any

from app.agent_engine.validation.base import Validator
from app.agent_engine.validation.ctf import CTFValidator
from app.scenarios.base import Scenario
from app.scenarios.ctf.adapter import CTFRunRequestAdapter


class CTFScenario(Scenario):
    name = "ctf"

    def __init__(self, *, flag_pattern: str = r"flag\{[^}]+\}", evaluator: Callable[[str], bool] | None = None) -> None:
        self.flag_pattern = flag_pattern
        self.evaluator = evaluator

    def recommended_skills(self) -> tuple[str, ...]:
        return ("ctf",)

    def validator(self) -> Validator:
        return CTFValidator(flag_pattern=self.flag_pattern, evaluator=self.evaluator)

    def completion_schema(self) -> Mapping[str, Any]:
        return {"type": "object", "required": ["candidate", "evidence_event_ids", "reproduction"]}


__all__ = ["CTFRunRequestAdapter", "CTFScenario"]
