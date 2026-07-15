from __future__ import annotations

from dataclasses import replace

from app.agent_engine.state import ModelConfig


class ModelRoutePolicy:
    """Derive credential-free per-role model routes from one run configuration."""

    def for_role(self, config: ModelConfig, role: str) -> ModelConfig:
        normalized = role.strip().lower()
        if normalized in {"reviewer", "refuter", "verifier"}:
            return replace(config, gateway_profile="reviewer", model=config.reviewer_model or config.model)
        if normalized in {"coordinator", "planner", "scout"}:
            return replace(config, gateway_profile="cheap", model=config.cheap_model or config.model)
        if normalized in {"researcher", "executor", "analyst"}:
            return replace(config, gateway_profile="expert", model=config.expert_model or config.model)
        return config
