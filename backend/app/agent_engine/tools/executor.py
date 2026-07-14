from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, replace
from pathlib import Path

from app.agent_engine.events import AgentEvent, AppendOnlyEventStore, EventType
from app.agent_engine.policy.engine import PolicyContext, PolicyEngine
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.schema import ArgumentsValidationError
from app.agent_engine.tools.types import ToolCall, ToolContext, ToolResult


@dataclass(frozen=True)
class ToolExecution:
    result: ToolResult
    result_event: AgentEvent
    replayed: bool = False


class ToolExecutionService:
    def __init__(
        self,
        registry: ToolRegistry,
        policy: PolicyEngine,
        events: AppendOnlyEventStore,
        *,
        max_result_chars: int = 10_000,
    ) -> None:
        self.registry = registry
        self.policy = policy
        self.events = events
        self.max_result_chars = max_result_chars

    def execute(self, call: ToolCall, context: ToolContext, *, parent_event_id: str | None = None) -> ToolExecution:
        existing = self._completed_execution(call, context)
        if existing is not None:
            return existing
        requested = self.events.append(
            context.run_id,
            EventType.TOOL_REQUESTED,
            actor="model",
            parent_event_id=parent_event_id,
            payload={"tool_call_id": call.id, "name": call.name, "arguments": dict(call.arguments)},
            agent_id=context.agent_id,
            task_id=context.request.task_id,
        )
        definition = self.registry.get(call.name)
        if definition is None:
            return self._failure(call, context, requested.event_id, "unknown_tool", f"tool is not registered: {call.name}")
        try:
            self.registry.validate(call.name, call.arguments)
        except ArgumentsValidationError as exc:
            return self._failure(call, context, requested.event_id, "invalid_arguments", str(exc))

        decision = self.policy.authorize(definition, PolicyContext(context.request, context.workspace))
        decision_type = EventType.POLICY_ALLOWED if decision.allowed else EventType.POLICY_DENIED
        decision_event = self.events.append(
            context.run_id,
            decision_type,
            actor="policy",
            parent_event_id=requested.event_id,
            payload={"tool_call_id": call.id, "name": call.name, "reason": decision.reason},
            agent_id=context.agent_id,
            task_id=context.request.task_id,
        )
        if not decision.allowed:
            return self._failure(call, context, decision_event.event_id, "policy_denied", decision.reason)

        started = self.events.append(
            context.run_id,
            EventType.TOOL_STARTED,
            actor="tool_executor",
            parent_event_id=decision_event.event_id,
            payload={"tool_call_id": call.id, "name": call.name},
            agent_id=context.agent_id,
            task_id=context.request.task_id,
        )
        began = time.monotonic()
        try:
            context.abort_token.raise_if_aborted()
            result = definition.executor.execute(context, call.arguments)
        except Exception as exc:
            result = ToolResult(False, f"{call.name} failed", error=f"{type(exc).__name__}: {exc}")
        duration_ms = int((time.monotonic() - began) * 1000)
        result = self._bound_result(result, context.workspace)
        event_type = EventType.TOOL_FINISHED if result.success else EventType.TOOL_FAILED
        result_event = self.events.append(
            context.run_id,
            event_type,
            actor="tool_executor",
            parent_event_id=started.event_id,
            payload={
                "tool_call_id": call.id,
                "name": call.name,
                "success": result.success,
                "summary": result.summary,
                "output": result.output,
                "error": result.error,
                "artifacts": list(result.artifacts),
                "metadata": dict(result.metadata),
                "duration_ms": duration_ms,
            },
            agent_id=context.agent_id,
            task_id=context.request.task_id,
        )
        return ToolExecution(result, result_event)

    def _failure(
        self,
        call: ToolCall,
        context: ToolContext,
        parent_event_id: str,
        code: str,
        message: str,
    ) -> ToolExecution:
        result = ToolResult(False, message, error=message, metadata={"code": code})
        event = self.events.append(
            context.run_id,
            EventType.TOOL_FAILED,
            actor="tool_executor",
            parent_event_id=parent_event_id,
            payload={
                "tool_call_id": call.id,
                "name": call.name,
                "success": False,
                "error": message,
                "metadata": {"code": code},
            },
            agent_id=context.agent_id,
            task_id=context.request.task_id,
        )
        return ToolExecution(result, event)

    def _completed_execution(self, call: ToolCall, context: ToolContext) -> ToolExecution | None:
        for event in reversed(self.events.read(context.run_id)):
            if event.type not in {EventType.TOOL_FINISHED.value, EventType.TOOL_FAILED.value}:
                continue
            if event.payload.get("tool_call_id") != call.id:
                continue
            result = ToolResult(
                success=bool(event.payload.get("success", False)),
                summary=str(event.payload.get("summary", "replayed completed tool result")),
                output=str(event.payload.get("output", "")),
                error=str(event.payload.get("error", "")),
                artifacts=tuple(event.payload.get("artifacts", [])),
                metadata=dict(event.payload.get("metadata", {})),
            )
            return ToolExecution(result, event, replayed=True)
        return None

    def _bound_result(self, result: ToolResult, workspace: Path) -> ToolResult:
        if len(result.output) <= self.max_result_chars:
            return result
        artifact_dir = workspace / ".agent_artifacts"
        artifact_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = artifact_dir / f"tool_{uuid.uuid4().hex}.txt"
        artifact_path.write_text(result.output, encoding="utf-8")
        artifact = {"path": str(artifact_path.relative_to(workspace)), "size": len(result.output), "kind": "tool_output"}
        return replace(
            result,
            output=result.output[: self.max_result_chars] + "\n...[truncated; see artifact]",
            artifacts=result.artifacts + (artifact,),
        )
