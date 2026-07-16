from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable, Mapping

from app.agent_engine.events import AgentEvent, EventType
from app.agent_engine.state import RunStatus, SessionState


def _upsert(items: list[dict[str, Any]], value: Mapping[str, Any], key: str) -> None:
    incoming = dict(value)
    identity = incoming.get(key)
    if identity is None:
        items.append(incoming)
        return
    for index, item in enumerate(items):
        if item.get(key) == identity:
            items[index] = {**item, **incoming}
            return
    items.append(incoming)


def _patch_agent(items: list[dict[str, Any]], agent_id: str, changes: Mapping[str, Any]) -> None:
    for item in items:
        if item.get("agent_id") == agent_id:
            item.update(changes)
            return


class StateReducer:
    """Deterministically project canonical events into one mutable session view."""

    def initial(self, run_id: str, objective: str) -> SessionState:
        return SessionState(run_id=run_id, objective=objective)

    def replay(
        self,
        run_id: str,
        objective: str,
        events: Iterable[AgentEvent],
    ) -> SessionState:
        state = self.initial(run_id, objective)
        for event in sorted(events, key=lambda item: item.sequence):
            self.apply(state, event)
        return state

    def apply(self, state: SessionState, event: AgentEvent) -> SessionState:
        if event.run_id != state.run_id or event.sequence <= state.last_event_sequence:
            return state
        payload = dict(event.payload)
        event_type = event.type

        if event_type == EventType.RUN_STARTED.value:
            state.status = RunStatus.RUNNING
        elif event_type == EventType.RUN_SUCCEEDED.value:
            state.status = RunStatus.SUCCEEDED
        elif event_type == EventType.RUN_FAILED.value:
            state.status = RunStatus.FAILED
        elif event_type == EventType.RUN_CANCELLED.value:
            state.status = RunStatus.CANCELLED
        elif event_type == EventType.RUN_TIMED_OUT.value:
            state.status = RunStatus.TIMED_OUT
        elif event_type == EventType.HUMAN_REQUESTED.value:
            state.status = RunStatus.HUMAN_REQUIRED
            state.human_handoff = deepcopy(payload.get("handoff") or payload.get("output", {}).get("handoff"))
        elif event_type == EventType.HUMAN_ANSWERED.value:
            state.status = RunStatus(payload.get("resume_status", RunStatus.RUNNING.value))
            state.human_handoff = None
        elif event_type == EventType.CANDIDATE_PENDING_EXTERNAL.value:
            state.status = RunStatus.PENDING_EXTERNAL
        elif event_type == EventType.CANDIDATE_EXTERNALLY_REJECTED.value:
            state.status = RunStatus.RUNNING
        elif event_type == EventType.COMPLETION_DECIDED.value:
            state.error = str(payload.get("error", ""))
            state.final_output = deepcopy(payload.get("output") or None)
        elif event_type == EventType.CONTEXT_COMPACTED.value:
            state.history_summary = deepcopy(payload.get("summary") or {})

        if event_type in {EventType.PLAN_PROPOSED.value, EventType.PLAN_ACCEPTED.value, EventType.PLAN_REVISED.value}:
            plan = deepcopy(payload.get("plan") or {})
            if plan:
                state.current_plan = plan
                _upsert(state.plan_history, {
                    "event_id": event.event_id,
                    "type": event_type,
                    "plan": plan,
                    "reason": payload.get("reason", ""),
                    "old_version": payload.get("old_version"),
                    "new_version": payload.get("new_version"),
                    "diff": deepcopy(payload.get("diff") or []),
                    "evidence_refs": list(payload.get("evidence_refs") or []),
                }, "event_id")
        elif event_type in {
            EventType.PLAN_NODE_STARTED.value,
            EventType.PLAN_NODE_BLOCKED.value,
            EventType.PLAN_COMPLETED.value,
        }:
            self._update_plan_node(state, payload, event_type)

        if event_type in {
            EventType.TASK_SCHEDULED.value,
            EventType.TASK_STARTED.value,
            EventType.TASK_BLOCKED.value,
            EventType.TASK_COMPLETED.value,
        }:
            task = deepcopy(payload.get("task") or payload)
            task.setdefault("status", event_type.rsplit(".", 1)[-1])
            _upsert(state.tasks, task, "task_id")
        elif event_type in {
            EventType.AGENT_SPAWNED.value,
            EventType.AGENT_RESUMED.value,
            EventType.AGENT_CANCELLED.value,
            EventType.AGENT_COMPLETED.value,
        }:
            agent = deepcopy(payload.get("agent") or payload)
            agent.setdefault("agent_id", event.agent_id)
            agent.setdefault("status", event_type.rsplit(".", 1)[-1])
            summary = payload.get("summary")
            if isinstance(summary, Mapping):
                agent["handoff_summary"] = summary.get("summary", "")
                agent["verdict"] = summary.get("verdict", "")
                agent["evidence_refs"] = [
                    item.get("evidence_id") or item.get("event_id")
                    for item in summary.get("evidence", ())
                    if item.get("evidence_id") or item.get("event_id")
                ]
                agent["artifact_refs"] = [
                    item.get("artifact_id") or item.get("path")
                    for item in summary.get("artifacts", ())
                    if item.get("artifact_id") or item.get("path")
                ]
            _upsert(state.agents, agent, "agent_id")

        if event.agent_id and event.agent_id != "agent_root":
            if event_type == EventType.TOOL_STARTED.value:
                _patch_agent(state.agents, event.agent_id, {
                    "active_tool": payload.get("name", ""),
                    "active_tool_call_id": payload.get("tool_call_id", ""),
                })
            elif event_type in {EventType.TOOL_FINISHED.value, EventType.TOOL_FAILED.value}:
                _patch_agent(state.agents, event.agent_id, {
                    "active_tool": "",
                    "last_tool": payload.get("name", ""),
                    "last_tool_success": event_type == EventType.TOOL_FINISHED.value and payload.get("success", True),
                })
            elif event_type == EventType.MODEL_RESPONDED.value:
                _patch_agent(state.agents, event.agent_id, {
                    "usage": dict(payload.get("usage") or {}),
                    "budget": dict(payload.get("budget_usage") or {}),
                    "decision_summary": payload.get("decision_summary", ""),
                })

        if event_type == EventType.FACT_CONFIRMED.value:
            fact = payload.get("fact") or payload
            if fact.get("evidence_ids") or fact.get("source_event_ids"):
                _upsert(state.confirmed_facts, fact, "fact_id")
        elif event_type == EventType.FACT_RETRACTED.value:
            fact_id = payload.get("fact_id")
            state.confirmed_facts = [item for item in state.confirmed_facts if item.get("fact_id") != fact_id]
        elif event_type == EventType.HYPOTHESIS_PROPOSED.value:
            _upsert(state.open_hypotheses, payload.get("hypothesis") or payload, "hypothesis_id")
        elif event_type in {EventType.HYPOTHESIS_CONFIRMED.value, EventType.HYPOTHESIS_REFUTED.value}:
            hypothesis = dict(payload.get("hypothesis") or payload)
            if event_type == EventType.HYPOTHESIS_CONFIRMED.value and not (
                hypothesis.get("evidence_ids") or hypothesis.get("source_event_ids")
            ):
                state.last_event_sequence = event.sequence
                return state
            hypothesis_id = hypothesis.get("hypothesis_id")
            state.open_hypotheses = [
                item for item in state.open_hypotheses if item.get("hypothesis_id") != hypothesis_id
            ]
            if event_type == EventType.HYPOTHESIS_REFUTED.value:
                hypothesis["status"] = "refuted"
                _upsert(state.failed_hypotheses, hypothesis, "hypothesis_id")
        elif event_type == EventType.EVIDENCE_RECORDED.value:
            _upsert(state.evidence, payload.get("evidence") or payload, "evidence_id")
        elif event_type == EventType.CONTRADICTION_RECORDED.value:
            _upsert(state.contradictions, payload.get("contradiction") or payload, "contradiction_id")
        elif event_type == EventType.DECISION_RECORDED.value:
            _upsert(state.decisions, payload.get("decision") or payload, "decision_id")
        elif event_type == EventType.ARTIFACT_INGESTED.value:
            _upsert(state.artifacts, payload.get("artifact") or payload, "artifact_id")

        if event_type in {EventType.TOOL_FINISHED.value, EventType.TOOL_FAILED.value}:
            if event_type == EventType.TOOL_FINISHED.value and payload.get("success", True):
                _upsert(state.important_tool_results, {
                    "event_id": event.event_id,
                    "tool_call_id": payload.get("tool_call_id"),
                    "tool_name": payload.get("name"),
                    "summary": payload.get("summary", ""),
                }, "event_id")
                state.important_tool_results = state.important_tool_results[-50:]
            for artifact in payload.get("artifacts", []):
                _upsert(state.artifacts, artifact, "artifact_id" if artifact.get("artifact_id") else "path")

        if event_type == EventType.CANDIDATE_DETECTED.value:
            _upsert(state.candidate_answers, {
                "candidate": payload.get("candidate", ""),
                "evidence_event_ids": list(payload.get("evidence_event_ids", [])),
                "status": "detected",
            }, "candidate")
        elif event_type in {
            EventType.CANDIDATE_VALIDATED.value,
            EventType.CANDIDATE_REJECTED.value,
            EventType.CANDIDATE_PENDING_EXTERNAL.value,
            EventType.CANDIDATE_EXTERNALLY_ACCEPTED.value,
            EventType.CANDIDATE_EXTERNALLY_REJECTED.value,
        }:
            statuses = {
                EventType.CANDIDATE_VALIDATED.value: "validated",
                EventType.CANDIDATE_REJECTED.value: "rejected",
                EventType.CANDIDATE_PENDING_EXTERNAL.value: "submitted_pending_external",
                EventType.CANDIDATE_EXTERNALLY_ACCEPTED.value: "externally_accepted",
                EventType.CANDIDATE_EXTERNALLY_REJECTED.value: "externally_rejected",
            }
            _upsert(state.candidate_answers, {
                "candidate": payload.get("candidate", ""),
                "status": statuses[event_type],
                "completion_state": {
                    EventType.CANDIDATE_VALIDATED.value: "locally_validated",
                    EventType.CANDIDATE_REJECTED.value: "externally_rejected" if payload.get("authoritative") else "rejected",
                    EventType.CANDIDATE_PENDING_EXTERNAL.value: "submitted_pending_external",
                    EventType.CANDIDATE_EXTERNALLY_ACCEPTED.value: "externally_accepted",
                    EventType.CANDIDATE_EXTERNALLY_REJECTED.value: "externally_rejected",
                }[event_type],
                "validation": payload.get("reason", ""),
                "authoritative": bool(payload.get("authoritative", False)),
            }, "candidate")

        if event_type in {EventType.MODEL_RESPONDED.value, EventType.STATE_UPDATED.value}:
            usage = payload.get("budget_usage") or payload.get("usage")
            if isinstance(usage, Mapping):
                state.budget_usage = {**state.budget_usage, **dict(usage)}

        state.last_event_sequence = event.sequence
        return state

    @staticmethod
    def _update_plan_node(state: SessionState, payload: Mapping[str, Any], event_type: str) -> None:
        node_id = payload.get("task_id") or payload.get("node_id")
        if not node_id or not state.current_plan:
            return
        status = {
            EventType.PLAN_NODE_STARTED.value: "running",
            EventType.PLAN_NODE_BLOCKED.value: "blocked",
            EventType.PLAN_COMPLETED.value: "completed",
        }[event_type]
        for node in state.current_plan.get("nodes", []):
            if node.get("task_id") == node_id:
                node["status"] = status
                if payload.get("reason"):
                    node["status_reason"] = payload["reason"]
                break
