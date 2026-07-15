from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Mapping

from app.agent_engine.providers.base import AssistantTurn, ProviderError, ProviderToolCall, ReasoningBlock


@dataclass
class _ToolCallBuffer:
    index: int
    call_id: str = ""
    name: str = ""
    arguments: str = ""


class GLMStreamAccumulator:
    """Accumulate GLM deltas and validate tool JSON only after stream completion."""

    def __init__(self) -> None:
        self.reasoning_fragments: list[str] = []
        self.content_fragments: list[str] = []
        self.tool_calls: dict[int, _ToolCallBuffer] = {}
        self.finish_reason = ""
        self.usage: dict[str, Any] = {}
        self.response_id = ""
        self.model = ""
        self.saw_done = False
        self.chunk_count = 0

    def feed_sse_line(self, line: str) -> None:
        value = line.strip()
        if not value or value.startswith(":") or value.startswith("event:") or value.startswith("id:"):
            return
        if not value.startswith("data:"):
            raise ProviderError("malformed_sse", "stream line is not an SSE data record")
        data = value[5:].strip()
        if data == "[DONE]":
            self.saw_done = True
            return
        try:
            payload = json.loads(data)
        except json.JSONDecodeError as exc:
            raise ProviderError("malformed_sse", "stream data is not valid JSON") from exc
        if not isinstance(payload, Mapping):
            raise ProviderError("malformed_sse", "stream chunk must be a JSON object")
        self.feed_chunk(payload)

    def feed_chunk(self, payload: Mapping[str, Any]) -> None:
        self.chunk_count += 1
        self.response_id = str(payload.get("id") or self.response_id)
        self.model = str(payload.get("model") or self.model)
        usage = payload.get("usage")
        if isinstance(usage, Mapping):
            self.usage = dict(usage)
        choices = payload.get("choices") or []
        if not choices:
            return
        try:
            choice = choices[0]
            delta = choice.get("delta") or {}
        except (AttributeError, IndexError, TypeError) as exc:
            raise ProviderError("malformed_sse", "stream choices do not match the chat schema") from exc
        if not isinstance(delta, Mapping):
            raise ProviderError("malformed_sse", "stream delta must be an object")
        reasoning = delta.get("reasoning_content")
        if reasoning is not None:
            self.reasoning_fragments.append(str(reasoning))
        content = delta.get("content")
        if content is not None:
            self.content_fragments.append(str(content))
        raw_calls = delta.get("tool_calls") or []
        if not isinstance(raw_calls, list):
            raise ProviderError("malformed_tool_call", "stream tool_calls must be an array")
        for fallback_index, raw_call in enumerate(raw_calls):
            if not isinstance(raw_call, Mapping):
                raise ProviderError("malformed_tool_call", "stream tool call must be an object")
            index = int(raw_call.get("index", fallback_index))
            buffer = self.tool_calls.setdefault(index, _ToolCallBuffer(index))
            call_id = raw_call.get("id")
            if call_id:
                buffer.call_id = str(call_id)
            function = raw_call.get("function") or {}
            if not isinstance(function, Mapping):
                raise ProviderError("malformed_tool_call", "stream tool function must be an object")
            name = str(function.get("name") or "")
            if name:
                if not buffer.name:
                    buffer.name = name
                elif name.startswith(buffer.name):
                    buffer.name = name
                elif not buffer.name.startswith(name):
                    buffer.name += name
            arguments = function.get("arguments")
            if arguments is not None:
                buffer.arguments += str(arguments)
        finish_reason = choice.get("finish_reason")
        if finish_reason:
            self.finish_reason = str(finish_reason)

    def finalize(self, *, require_done: bool = True) -> AssistantTurn:
        if require_done and not self.saw_done:
            raise ProviderError("incomplete_stream", "provider stream closed before [DONE]", retryable=True)
        tool_calls: list[ProviderToolCall] = []
        for index in sorted(self.tool_calls):
            buffer = self.tool_calls[index]
            if not buffer.call_id or not buffer.name:
                raise ProviderError("malformed_tool_call", "stream tool call is missing id or function name")
            try:
                arguments = json.loads(buffer.arguments or "{}")
            except json.JSONDecodeError as exc:
                raise ProviderError("malformed_tool_call", "stream tool arguments are not valid JSON") from exc
            if not isinstance(arguments, Mapping):
                raise ProviderError("malformed_tool_call", "stream tool arguments must be an object")
            tool_calls.append(ProviderToolCall(buffer.call_id, buffer.name, dict(arguments)))
        reasoning = "".join(self.reasoning_fragments)
        raw_fingerprint = json.dumps(
            {
                "id": self.response_id,
                "model": self.model,
                "content": self.content_fragments,
                "reasoning_hash": hashlib.sha256(reasoning.encode("utf-8")).hexdigest(),
                "tool_calls": [
                    {"id": call.id, "name": call.name, "arguments": dict(call.arguments)} for call in tool_calls
                ],
                "finish_reason": self.finish_reason,
                "usage": self.usage,
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
        reasoning_blocks = (ReasoningBlock(0, reasoning),) if reasoning else ()
        return AssistantTurn(
            text="".join(self.content_fragments),
            tool_calls=tuple(tool_calls),
            private_reasoning_ref=(
                f"sha256:{hashlib.sha256(reasoning.encode('utf-8')).hexdigest()}" if reasoning else None
            ),
            private_reasoning_blocks=reasoning_blocks,
            decision_summary=self._decision_summary(tool_calls),
            usage=_usage(self.usage),
            finish_reason=self.finish_reason,
            raw_response_ref=f"sha256:{hashlib.sha256(raw_fingerprint).hexdigest()}",
            provider_metadata={
                "stream": True,
                "stream_chunks": self.chunk_count,
                "response_id": self.response_id,
                "model": self.model,
            },
        )

    @staticmethod
    def _decision_summary(tool_calls: list[ProviderToolCall]) -> str:
        if tool_calls:
            return "Model requested tools: " + ", ".join(call.name for call in tool_calls)
        return "Model returned a public response."


def _usage(raw: Mapping[str, Any]) -> dict[str, int]:
    return {
        "prompt_tokens": int(raw.get("prompt_tokens", 0) or 0),
        "completion_tokens": int(raw.get("completion_tokens", 0) or 0),
        "total_tokens": int(raw.get("total_tokens", 0) or 0),
        "cached_tokens": int((raw.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0),
    }
