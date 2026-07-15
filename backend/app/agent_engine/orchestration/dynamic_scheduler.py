from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from app.agent_engine.agents.base import AgentSummary, ContextPolicy, WorkspacePolicy
from app.agent_engine.abort import AbortToken
from app.agent_engine.contracts.task import TaskStatus
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.orchestration.task_graph import TaskGraph


@dataclass(frozen=True)
class SchedulerOutcome:
    success: bool
    completed_task_ids: tuple[str, ...]
    failed_task_ids: tuple[str, ...]
    cancelled_task_ids: tuple[str, ...]
    summaries: Mapping[str, AgentSummary]
    evidence_ids: tuple[str, ...]
    reason: str = ""


class DynamicTaskScheduler:
    """Execute dependency-ready graph nodes in bounded parallel waves."""

    def __init__(
        self,
        run_id: str,
        graph: TaskGraph,
        manager: SubagentManager,
        events: AppendOnlyEventStore,
        *,
        max_concurrency: int = 4,
        abort_token: AbortToken | None = None,
    ) -> None:
        self.run_id = run_id
        self.graph = graph
        self.manager = manager
        self.events = events
        self.max_concurrency = max(1, max_concurrency)
        self.abort_token = abort_token
        self.completed: set[str] = {
            node.task_id for node in graph.nodes.values() if node.status == TaskStatus.COMPLETED
        }
        self.failed: set[str] = {
            node.task_id for node in graph.nodes.values() if node.status in {TaskStatus.BLOCKED, TaskStatus.FAILED}
        }
        self.cancelled: set[str] = {
            node.task_id for node in graph.nodes.values() if node.status == TaskStatus.CANCELLED
        }
        self.summaries: dict[str, AgentSummary] = {
            record.task.task_id: record.summary
            for record in manager.records()
            if record.summary is not None
        }

    def update_graph(self, graph: TaskGraph) -> None:
        self.graph = graph
        known = set(graph.nodes)
        self.completed.intersection_update(known)
        self.failed.intersection_update(known)
        self.cancelled = {
            node.task_id for node in graph.nodes.values() if node.status == TaskStatus.CANCELLED
        }
        self.failed.difference_update(self.cancelled)

    def execute_until_blocked(self) -> SchedulerOutcome:
        while True:
            if self.abort_token is not None and self.abort_token.is_aborted:
                return self._outcome(False, self.abort_token.reason)
            active_nodes = {
                task_id for task_id, node in self.graph.nodes.items()
                if node.status != TaskStatus.CANCELLED
            }
            if active_nodes <= self.completed:
                return self._outcome(True, "all active graph nodes completed")
            ready = [
                node for node in self.graph.ready(self.completed, ())
                if node.status != TaskStatus.CANCELLED
                and node.task_id not in self.completed
                and node.task_id not in self.failed
            ]
            ready.sort(key=lambda node: (-node.priority, node.task_id))
            if not ready:
                return self._outcome(False, "graph has no dependency-ready node")
            wave = self._select_wave(ready)
            if not wave:
                return self._outcome(False, "ready nodes exceed active role capacity")
            spawned: list[tuple[str, str]] = []
            for node in wave:
                if self.abort_token is not None and self.abort_token.is_aborted:
                    self._cancel_and_join(spawned)
                    return self._outcome(False, self.abort_token.reason)
                started = self.events.append(
                    self.run_id,
                    EventType.PLAN_NODE_STARTED,
                    actor="dynamic_scheduler",
                    task_id=node.task_id,
                    payload={"task_id": node.task_id, "attempt": node.attempt, "priority": node.priority},
                )
                dependency_summaries = [self.summaries[item] for item in node.dependencies if item in self.summaries]
                context = ContextPolicy(
                    fact_ids=tuple(
                        str(fact.get("fact_id"))
                        for summary in dependency_summaries
                        for fact in summary.facts
                        if fact.get("fact_id")
                    ),
                    hypothesis_ids=tuple(
                        str(hypothesis.get("hypothesis_id"))
                        for summary in dependency_summaries
                        for hypothesis in summary.hypotheses
                        if hypothesis.get("hypothesis_id")
                    ),
                    evidence_ids=tuple(
                        str(evidence.get("evidence_id") or evidence.get("event_id"))
                        for summary in dependency_summaries
                        for evidence in summary.evidence
                        if evidence.get("evidence_id") or evidence.get("event_id")
                    ),
                    artifact_ids=tuple(
                        str(artifact.get("artifact_id") or artifact.get("path"))
                        for summary in dependency_summaries
                        for artifact in summary.artifacts
                        if artifact.get("artifact_id") or artifact.get("path")
                    ),
                )
                workspace_policy = WorkspacePolicy(
                    mode=node.workspace_policy,
                    writable=node.role == "executor" and node.workspace_policy != "shared_readonly",
                )
                agent_id = self.manager.spawn(
                    node.role,
                    node,
                    context,
                    node.budget,
                    workspace_policy,
                )
                spawned.append((node.task_id, agent_id))
                if self.abort_token is not None and self.abort_token.is_aborted:
                    self._cancel_and_join(spawned)
                    return self._outcome(False, self.abort_token.reason)
                self.events.append(
                    self.run_id,
                    EventType.DECISION_RECORDED,
                    actor="dynamic_scheduler",
                    parent_event_id=started.event_id,
                    agent_id=agent_id,
                    task_id=node.task_id,
                    payload={"decision": {
                        "decision_id": f"dispatch_{node.task_id}_{node.attempt}",
                        "decision": "dispatch dependency-ready node",
                        "rationale": f"dependencies satisfied: {list(node.dependencies)}",
                        "evidence_ids": list(context.evidence_ids),
                        "risks": list(node.failure_signals),
                    }},
                )
            timeout = max(self.graph.nodes[task_id].budget.max_seconds for task_id, _ in spawned) + 2
            joined = self.manager.join([agent_id for _, agent_id in spawned], "synthesize", timeout=timeout)
            wave_failed = False
            for (task_id, agent_id), summary in zip(spawned, joined.summaries):
                self.summaries[task_id] = summary
                if summary.status == "completed":
                    self.completed.add(task_id)
                    event_type = EventType.PLAN_COMPLETED
                else:
                    self.failed.add(task_id)
                    wave_failed = True
                    event_type = EventType.PLAN_NODE_BLOCKED
                self.events.append(
                    self.run_id,
                    event_type,
                    actor="dynamic_scheduler",
                    agent_id=agent_id,
                    task_id=task_id,
                    payload={
                        "task_id": task_id,
                        "reason": summary.error,
                        "summary": summary.to_dict(),
                    },
                )
            if wave_failed:
                return self._outcome(False, "one or more graph nodes were blocked")

    def _select_wave(self, ready):
        selected = []
        per_role: dict[str, int] = {}
        for node in ready:
            role_limit = self.manager.role_profiles[node.role].max_instances
            if per_role.get(node.role, 0) >= role_limit:
                continue
            selected.append(node)
            per_role[node.role] = per_role.get(node.role, 0) + 1
            if len(selected) >= self.max_concurrency:
                break
        return selected

    def _cancel_and_join(self, spawned: list[tuple[str, str]]) -> None:
        reason = self.abort_token.reason if self.abort_token is not None else "scheduler cancelled"
        agent_ids = [agent_id for _, agent_id in spawned]
        for agent_id in agent_ids:
            self.manager.cancel(agent_id, reason)
        if agent_ids:
            self.manager.join(agent_ids, "synthesize", timeout=2)

    def _outcome(self, success: bool, reason: str) -> SchedulerOutcome:
        evidence_ids = tuple(dict.fromkeys(
            str(item.get("evidence_id") or item.get("event_id"))
            for summary in self.summaries.values()
            for item in summary.evidence
            if item.get("evidence_id") or item.get("event_id")
        ))
        return SchedulerOutcome(
            success,
            tuple(sorted(self.completed)),
            tuple(sorted(self.failed)),
            tuple(sorted(self.cancelled)),
            dict(self.summaries),
            evidence_ids,
            reason,
        )
