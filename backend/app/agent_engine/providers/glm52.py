from __future__ import annotations

import hashlib
import json
import threading
import uuid
from dataclasses import replace
from typing import Any, Mapping, Sequence

import httpx

from app.agent_engine.abort import AbortToken
from app.agent_engine.providers.base import AssistantTurn, ModelProvider, ProviderError, ProviderToolCall, ReasoningBlock
from app.agent_engine.providers.capabilities import GLM52_CAPABILITIES, ModelCapabilities
from app.agent_engine.providers.private_transcript import PrivateTranscriptStore
from app.agent_engine.providers.streaming import GLMStreamAccumulator, _usage


_RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}
_REASONING_EFFORTS = {"max", "xhigh", "high", "medium", "low", "minimal", "none"}


class GLM52Provider(ModelProvider):
    """Native GLM-5.2 chat protocol with private preserved thinking."""

    capabilities: ModelCapabilities = GLM52_CAPABILITIES

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str = "glm-5.2",
        temperature: float = 1.0,
        max_tokens: int = 4096,
        thinking_enabled: bool = True,
        reasoning_effort: str = "max",
        clear_thinking: bool = False,
        stream: bool = True,
        tool_stream: bool = True,
        connect_timeout: float = 10.0,
        read_timeout: float = 120.0,
        write_timeout: float = 30.0,
        max_retries: int = 2,
        allow_capability_downgrade: bool = True,
        transport: httpx.BaseTransport | None = None,
        trace_context: Mapping[str, str] | None = None,
    ) -> None:
        if not 0 <= temperature <= 1:
            raise ValueError("GLM-5.2 temperature must be between 0 and 1")
        if not 1 <= max_tokens <= self.capabilities.max_output_tokens:
            raise ValueError(f"GLM-5.2 max_tokens must be between 1 and {self.capabilities.max_output_tokens}")
        if reasoning_effort not in _REASONING_EFFORTS:
            raise ValueError(f"unsupported GLM-5.2 reasoning effort: {reasoning_effort}")
        if tool_stream and not stream:
            raise ValueError("GLM-5.2 tool_stream requires stream=true")
        if min(connect_timeout, read_timeout, write_timeout) <= 0:
            raise ValueError("GLM-5.2 timeouts must be positive")
        self.endpoint = self._endpoint(base_url)
        self._api_key = api_key
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.thinking_enabled = thinking_enabled
        self.reasoning_effort = reasoning_effort
        self.clear_thinking = clear_thinking
        self.stream = stream
        self.tool_stream = tool_stream
        self.connect_timeout = connect_timeout
        self.read_timeout = read_timeout
        self.write_timeout = write_timeout
        self.max_retries = max(0, max_retries)
        self.allow_capability_downgrade = allow_capability_downgrade
        self.transport = transport
        self.trace_context = {str(key): str(value) for key, value in (trace_context or {}).items()}
        self._preserved_turns: list[tuple[str, str]] = []
        self._private_store: PrivateTranscriptStore | None = None
        self._lock = threading.RLock()

    def bind_private_transcript(self, path: str) -> None:
        with self._lock:
            store = PrivateTranscriptStore(path)
            self._preserved_turns = store.load()
            self._private_store = store

    def clear_private_transcript(self) -> None:
        with self._lock:
            if self._private_store is not None:
                self._private_store.clear()
            self._preserved_turns.clear()

    @staticmethod
    def _endpoint(base_url: str) -> str:
        value = base_url.rstrip("/")
        return value if value.endswith("/chat/completions") else value + "/chat/completions"

    def complete(
        self,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]],
        *,
        timeout_seconds: float,
        abort_token: AbortToken,
    ) -> AssistantTurn:
        with self._lock:
            return self._complete_locked(messages, tools, timeout_seconds=timeout_seconds, abort_token=abort_token)

    def _complete_locked(
        self,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]],
        *,
        timeout_seconds: float,
        abort_token: AbortToken,
    ) -> AssistantTurn:
        abort_token.raise_if_aborted()
        if len(tools) > self.capabilities.max_functions:
            raise ProviderError(
                "too_many_tools",
                f"GLM-5.2 supports at most {self.capabilities.max_functions} functions",
            )
        request_id = f"req_{uuid.uuid4().hex}"
        payload = self._payload(messages, tools, request_id)
        downgraded_fields: list[str] = []
        last_error: ProviderError | None = None
        attempt = 0
        negotiated_once = False
        while attempt <= self.max_retries:
            abort_token.raise_if_aborted()
            try:
                turn, downgrade = self._request_once(
                    payload,
                    request_id=request_id,
                    timeout_seconds=timeout_seconds,
                    abort_token=abort_token,
                )
                if downgrade:
                    if negotiated_once:
                        raise ProviderError("capability_negotiation_failed", "gateway rejected the reduced GLM request")
                    negotiated_once = True
                    downgraded_fields.extend(downgrade)
                    continue
                negotiation = {
                    "model": self.model,
                    "requested": {
                        "thinking": self.thinking_enabled,
                        "reasoning_effort": self.reasoning_effort if self.thinking_enabled else None,
                        "clear_thinking": self.clear_thinking,
                        "stream": self.stream,
                        "tool_stream": bool(self.tool_stream and tools),
                    },
                    "downgraded_fields": list(dict.fromkeys(downgraded_fields)),
                    "capabilities": self.capabilities.to_dict(),
                }
                turn = replace(
                    turn,
                    provider_metadata={
                        **dict(turn.provider_metadata),
                        "request_id": request_id,
                        "capability_negotiation": negotiation,
                    },
                )
                self._remember(turn)
                return turn
            except ProviderError as exc:
                if not exc.retryable:
                    raise
                last_error = exc
            except (httpx.TimeoutException, httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                last_error = ProviderError("transport_error", type(exc).__name__, retryable=True)
            except httpx.HTTPError as exc:
                if abort_token.is_aborted:
                    abort_token.raise_if_aborted()
                last_error = ProviderError("http_error", type(exc).__name__, retryable=True)
            if attempt < self.max_retries:
                if abort_token.wait(min(0.25 * (2**attempt), 2.0)):
                    abort_token.raise_if_aborted()
            attempt += 1
        raise last_error or ProviderError("provider_failed", "GLM-5.2 request failed")

    def _request_once(
        self,
        payload: dict[str, Any],
        *,
        request_id: str,
        timeout_seconds: float,
        abort_token: AbortToken,
    ) -> tuple[AssistantTurn, tuple[str, ...]]:
        timeout = httpx.Timeout(
            connect=min(self.connect_timeout, timeout_seconds),
            read=min(self.read_timeout, timeout_seconds),
            write=min(self.write_timeout, timeout_seconds),
            pool=min(self.connect_timeout, timeout_seconds),
        )
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream" if payload.get("stream") else "application/json",
            "X-Request-ID": request_id,
        }
        if self.trace_context.get("trace_id"):
            headers["X-Trace-ID"] = self.trace_context["trace_id"]
        if self.trace_context.get("run_id"):
            headers["X-Run-ID"] = self.trace_context["run_id"]
        client = httpx.Client(timeout=timeout, transport=self.transport, follow_redirects=False)
        unregister = abort_token.register(client.close)
        try:
            if payload.get("stream"):
                with client.stream("POST", self.endpoint, headers=headers, json=payload) as response:
                    downgrade = self._response_error(response, payload)
                    if downgrade:
                        return AssistantTurn(), downgrade
                    accumulator = GLMStreamAccumulator()
                    for line in response.iter_lines():
                        abort_token.raise_if_aborted()
                        accumulator.feed_sse_line(line)
                    return accumulator.finalize(require_done=True), ()
            response = client.post(self.endpoint, headers=headers, json=payload)
            downgrade = self._response_error(response, payload)
            if downgrade:
                return AssistantTurn(), downgrade
            return self._parse_response(response), ()
        finally:
            unregister()
            client.close()

    def _response_error(self, response: httpx.Response, payload: dict[str, Any]) -> tuple[str, ...]:
        if response.status_code < 400:
            return ()
        if response.status_code == 400 and self.allow_capability_downgrade:
            removed = self._downgrade_payload(payload)
            if removed:
                return removed
        if response.status_code in _RETRYABLE_STATUS:
            raise ProviderError(
                "retryable_http_status",
                f"provider returned HTTP {response.status_code}",
                retryable=True,
            )
        raise ProviderError("http_status", f"provider returned HTTP {response.status_code}")

    @staticmethod
    def _downgrade_payload(payload: dict[str, Any]) -> tuple[str, ...]:
        removed: list[str] = []
        if "tool_stream" in payload:
            payload.pop("tool_stream", None)
            removed.append("tool_stream")
        if "reasoning_effort" in payload:
            payload.pop("reasoning_effort", None)
            removed.append("reasoning_effort")
        thinking = payload.get("thinking")
        if isinstance(thinking, dict) and "clear_thinking" in thinking:
            thinking.pop("clear_thinking", None)
            removed.append("thinking.clear_thinking")
        return tuple(removed)

    def _payload(
        self,
        messages: Sequence[Mapping[str, Any]],
        tools: Sequence[Mapping[str, Any]],
        request_id: str,
    ) -> dict[str, Any]:
        thinking: dict[str, Any] = {"type": "enabled" if self.thinking_enabled else "disabled"}
        if self.thinking_enabled:
            thinking["clear_thinking"] = self.clear_thinking
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self._messages_with_preserved_thinking(messages),
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": self.stream,
            "thinking": thinking,
            "request_id": request_id,
        }
        if self.thinking_enabled:
            payload["reasoning_effort"] = self.reasoning_effort
        if tools:
            payload["tools"] = [dict(tool) for tool in tools]
            payload["tool_choice"] = "auto"
            if self.stream and self.tool_stream:
                payload["tool_stream"] = True
        return payload

    def _messages_with_preserved_thinking(
        self,
        messages: Sequence[Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        copied = [dict(message) for message in messages]
        if self.clear_thinking or not self.thinking_enabled:
            for message in copied:
                message.pop("reasoning_content", None)
            return copied
        used: set[int] = set()
        for message in copied:
            if message.get("role") != "assistant" or message.get("reasoning_content"):
                continue
            fingerprint = self._fingerprint_message(message)
            for index, (known_fingerprint, reasoning) in enumerate(self._preserved_turns):
                if index not in used and known_fingerprint == fingerprint:
                    message["reasoning_content"] = reasoning
                    used.add(index)
                    break
        return copied

    def _remember(self, turn: AssistantTurn) -> None:
        reasoning = "".join(block.content for block in turn.private_reasoning_blocks)
        if not reasoning:
            return
        message: dict[str, Any] = {"role": "assistant", "content": turn.text}
        if turn.tool_calls:
            message["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": json.dumps(dict(call.arguments), ensure_ascii=False, sort_keys=True),
                    },
                }
                for call in turn.tool_calls
            ]
        self._preserved_turns.append((self._fingerprint_message(message), reasoning))
        if self._private_store is not None:
            self._private_store.save(self._preserved_turns)

    @staticmethod
    def _fingerprint_message(message: Mapping[str, Any]) -> str:
        public = {key: value for key, value in message.items() if key != "reasoning_content"}
        encoded = json.dumps(public, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _parse_response(response: httpx.Response) -> AssistantTurn:
        try:
            data = response.json()
            choice = data["choices"][0]
            message = choice["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise ProviderError("malformed_response", "provider response does not match GLM chat schema") from exc
        tool_calls: list[ProviderToolCall] = []
        for raw_call in message.get("tool_calls") or []:
            try:
                function = raw_call["function"]
                arguments = function.get("arguments", {})
                if isinstance(arguments, str):
                    arguments = json.loads(arguments)
                if not isinstance(arguments, Mapping):
                    raise TypeError("tool arguments are not an object")
                tool_calls.append(ProviderToolCall(str(raw_call["id"]), str(function["name"]), dict(arguments)))
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                raise ProviderError("malformed_tool_call", "provider returned an invalid native tool call") from exc
        reasoning = str(message.get("reasoning_content") or "")
        blocks = (ReasoningBlock(0, reasoning),) if reasoning else ()
        raw_hash = hashlib.sha256(response.content).hexdigest()
        return AssistantTurn(
            text=str(message.get("content") or ""),
            tool_calls=tuple(tool_calls),
            private_reasoning_ref=(f"sha256:{hashlib.sha256(reasoning.encode('utf-8')).hexdigest()}" if reasoning else None),
            private_reasoning_blocks=blocks,
            decision_summary=(
                "Model requested tools: " + ", ".join(call.name for call in tool_calls)
                if tool_calls
                else "Model returned a public response."
            ),
            usage=_usage(data.get("usage") or {}),
            finish_reason=str(choice.get("finish_reason") or ""),
            raw_response_ref=f"sha256:{raw_hash}",
            provider_metadata={
                "stream": False,
                "response_id": str(data.get("id") or ""),
                "model": str(data.get("model") or ""),
            },
        )
