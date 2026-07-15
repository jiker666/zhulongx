from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Iterable

from app.agent_engine.events import AgentEvent, EventType
from app.agent_engine.state import SessionState


@dataclass(frozen=True)
class StuckReport:
    stuck: bool
    signals: tuple[str, ...]
    evidence_event_ids: tuple[str, ...]
    recommended_stage: str


class StuckDetector:
    def __init__(self, *, window: int = 12, repeated_call_limit: int = 3, no_progress_rounds: int = 3) -> None:
        self.window = max(3, window)
        self.repeated_call_limit = max(2, repeated_call_limit)
        self.no_progress_rounds = max(2, no_progress_rounds)

    def inspect(self, state: SessionState, events: Iterable[AgentEvent]) -> StuckReport:
        recent = sorted(events, key=lambda item: item.sequence)[-self.window:]
        signals: list[str] = []
        evidence_ids: list[str] = []
        tool_signatures: dict[str, list[str]] = {}
        errors: dict[str, list[str]] = {}
        model_turns = 0
        progress_events = 0
        for event in recent:
            if event.type == EventType.MODEL_RESPONDED.value:
                model_turns += 1
            if event.type in {
                EventType.EVIDENCE_RECORDED.value,
                EventType.FACT_CONFIRMED.value,
                EventType.HYPOTHESIS_CONFIRMED.value,
                EventType.CANDIDATE_VALIDATED.value,
                EventType.TOOL_FINISHED.value,
            }:
                if event.type != EventType.TOOL_FINISHED.value or event.payload.get("success", True):
                    progress_events += 1
            if event.type == EventType.TOOL_REQUESTED.value:
                signature = json.dumps(
                    {"name": event.payload.get("name"), "arguments": event.payload.get("arguments", {})},
                    sort_keys=True,
                    default=str,
                )
                tool_signatures.setdefault(signature, []).append(event.event_id)
            if event.type in {EventType.TOOL_FAILED.value, EventType.MODEL_RESPONDED.value}:
                error = event.payload.get("error")
                if isinstance(error, dict):
                    error = error.get("code") or error.get("message")
                if error:
                    errors.setdefault(str(error), []).append(event.event_id)
        repeated_tools = [ids for ids in tool_signatures.values() if len(ids) >= self.repeated_call_limit]
        if repeated_tools:
            signals.append("repeated_tool_call")
            evidence_ids.extend(repeated_tools[0])
        repeated_errors = [ids for ids in errors.values() if len(ids) >= self.repeated_call_limit]
        if repeated_errors:
            signals.append("repeated_error")
            evidence_ids.extend(repeated_errors[0])
        if model_turns >= self.no_progress_rounds and progress_events == 0:
            signals.append("no_new_evidence")
            evidence_ids.extend(event.event_id for event in recent if event.type == EventType.MODEL_RESPONDED.value)
        blocked = [event.event_id for event in recent if event.type == EventType.PLAN_NODE_BLOCKED.value]
        if len(blocked) >= 2:
            signals.append("plan_node_blocked")
            evidence_ids.extend(blocked)
        conflicts = [
            event.event_id for event in recent
            if event.type == EventType.VALIDATION_COMPLETED.value
            and event.payload.get("disposition") == "conflict"
        ]
        if conflicts:
            signals.append("executor_verifier_conflict")
            evidence_ids.extend(conflicts)
        tokens = int(state.budget_usage.get("tokens", 0) or 0)
        if tokens > 0 and model_turns >= self.no_progress_rounds and progress_events == 0:
            signals.append("budget_without_fact_growth")
        stage = "local_retry"
        if "repeated_tool_call" in signals or "repeated_error" in signals:
            stage = "switch_tool"
        if "plan_node_blocked" in signals:
            stage = "switch_hypothesis"
        if "executor_verifier_conflict" in signals:
            stage = "review_refute"
        return StuckReport(bool(signals), tuple(dict.fromkeys(signals)), tuple(dict.fromkeys(evidence_ids)), stage)
