"""
LLMClient - OpenAI-compatible Chat Completions client.
Supports: OpenAI, Ollama /v1, OneAPI, LiteLLM, custom gateways.
LLM_ENABLED=false will return a disabled error without making any network request.
"""
import json
import re
import logging
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class LLMClient:
    """OpenAI-compatible LLM Client with graceful degradation."""

    def __init__(self):
        self.enabled = settings.LLM_ENABLED
        self.base_url = settings.LLM_BASE_URL.rstrip("/")
        self.api_key = settings.LLM_API_KEY
        self.model = settings.LLM_MODEL
        self.timeout = settings.LLM_TIMEOUT
        self.max_tokens = settings.LLM_MAX_TOKENS
        self.temperature = settings.LLM_TEMPERATURE
        self.max_retries = settings.LLM_MAX_RETRIES
        self.last_success = None
        self.last_error = ""

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _masked_key(self) -> str:
        if not self.api_key or self.api_key == "replace_me":
            return "(not configured)"
        return self.api_key[:4] + "****" + self.api_key[-4:] if len(self.api_key) > 8 else "****"

    def chat(
        self,
        messages: List[Dict[str, str]],
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        json_mode: bool = False,
    ) -> Dict[str, Any]:
        """
        Call /chat/completions endpoint.
        Returns structured result dict.
        """
        if not self.enabled:
            return {
                "success": False,
                "content": "",
                "model": self.model,
                "usage": {},
                "error": "LLM disabled (LLM_ENABLED=false)",
            }

        url = f"{self.base_url}/chat/completions"
        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens or self.max_tokens,
            "temperature": temperature if temperature is not None else self.temperature,
            "stream": False,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        last_error = None
        for attempt in range(max(int(self.max_retries or 0), 0) + 1):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(url, headers=self._headers(), json=payload)
                    resp.raise_for_status()
                    data = resp.json()

                content = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {})
                model_name = data.get("model", self.model)
                self.last_success = time.time()
                self.last_error = ""

                return {
                    "success": True,
                    "content": content,
                    "model": model_name,
                    "usage": usage,
                    "error": None,
                    "attempts": attempt + 1,
                }

            except httpx.TimeoutException:
                last_error = f"LLM request timeout after {self.timeout}s"
                logger.warning(f"LLM timeout ({self.timeout}s) for model={self.model}, attempt={attempt + 1}")
            except httpx.HTTPStatusError as e:
                last_error = f"LLM HTTP {e.response.status_code}: {e.response.text[:200]}"
                logger.warning(f"LLM HTTP error: {e.response.status_code}, attempt={attempt + 1}")
            except Exception as e:
                last_error = f"LLM error: {type(e).__name__}"
                logger.warning(f"LLM call failed: {type(e).__name__}: {str(e)[:200]}, attempt={attempt + 1}")
            if attempt < max(int(self.max_retries or 0), 0):
                time.sleep(min(0.5 * (attempt + 1), 2.0))

        self.last_error = last_error or "LLM request failed"
        return {
            "success": False,
            "content": "",
            "model": self.model,
            "usage": {},
            "error": self.last_error,
            "attempts": max(int(self.max_retries or 0), 0) + 1,
        }

    def extract_json(self, content: str) -> Optional[Dict]:
        """Extract JSON from LLM response, supporting markdown code blocks."""
        if not content:
            return None
        # Try direct parse
        try:
            return json.loads(content)
        except Exception:
            pass
        # Try extracting from markdown ```json ... ``` block
        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except Exception:
                pass
        # Try finding first { ... } block
        match = re.search(r"(\{.*\})", content, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except Exception:
                pass
        return None

    def test_connection(self) -> Dict[str, Any]:
        """Quick connection test."""
        result = self.chat(
            messages=[
                {"role": "system", "content": "You are a helpful assistant. Reply in one sentence."},
                {"role": "user", "content": "Say 'CyberPilot LLM OK' in Chinese."},
            ],
            max_tokens=64,
        )
        return result

    def get_status(self) -> Dict[str, Any]:
        parsed = urlparse(self.base_url)
        return {
            "enabled": self.enabled,
            "provider": settings.LLM_PROVIDER,
            "base_url": self.base_url,
            "base_url_host": parsed.netloc or parsed.path.split("/")[0],
            "api_key_configured": bool(self.api_key and self.api_key != "replace_me"),
            "model": self.model,
            "timeout": self.timeout,
            "max_retries": self.max_retries,
            "last_success": self.last_success,
            "last_error": self.last_error,
        }


# Global singleton
llm_client = LLMClient()
