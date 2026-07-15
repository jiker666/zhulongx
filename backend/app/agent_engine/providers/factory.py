from __future__ import annotations

from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.providers.openai_compatible import OpenAICompatibleProvider
from app.agent_engine.state import ModelConfig
from app.config import settings


def _normalized_base_url(value: str) -> str:
    return value.strip().rstrip("/")


def configured_provider(config: ModelConfig | None = None) -> ModelProvider:
    requested = config or ModelConfig(provider=settings.LLM_PROVIDER, model=settings.LLM_MODEL)
    if not settings.LLM_ENABLED:
        return ScriptedProvider([])
    if requested.provider == "mock":
        return ScriptedProvider([])
    profile = requested.gateway_profile.strip().lower() or "default"
    profiles = {
        "default": (settings.LLM_PROVIDER, settings.LLM_BASE_URL, settings.LLM_MODEL, settings.LLM_API_KEY),
        "cheap": (
            settings.LLM_CHEAP_PROVIDER, settings.LLM_CHEAP_BASE_URL,
            settings.LLM_CHEAP_MODEL, settings.LLM_CHEAP_API_KEY,
        ),
        "expert": (
            settings.LLM_EXPERT_PROVIDER, settings.LLM_EXPERT_BASE_URL,
            settings.LLM_EXPERT_MODEL, settings.LLM_EXPERT_API_KEY,
        ),
        "reviewer": (
            settings.LLM_FALLBACK_PROVIDER, settings.LLM_FALLBACK_BASE_URL,
            settings.LLM_FALLBACK_MODEL, settings.LLM_FALLBACK_API_KEY,
        ),
    }
    if profile not in profiles:
        raise ValueError(f"unknown gateway profile: {requested.gateway_profile}")
    profile_provider, profile_base_url, profile_model, api_key = profiles[profile]
    provider_name = requested.provider or profile_provider
    supported = {"openai", "openai_compatible", "wanqing", "deepseek", "qwen", "glm", profile_provider}
    if provider_name not in supported:
        raise ValueError(f"unsupported model provider: {provider_name}")
    configured_base_url = _normalized_base_url(profile_base_url)
    requested_base_url = _normalized_base_url(requested.base_url)
    if requested_base_url and requested_base_url != configured_base_url:
        raise ValueError("requested base URL is not allowed for the selected gateway profile")
    if not configured_base_url:
        raise ValueError(f"gateway profile has no configured base URL: {profile}")
    if not api_key or api_key == "replace_me":
        raise ValueError(f"gateway profile has no configured API key: {profile}")
    return OpenAICompatibleProvider(
        base_url=configured_base_url,
        api_key=api_key,
        model=requested.model or profile_model,
        temperature=requested.temperature,
        max_tokens=requested.max_tokens,
        parallel_tool_calls=requested.parallel_tool_calls,
        max_retries=settings.LLM_MAX_RETRIES,
    )
