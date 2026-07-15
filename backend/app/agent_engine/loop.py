from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from app.agent_engine.abort import AbortToken
from app.agent_engine.budget import BudgetTracker
from app.agent_engine.context import ContextBuilder
from app.agent_engine.compaction import ContextCompactor
from app.agent_engine.events import AgentEvent, AppendOnlyEventStore, EventType
from app.agent_engine.providers.base import ModelProvider, ProviderError
from app.agent_engine.orchestration.replanner import Replanner
from app.agent_engine.orchestration.stuck_detector import StuckDetector
from app.agent_engine.reducer import StateReducer
from app.agent_engine.state import RunRequest, RunStatus, SessionState
from app.agent_engine.tools.batch import BoundedToolBatchExecutor
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolCall, ToolContext
from app.agent_engine.validation.base import CandidateSubmission, ValidationResult, Validator


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
        reducer: StateReducer | None = None,
        max_no_progress: int = 3,
        max_tool_concurrency: int = 4,
        checkpoint_callback: Callable[[], None] | None = None,
    ) -> None:
        self.provider = provider
        self.registry = registry
        self.executor = executor
        self.validator = validator
        self.context_builder = context_builder or ContextBuilder()
        self.reducer = reducer or StateReducer()
        self.max_no_progress = max_no_progress
        self._task_id: str | None = None
        self.compactor = ContextCompactor()
        self.stuck_detector = StuckDetector()
        self.replanner = Replanner()
        self._replan_attempts = 0
        self._budget_warning_emitted = False
        self.batch_executor = BoundedToolBatchExecutor(
            registry,
            executor,
            max_concurrency=max_tool_concurrency,
        )
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
        self._task_id = request.task_id
        while True:
            abort_token.raise_if_aborted()
            budget.check()
            self._warn_budget_if_needed(state, events, budget)
            self._compact_if_needed(state, events)
            messages = self.context_builder.build(request, state, events)
            requested = self._append(
                events,
                state,
                EventType.MODEL_REQUESTED,
                actor="agent_loop",
                payload={
                    "message_count": len(messages),
                    "tool_count": len(self.registry.definitions()),
                    "provider": request.model_config.provider,
                    "model": request.model_config.model,
                },
            )
            try:
                turn = self.provider.complete(
                    messages,
                    self.registry.schemas(),
                    timeout_seconds=min(request.model_config.timeout_seconds, request.budgets.max_seconds, 120),
                    abort_token=abort_token,
                )
            except ProviderError as exc:
                error_event = self._append(
                    events,
                    state,
                    EventType.MODEL_RESPONDED,
                    actor="provider",
                    parent_event_id=requested.event_id,
                    payload={"error": exc.to_dict()},
                )
                if exc.retryable:
                    no_progress += 1
                    if no_progress < self.max_no_progress:
                        continue
                return LoopOutcome(RunStatus.FAILED, f"provider error [{exc.code}]: {exc}")

            budget.record_model_request(turn.usage)
            responded = self._append(
                events,
                state,
                EventType.MODEL_RESPONDED,
                actor="provider",
                parent_event_id=requested.event_id,
                payload={
                    "text": turn.text,
                    "tool_calls": [
                        {"id": call.id, "name": call.name, "arguments": dict(call.arguments)}
                        for call in turn.tool_calls
                    ],
                    "usage": dict(turn.usage),
                    "budget_usage": budget.usage.to_dict(),
                    "finish_reason": turn.finish_reason,
                    "raw_response_ref": turn.raw_response_ref,
                },
            )

            if not turn.tool_calls:
                no_progress += 1
                self._state_update(events, state, {"no_progress_count": no_progress}, responded.event_id, budget)
                if no_progress >= self.max_no_progress:
                    report = self.stuck_detector.inspect(state, events.read(state.run_id))
                    decision = self.replanner.decide(
                        report,
                        previous_attempts=self._replan_attempts,
                        budget_ratio=self._budget_ratio(budget),
                    )
                    self._replan_attempts += 1
                    decision_event = self._append(
                        events,
                        state,
                        EventType.DECISION_RECORDED,
                        actor="replanner",
                        parent_event_id=responded.event_id,
                        payload={"decision": {
                            "decision_id": f"replan_{self._replan_attempts}",
                            "decision": decision.action,
                            "rationale": decision.reason,
                            "evidence_ids": list(report.evidence_event_ids),
                            "risks": ["budget exhaustion"],
                        }},
                    )
                    if decision.action not in {"continue", "local_retry"} and state.current_plan:
                        revised = dict(state.current_plan)
                        revised["version"] = int(revised.get("version", 1)) + 1
                        revised["revision_reason"] = decision.reason
                        revised["active_strategy"] = decision.action
                        self._append(
                            events,
                            state,
                            EventType.PLAN_REVISED,
                            actor="replanner",
                            parent_event_id=decision_event.event_id,
                            payload={"plan": revised, "reason": decision.reason},
                        )
                    if decision.requires_human:
                        question = "Choose a new strategy or provide the smallest missing input."
                        handoff = self._human_handoff(state, question, decision.reason)
                        return LoopOutcome(RunStatus.HUMAN_REQUIRED, decision.reason, {"handoff": handoff})
                    no_progress = 0
                continue

            no_progress = 0
            calls = [ToolCall(call.id, call.name, call.arguments) for call in turn.tool_calls]
            executions = sorted(
                self.batch_executor.execute(calls, tool_context, parent_event_id=responded.event_id),
                key=lambda item: item.execution.result_event.sequence,
            )
            for item in executions:
                provider_call = item.call
                execution = item.execution
                abort_token.raise_if_aborted()
                if not execution.replayed:
                    budget.record_tool_call()
                self.reducer.apply(state, execution.result_event)
                self._state_update(
                    events,
                    state,
                    {"tool_name": provider_call.name, "tool_success": execution.result.success},
                    execution.result_event.event_id,
                    budget,
                )
                if provider_call.name == "load_skill" and execution.result.success:
                    self._append(
                        events,
                        state,
                        EventType.SKILL_LOADED,
                        actor="skill_loader",
                        parent_event_id=execution.result_event.event_id,
                        payload={
                            "name": execution.result.metadata.get("skill_name", ""),
                            "characters": execution.result.metadata.get("characters", 0),
                        },
                    )
                state_event_type = execution.result.metadata.get("state_event_type")
                state_event_payload = execution.result.metadata.get("state_event_payload")
                if execution.result.success and state_event_type and isinstance(state_event_payload, dict):
                    self._append(
                        events,
                        state,
                        EventType(str(state_event_type)),
                        actor="state_tool",
                        parent_event_id=execution.result_event.event_id,
                        payload=state_event_payload,
                    )
                self._checkpoint()

                if provider_call.name == "ask_human" and execution.result.success:
                    question = str(execution.result.metadata.get("question", "human assistance requested"))
                    return LoopOutcome(
                        RunStatus.HUMAN_REQUIRED,
                        question,
                        {"handoff": self._human_handoff(state, question, "explicit human gate")},
                    )

                if provider_call.name != "submit_candidate" or not execution.result.success:
                    continue
                outcome = self._validate_candidate(
                    execution.result.metadata,
                    execution.result_event,
                    state,
                    events,
                    tool_context,
                )
                if outcome is not None:
                    return outcome
                self._checkpoint()
            if executions and not any(item.execution.result.success for item in executions):
                no_progress += 1

    def _validate_candidate(
        self,
        metadata: Any,
        result_event: AgentEvent,
        state: SessionState,
        events: AppendOnlyEventStore,
        tool_context: ToolContext,
    ) -> LoopOutcome | None:
        evidence_ids = tuple(str(item) for item in metadata.get("evidence_event_ids", []))
        if not evidence_ids:
            prior_evidence_id = self._last_successful_non_candidate_event(state)
            if prior_evidence_id:
                evidence_ids = (prior_evidence_id,)
        candidate = CandidateSubmission(
            value=str(metadata.get("candidate", "")),
            evidence_event_ids=evidence_ids,
            reproduction=str(metadata.get("reproduction", "")),
        )
        detected = self._append(
            events,
            state,
            EventType.CANDIDATE_DETECTED,
            actor="agent_loop",
            parent_event_id=result_event.event_id,
            payload={
                "candidate": candidate.value,
                "evidence_event_ids": list(candidate.evidence_event_ids),
                "reproduction": candidate.reproduction,
            },
        )
        validation_requested = self._append(
            events,
            state,
            EventType.VALIDATION_REQUESTED,
            actor="agent_loop",
            parent_event_id=detected.event_id,
            payload={"candidate": candidate.value},
        )
        validation = self.validator.validate(
            candidate,
            state=state,
            events=events,
            workspace=tool_context.workspace,
        )
        event_type = self._validation_event_type(validation)
        validation_event = self._append(
            events,
            state,
            event_type,
            actor="validator",
            parent_event_id=validation_requested.event_id,
            payload={
                "candidate": candidate.value,
                "accepted": validation.accepted,
                "level": validation.level,
                "reason": validation.reason,
                "authoritative": validation.authoritative,
                "disposition": validation.disposition,
            },
        )
        self._append(
            events,
            state,
            EventType.VALIDATION_COMPLETED,
            actor="validator",
            parent_event_id=validation_event.event_id,
            payload={
                "candidate": candidate.value,
                "accepted": validation.accepted,
                "level": validation.level,
                "reason": validation.reason,
                "authoritative": validation.authoritative,
                "disposition": validation.disposition,
            },
        )
        if validation.disposition == "pending_external":
            return LoopOutcome(
                RunStatus.PENDING_EXTERNAL,
                validation.reason,
                {
                    "candidate": candidate.value,
                    "evidence_event_ids": list(candidate.evidence_event_ids),
                    "validation_level": validation.level,
                },
            )
        if validation.accepted:
            return LoopOutcome(
                RunStatus.SUCCEEDED,
                output={
                    "candidate": candidate.value,
                    "evidence_event_ids": list(candidate.evidence_event_ids),
                    "validation_level": validation.level,
                },
            )
        return None

    @staticmethod
    def _validation_event_type(validation: ValidationResult) -> EventType:
        if validation.disposition == "pending_external":
            return EventType.CANDIDATE_PENDING_EXTERNAL
        return EventType.CANDIDATE_VALIDATED if validation.accepted else EventType.CANDIDATE_REJECTED

    @staticmethod
    def _last_successful_non_candidate_event(state: SessionState) -> str | None:
        for item in reversed(state.important_tool_results):
            if item.get("tool_name") != "submit_candidate":
                return str(item.get("event_id"))
        return None

    def _append(
        self,
        events: AppendOnlyEventStore,
        state: SessionState,
        event_type: EventType,
        *,
        actor: str,
        payload: dict[str, Any] | None = None,
        parent_event_id: str | None = None,
    ) -> AgentEvent:
        event = events.append(
            state.run_id,
            event_type,
            actor=actor,
            payload=payload,
            parent_event_id=parent_event_id,
            agent_id="agent_root",
            task_id=self._task_id,
        )
        self.reducer.apply(state, event)
        return event

    def _state_update(
        self,
        events: AppendOnlyEventStore,
        state: SessionState,
        changes: dict[str, object],
        parent_event_id: str | None,
        budget: BudgetTracker,
    ) -> None:
        self._append(
            events,
            state,
            EventType.STATE_UPDATED,
            actor="agent_loop",
            parent_event_id=parent_event_id,
            payload={"changes": changes, "budget_usage": budget.usage.to_dict()},
        )

    @staticmethod
    def _human_handoff(state: SessionState, question: str, blocker: str) -> dict[str, Any]:
        return {
            "completed_work": [item.get("summary", "") for item in state.important_tool_results[-10:]],
            "confirmed_facts": list(state.confirmed_facts),
            "evidence": list(state.evidence[-20:]),
            "failed_paths": list(state.failed_hypotheses),
            "minimal_blocker": blocker,
            "questions": [{"id": "human_input_1", "type": "text", "question": question}],
            "recommended_next_step": "Resume the current checkpoint after answering the structured question.",
            "risk": "The active plan remains paused until the answer is recorded.",
            "checkpoint_sequence": state.last_event_sequence,
        }

    def _checkpoint(self) -> None:
        if self.checkpoint_callback is not None:
            self.checkpoint_callback()

    def _compact_if_needed(self, state: SessionState, events: AppendOnlyEventStore) -> None:
        source = events.read(state.run_id)
        if len(source) <= self.context_builder.max_events * 2:
            return
        prior_sequence = int(state.history_summary.get("through_sequence", 0) or 0)
        compactable = source[:-self.context_builder.max_events]
        if not compactable or compactable[-1].sequence <= prior_sequence:
            return
        summary = self.compactor.compact(state, compactable).to_dict()
        self._append(
            events,
            state,
            EventType.CONTEXT_COMPACTED,
            actor="context_compactor",
            payload={"summary": summary},
            parent_event_id=compactable[-1].event_id,
        )

    @staticmethod
    def _budget_ratio(budget: BudgetTracker) -> float:
        usage = budget.usage
        limits = budget.limits
        ratios = (
            usage.elapsed_seconds / max(limits.max_seconds, 0.001),
            usage.model_requests / max(limits.max_model_requests, 1),
            usage.tool_calls / max(limits.max_tool_calls, 1),
            usage.tokens / max(limits.max_tokens, 1),
            usage.cost_usd / max(limits.max_cost_usd, 0.000001),
        )
        return max(ratios)

    def _warn_budget_if_needed(
        self,
        state: SessionState,
        events: AppendOnlyEventStore,
        budget: BudgetTracker,
    ) -> None:
        ratio = self._budget_ratio(budget)
        if ratio < 0.8 or self._budget_warning_emitted:
            return
        self._budget_warning_emitted = True
        self._append(
            events,
            state,
            EventType.BUDGET_WARNING,
            actor="budget_tracker",
            payload={"ratio": ratio, "usage": budget.usage.to_dict()},
        )
