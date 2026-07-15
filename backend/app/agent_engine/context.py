from __future__ import annotations

import json
from typing import Any, Mapping

from app.agent_engine.events import AgentEvent, AppendOnlyEventStore, EventType
from app.agent_engine.state import RunRequest, SessionState
from app.agent_engine.skills.index import SkillIndex


class ContextBuilder:
    """Build model messages from structured state and referenced events."""

    def __init__(self, *, max_events: int = 40, skill_index: SkillIndex | None = None) -> None:
        self.max_events = max_events
        self.skill_index = skill_index

    def build(
        self,
        request: RunRequest,
        state: SessionState,
        events: AppendOnlyEventStore,
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": (
                    "You are a focused worker in an authorized Agent Engine run. Use registered tools, base decisions on "
                    "evidence, update the active plan, and submit candidates with evidence references. A candidate does "
                    "not complete the run until the configured completion policy accepts it. "
                    + (f"Assigned role: {request.agent_role}. {request.role_instructions}" if request.agent_role else "")
                ),
            },
            {
                "role": "user",
                "content": json.dumps({
                    "title": request.title,
                    "objective": request.objective,
                    "scenario": request.scenario,
                    "lineage": {
                        "root_run_id": request.root_run_id or state.run_id,
                        "parent_run_id": request.parent_run_id,
                        "role": request.agent_role or "single",
                    },
                    "inputs": [{"name": item.name, "path": item.path, "media_type": item.media_type} for item in request.inputs],
                    "skill_index": self.skill_index.prompt_index(scenario=request.scenario) if self.skill_index else [],
                    "state": {
                        "current_plan": state.current_plan,
                        "confirmed_facts": state.confirmed_facts,
                        "open_hypotheses": state.open_hypotheses,
                        "failed_hypotheses": state.failed_hypotheses,
                        "evidence_index": state.evidence,
                        "history_summary": state.history_summary,
                        "candidate_answers": state.candidate_answers,
                    },
                }, ensure_ascii=False),
            },
        ]
        recent = events.read(state.run_id)[-self.max_events:]
        known_tool_calls: set[str] = set()
        for event in recent:
            message = self._event_message(event, known_tool_calls)
            if message:
                messages.append(message)
        return messages

    @staticmethod
    def _event_message(event: AgentEvent, known_tool_calls: set[str]) -> Mapping[str, Any] | None:
        if event.type == EventType.MODEL_RESPONDED.value:
            text = str(event.payload.get("text", ""))
            raw_calls = list(event.payload.get("tool_calls", []))
            message: dict[str, Any] = {"role": "assistant", "content": text}
            if raw_calls:
                tool_calls = []
                for call in raw_calls:
                    call_id = str(call.get("id", ""))
                    if not call_id:
                        continue
                    known_tool_calls.add(call_id)
                    tool_calls.append({
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": str(call.get("name", "")),
                            "arguments": json.dumps(call.get("arguments", {}), ensure_ascii=False, sort_keys=True),
                        },
                    })
                if tool_calls:
                    message["tool_calls"] = tool_calls
            return message if text or message.get("tool_calls") else None
        if event.type in {EventType.TOOL_FINISHED.value, EventType.TOOL_FAILED.value}:
            call_id = str(event.payload.get("tool_call_id", ""))
            if not call_id or call_id not in known_tool_calls:
                return None
            return {
                "role": "tool",
                "tool_call_id": call_id,
                "name": str(event.payload.get("name", "")),
                "content": json.dumps({
                    "event_id": event.event_id,
                    "type": (
                        EventType.POLICY_DENIED.value
                        if event.payload.get("metadata", {}).get("code") == "policy_denied"
                        else event.type
                    ),
                    "success": bool(event.payload.get("success", event.type == EventType.TOOL_FINISHED.value)),
                    "summary": event.payload.get("summary", ""),
                    "output": event.payload.get("output", ""),
                    "error": event.payload.get("error", ""),
                    "artifacts": event.payload.get("artifacts", []),
                }, ensure_ascii=False),
            }
        if event.type == EventType.HUMAN_ANSWERED.value:
            return {
                "role": "user",
                "content": json.dumps({
                    "human_answer": event.payload.get("public_response", {}),
                    "answer_refs": event.payload.get("secure_input_refs", []),
                }, ensure_ascii=False),
            }
        return None
