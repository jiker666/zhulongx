from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Mapping

from app.agent_engine.validation.base import Validator


class Scenario(ABC):
    name: str

    def normalize_input(self, raw: Mapping[str, Any]) -> dict[str, Any]:
        return dict(raw)

    def initial_context(self, raw: Mapping[str, Any]) -> Mapping[str, Any]:
        return self.normalize_input(raw)

    @abstractmethod
    def recommended_skills(self) -> tuple[str, ...]:
        raise NotImplementedError

    @abstractmethod
    def validator(self) -> Validator:
        raise NotImplementedError

    @abstractmethod
    def completion_schema(self) -> Mapping[str, Any]:
        raise NotImplementedError


class ScenarioRegistry:
    def __init__(self) -> None:
        self._items: dict[str, Scenario] = {}

    def register(self, scenario: Scenario) -> None:
        if scenario.name in self._items:
            raise ValueError(f"scenario already registered: {scenario.name}")
        self._items[scenario.name] = scenario

    def get(self, name: str) -> Scenario:
        try:
            return self._items[name]
        except KeyError as exc:
            raise KeyError(f"unknown scenario: {name}") from exc

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._items))
