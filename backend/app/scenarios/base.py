from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Mapping
from dataclasses import asdict, dataclass

from app.agent_engine.contracts.plan import Plan
from app.agent_engine.orchestration.workflow import WorkflowSpec
from app.agent_engine.validation.base import Validator


@dataclass(frozen=True)
class ScenarioManifest:
    name: str
    display_name: str
    roles: tuple[str, ...]
    skills: tuple[str, ...]
    allowed_tools: tuple[str, ...]
    high_risk_tools: tuple[str, ...]
    required_outputs: tuple[str, ...]
    completion_policy: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class Scenario(ABC):
    name: str

    def normalize_input(self, raw: Mapping[str, Any]) -> dict[str, Any]:
        return dict(raw)

    def initial_context(self, raw: Mapping[str, Any]) -> Mapping[str, Any]:
        return self.normalize_input(raw)

    def manifest(self) -> ScenarioManifest:
        from app.scenarios.workflow_factory import manifest_for

        return manifest_for(self.name)

    def build_plan(self, objective: str) -> Plan:
        from app.scenarios.workflow_factory import build_plan

        return build_plan(self.manifest(), objective)

    def workflow(self, objective: str) -> WorkflowSpec:
        from app.scenarios.workflow_factory import build_workflow

        manifest = self.manifest()
        return build_workflow(manifest, self.build_plan(objective))

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
