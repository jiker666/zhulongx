from __future__ import annotations

import json
from pathlib import Path

from app.agent_engine.contracts.completion import CandidateState, CompletionDecision
from app.agent_engine.contracts.plan import Plan
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.dynamic_scheduler import SchedulerOutcome
from app.agent_engine.state import RunRequest, SessionState
from app.agent_engine.validation.base import CandidateSubmission, Validator


class CoordinatorCompletionPolicy:
    """Only scenario validation plus independent verification can complete a root run."""

    def __init__(self, validator: Validator) -> None:
        self.validator = validator

    def decide(
        self,
        request: RunRequest,
        plan: Plan,
        outcome: SchedulerOutcome,
        state: SessionState,
        events: AppendOnlyEventStore,
        workspace: Path,
    ) -> CompletionDecision:
        if not outcome.success:
            return CompletionDecision("incomplete", outcome.reason, outcome.evidence_ids)
        if not outcome.evidence_ids:
            return CompletionDecision("incomplete", "completed graph produced no evidence", ())
        verifier_ids = [node.task_id for node in plan.nodes if node.role == "verifier" and node.status.value != "cancelled"]
        if not verifier_ids:
            return CompletionDecision("incomplete", "completion contract has no independent verifier", outcome.evidence_ids)
        verifier_summaries = [outcome.summaries.get(task_id) for task_id in verifier_ids]
        if not all(summary and summary.status == "completed" for summary in verifier_summaries):
            return CompletionDecision("incomplete", "independent verifier did not complete", outcome.evidence_ids)
        explicit_verdicts = [summary.verdict for summary in verifier_summaries if summary]
        if any(not verdict for verdict in explicit_verdicts):
            return CompletionDecision("incomplete", "independent verifier omitted its structured verdict", outcome.evidence_ids)
        if any(verdict != "accepted" for verdict in explicit_verdicts):
            return CompletionDecision("rejected", "independent verifier rejected or found insufficient evidence", outcome.evidence_ids)
        candidate, evidence_ids, reproduction = self._candidate(request, outcome, state)
        if candidate is None:
            return CompletionDecision("incomplete", "no validator candidate or structured result was produced", outcome.evidence_ids)
        requested = events.append(
            state.run_id,
            EventType.VALIDATION_REQUESTED,
            actor="completion_policy",
            agent_id="agent_root",
            task_id=request.task_id,
            payload={"candidate": candidate, "evidence_event_ids": list(evidence_ids)},
        )
        result = self.validator.validate(
            CandidateSubmission(candidate, evidence_ids, reproduction),
            state=state,
            events=events,
            workspace=workspace,
        )
        events.append(
            state.run_id,
            EventType.VALIDATION_COMPLETED,
            actor="completion_policy",
            parent_event_id=requested.event_id,
            agent_id="agent_root",
            task_id=request.task_id,
            payload={
                "accepted": result.accepted,
                "level": result.level,
                "reason": result.reason,
                "authoritative": result.authoritative,
                "disposition": result.disposition,
            },
        )
        output = {
            "candidate": candidate,
            "evidence_ids": list(evidence_ids),
            "validation_level": result.level,
            "validator_reason": result.reason,
            "plan_version": plan.version,
        }
        if result.accepted:
            return CompletionDecision(
                "succeeded",
                result.reason,
                evidence_ids,
                CandidateState.LOCALLY_VALIDATED,
                output,
            )
        if result.disposition == "pending_external" and plan.completion_contract.get("pending_external_allowed", False):
            return CompletionDecision(
                "pending_external",
                result.reason,
                evidence_ids,
                CandidateState.PENDING_EXTERNAL,
                output,
            )
        return CompletionDecision("rejected", result.reason, evidence_ids, output=output)

    @staticmethod
    def _candidate(
        request: RunRequest,
        outcome: SchedulerOutcome,
        state: SessionState,
    ) -> tuple[str | None, tuple[str, ...], str]:
        candidates = [
            item for item in state.candidate_answers
            if item.get("status") not in {"rejected", "externally_rejected"}
        ]
        if candidates:
            selected = candidates[-1]
            evidence_ids = tuple(str(item) for item in selected.get("evidence_event_ids", ()) if item)
            return str(selected.get("candidate") or ""), evidence_ids or outcome.evidence_ids, str(selected.get("reproduction") or "")
        if request.scenario == "ctf":
            return None, (), ""
        for summary in reversed(tuple(outcome.summaries.values())):
            try:
                parsed = json.loads(summary.summary)
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(parsed, dict):
                return json.dumps(parsed, ensure_ascii=False, sort_keys=True), outcome.evidence_ids, "independent graph execution"
        return None, (), ""
