from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from app.agent_engine.abort import AbortToken
from app.agent_engine.budget import BudgetTracker
from app.agent_engine.context import ContextBuilder
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.providers.base import ModelProvider, ProviderError
from app.agent_engine.state import RunRequest, RunStatus, SessionState
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolCall, ToolContext
from app.agent_engine.validation.base import CandidateSubmission, Validator


@dataclass(frozen=True)
class LoopOutcome:
    status: RunStatus
    error: str = ""
    output: dict[str, object] | None = None


class AgentLoop:
    def __init__(
        self,
        *,
        provider: ModelProvider,
        registry: ToolRegistry,
        executor: ToolExecutionService,
        validator: Validator,
        context_builder: ContextBuilder | None = None,
        max_no_progress: int = 3,
        checkpoint_callback: Callable[[], None] | None = None,
    ) -> None:
        self.provider = provider
        self.registry = registry
        self.executor = executor
        self.validator = validator
        self.context_builder = context_builder or ContextBuilder()
        self.max_no_progress = max_no_progress
        self.checkpoint_callback = checkpoint_callback

    def run(
        self,
        request: RunRequest,
        state: SessionState,
        events: AppendOnlyEventStore,
        budget: BudgetTracker,
        abort_token: AbortToken,
        tool_context: ToolContext,
    ) -> LoopOutcome:
        no_progress = 0
        while True:
            abort_token.raise_if_aborted()
            budget.check()
            messages = self.context_builder.build(request, state, events)
            requested = events.append(
                state.run_id,
                EventType.MODEL_REQUESTED,
                actor="agent_loop",
                payload={"message_count": len(messages), "tool_count": len(self.registry.definitions())},
            )
            try:
                turn = self.provider.complete(
                    messages,
                    self.registry.schemas(),
                    timeout_seconds=min(request.budgets.max_seconds, 120),
                    abort_token=abort_token,
                )
            except ProviderError as exc:
                error_event = events.append(
                    state.run_id,
                    EventType.MODEL_RESPONDED,
                    actor="provider",
                    parent_event_id=requested.event_id,
                    payload={"error": exc.to_dict()},
                )
                state.last_event_sequence = error_event.sequence
                if exc.retryable:
                    no_progress += 1
                    if no_progress < self.max_no_progress:
                        continue
                return LoopOutcome(RunStatus.FAILED, f"provider error [{exc.code}]: {exc}")
            budget.record_model_request(turn.usage)
            responded = events.append(
                state.run_id,
                EventType.MODEL_RESPONDED,
                actor="provider",
                parent_event_id=requested.event_id,
                payload={
                    "text": turn.text,
                    "tool_calls": [
                        {"id": call.id, "name": call.name, "arguments": dict(call.arguments)} for call in turn.tool_calls
                    ],
                    "usage": dict(turn.usage),
                    "finish_reason": turn.finish_reason,
                    "raw_response_ref": turn.raw_response_ref,
                },
            )
            state.budget_usage = budget.usage.to_dict()
            state.last_event_sequence = responded.sequence

            if not turn.tool_calls:
                no_progress += 1
                self._state_update(events, state, {"no_progress_count": no_progress}, responded.event_id)
                if no_progress >= self.max_no_progress:
                    return LoopOutcome(RunStatus.HUMAN_REQUIRED, "model made no actionable progress")
                continue

            no_progress = 0
            for provider_call in turn.tool_calls:
                abort_token.raise_if_aborted()
                budget.check()
                prior_evidence_id = self._last_successful_non_candidate_event(state)
                execution = self.executor.execute(
                    ToolCall(provider_call.id, provider_call.name, provider_call.arguments),
                    tool_context,
                    parent_event_id=responded.event_id,
                )
                if not execution.replayed:
                    budget.record_tool_call()
                state.last_event_sequence = execution.result_event.sequence
                if execution.result.artifacts:
                    state.artifacts.extend(dict(item) for item in execution.result.artifacts)
                known_result_ids = {str(item.get("event_id")) for item in state.important_tool_results}
                if execution.result.success and execution.result_event.event_id not in known_result_ids:
                    state.important_tool_results.append({
                        "event_id": execution.result_event.event_id,
                        "tool_name": provider_call.name,
                        "summary": execution.result.summary,
                    })
                    state.important_tool_results = state.important_tool_results[-50:]
                state.budget_usage = budget.usage.to_dict()
                self._state_update(
                    events,
                    state,
                    {"tool_name": provider_call.name, "tool_success": execution.result.success},
                    execution.result_event.event_id,
                )
                if provider_call.name == "load_skill" and execution.result.success:
                    skill_event = events.append(
                        state.run_id,
                        EventType.SKILL_LOADED,
                        actor="skill_loader",
                        parent_event_id=execution.result_event.event_id,
                        payload={
                            "name": execution.result.metadata.get("skill_name", ""),
                            "characters": execution.result.metadata.get("characters", 0),
                        },
                    )
                    state.last_event_sequence = skill_event.sequence
                self._checkpoint()

                if provider_call.name == "ask_human" and execution.result.success:
                    return LoopOutcome(
                        RunStatus.HUMAN_REQUIRED,
                        str(execution.result.metadata.get("question", "human assistance requested")),
                    )

                if provider_call.name != "submit_candidate" or not execution.result.success:
                    continue
                metadata = execution.result.metadata
                evidence_ids = tuple(str(item) for item in metadata.get("evidence_event_ids", []))
                if not evidence_ids and prior_evidence_id:
                    evidence_ids = (prior_evidence_id,)
                candidate = CandidateSubmission(
                    value=str(metadata.get("candidate", "")),
                    evidence_event_ids=evidence_ids,
                    reproduction=str(metadata.get("reproduction", "")),
                )
                detected = events.append(
                    state.run_id,
                    EventType.CANDIDATE_DETECTED,
                    actor="validator",
                    parent_event_id=execution.result_event.event_id,
                    payload={
                        "candidate": candidate.value,
                        "evidence_event_ids": list(candidate.evidence_event_ids),
                        "reproduction": candidate.reproduction,
                    },
                )
                state.candidate_answers.append({
                    "candidate": candidate.value,
                    "evidence_event_ids": list(candidate.evidence_event_ids),
                    "status": "detected",
                })
                validation = self.validator.validate(
                    candidate,
                    state=state,
                    events=events,
                    workspace=tool_context.workspace,
                )
                validation_type = EventType.CANDIDATE_VALIDATED if validation.accepted else EventType.CANDIDATE_REJECTED
                validation_event = events.append(
                    state.run_id,
                    validation_type,
                    actor="validator",
                    parent_event_id=detected.event_id,
                    payload={
                        "candidate": candidate.value,
                        "accepted": validation.accepted,
                        "level": validation.level,
                        "reason": validation.reason,
                        "authoritative": validation.authoritative,
                    },
                )
                state.candidate_answers[-1]["status"] = "validated" if validation.accepted else "rejected"
                state.candidate_answers[-1]["validation"] = validation.reason
                state.last_event_sequence = validation_event.sequence
                if validation.accepted:
                    return LoopOutcome(
                        RunStatus.SUCCEEDED,
                        output={
                            "candidate": candidate.value,
                            "evidence_event_ids": list(candidate.evidence_event_ids),
                            "validation_level": validation.level,
                        },
                    )
                self._checkpoint()

    @staticmethod
    def _last_successful_non_candidate_event(state: SessionState) -> str | None:
        for item in reversed(state.important_tool_results):
            if item.get("tool_name") != "submit_candidate":
                return str(item.get("event_id"))
        return None

    @staticmethod
    def _state_update(
        events: AppendOnlyEventStore,
        state: SessionState,
        changes: dict[str, object],
        parent_event_id: str | None,
    ) -> None:
        event = events.append(
            state.run_id,
            EventType.STATE_UPDATED,
            actor="agent_loop",
            parent_event_id=parent_event_id,
            payload={"changes": changes, "budget_usage": state.budget_usage},
        )
        state.last_event_sequence = event.sequence

    def _checkpoint(self) -> None:
        if self.checkpoint_callback is not None:
            self.checkpoint_callback()
