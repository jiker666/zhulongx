from __future__ import annotations

from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.providers.openai_compatible import OpenAICompatibleProvider
from app.config import settings


def configured_provider() -> ModelProvider:
    if settings.LLM_ENABLED and settings.LLM_API_KEY and settings.LLM_API_KEY != "replace_me":
        return OpenAICompatibleProvider(
            base_url=settings.LLM_BASE_URL,
            api_key=settings.LLM_API_KEY,
            model=settings.LLM_MODEL,
            max_retries=settings.LLM_MAX_RETRIES,
        )
    return ScriptedProvider([])
