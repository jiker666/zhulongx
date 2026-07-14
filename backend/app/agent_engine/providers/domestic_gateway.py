from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.agent_engine.providers.openai_compatible import OpenAICompatibleProvider


@dataclass(frozen=True)
class GatewayProfile:
    """Credential-free competition gateway description selected per run."""

    name: str
    provider: str
    base_url: str
    model: str


class DomesticGatewayProvider(OpenAICompatibleProvider):
    """Vendor-neutral adapter for gateways using the OpenAI-compatible protocol."""

    def __init__(self, *, profile: GatewayProfile, api_key: str, **kwargs: Any) -> None:
        self.profile = profile
        super().__init__(
            base_url=profile.base_url,
            api_key=api_key,
            model=profile.model,
            **kwargs,
        )
