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
                    "You are the sole agent for this authorized run. Use registered tools, base decisions on tool evidence, "
                    "and call submit_candidate with evidence references. A candidate does not complete the run until the validator accepts it."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({
                    "title": request.title,
                    "objective": request.objective,
                    "scenario": request.scenario,
                    "inputs": [{"name": item.name, "path": item.path, "media_type": item.media_type} for item in request.inputs],
                    "skill_index": self.skill_index.prompt_index(scenario=request.scenario) if self.skill_index else [],
                    "state": {
                        "confirmed_facts": state.confirmed_facts,
                        "failed_hypotheses": state.failed_hypotheses,
                        "candidate_answers": state.candidate_answers,
                    },
                }, ensure_ascii=False),
            },
        ]
        for event in events.read(state.run_id)[-self.max_events:]:
            message = self._event_message(event)
            if message:
                messages.append(message)
        return messages

    @staticmethod
    def _event_message(event: AgentEvent) -> Mapping[str, Any] | None:
        if event.type == EventType.MODEL_RESPONDED.value:
            text = str(event.payload.get("text", ""))
            if text:
                return {"role": "assistant", "content": text}
        if event.type in {
            EventType.TOOL_FINISHED.value,
            EventType.TOOL_FAILED.value,
            EventType.POLICY_DENIED.value,
            EventType.CANDIDATE_REJECTED.value,
        }:
            return {
                "role": "user",
                "content": json.dumps({
                    "event_id": event.event_id,
                    "type": event.type,
                    "payload": event.payload,
                }, ensure_ascii=False),
            }
        return None
