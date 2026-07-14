from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence

import httpx

from app.agent_engine.abort import AbortToken
from app.agent_engine.providers.base import AssistantTurn, ModelProvider, ProviderError, ProviderToolCall


_RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class OpenAICompatibleProvider(ModelProvider):
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        max_retries: int = 2,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.endpoint = self._endpoint(base_url)
        self._api_key = api_key
        self.model = model
        self.max_retries = max(0, max_retries)
        self.transport = transport

    @staticmethod
    def _endpoint(base_url: str) -> str:
        value = base_url.rstrip("/")
        if value.endswith("/chat/completions"):
            return value
        return value + "/chat/completions"

    def complete(
        self,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]],
        *,
        timeout_seconds: float,
        abort_token: AbortToken,
    ) -> AssistantTurn:
        abort_token.raise_if_aborted()
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [dict(message) for message in messages],
        }
        if tools:
            payload["tools"] = [dict(tool) for tool in tools]
            payload["tool_choice"] = "auto"
        last_error: ProviderError | None = None
        for attempt in range(self.max_retries + 1):
            abort_token.raise_if_aborted()
            client = httpx.Client(
                timeout=httpx.Timeout(timeout_seconds),
                transport=self.transport,
                follow_redirects=False,
            )
            unregister = abort_token.register(client.close)
            try:
                response = client.post(
                    self.endpoint,
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                if response.status_code in _RETRYABLE_STATUS:
                    last_error = ProviderError(
                        "retryable_http_status",
                        f"provider returned HTTP {response.status_code}",
                        retryable=True,
                    )
                elif response.status_code >= 400:
                    raise ProviderError("http_status", f"provider returned HTTP {response.status_code}")
                else:
                    return self._parse_response(response)
            except ProviderError:
                raise
            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                last_error = ProviderError("transport_error", type(exc).__name__, retryable=True)
            except httpx.HTTPError as exc:
                raise ProviderError("http_error", type(exc).__name__) from exc
            finally:
                unregister()
                client.close()
            if attempt < self.max_retries:
                if abort_token.wait(min(0.25 * (2**attempt), 2.0)):
                    abort_token.raise_if_aborted()
                continue
        raise last_error or ProviderError("provider_failed", "provider request failed")

    @staticmethod
    def _parse_response(response: httpx.Response) -> AssistantTurn:
        try:
            data = response.json()
            choice = data["choices"][0]
            message = choice["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError("malformed_response", "provider response does not match OpenAI chat schema") from exc

        tool_calls: list[ProviderToolCall] = []
        for raw_call in message.get("tool_calls") or []:
            try:
                function = raw_call["function"]
                arguments = function.get("arguments", {})
                if isinstance(arguments, str):
                    arguments = json.loads(arguments)
                if not isinstance(arguments, Mapping):
                    raise TypeError("tool arguments are not an object")
                tool_calls.append(ProviderToolCall(
                    id=str(raw_call["id"]),
                    name=str(function["name"]),
                    arguments=dict(arguments),
                ))
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                raise ProviderError("malformed_tool_call", "provider returned an invalid native tool call") from exc

        raw_hash = hashlib.sha256(response.content).hexdigest()
        usage = data.get("usage") or {}
        return AssistantTurn(
            text=str(message.get("content") or ""),
            tool_calls=tuple(tool_calls),
            usage={
                "prompt_tokens": int(usage.get("prompt_tokens", 0) or 0),
                "completion_tokens": int(usage.get("completion_tokens", 0) or 0),
                "total_tokens": int(usage.get("total_tokens", 0) or 0),
            },
            finish_reason=str(choice.get("finish_reason") or ""),
            raw_response_ref=f"sha256:{raw_hash}",
        )
