from __future__ import annotations

from dataclasses import dataclass

from app.agent_engine.agents.roles import default_role_execution_profiles
from app.agent_engine.contracts.task import TaskNode
from app.agent_engine.orchestration.dynamic_scheduler import SchedulerOutcome
from app.agent_engine.orchestration.planner import PlanNodeProposal, TaskBudgetProposal
from app.agent_engine.orchestration.task_graph_store import PlanPatch, PlanPatchOperation, TaskGraphStore


@dataclass(frozen=True)
class GraphReplanResult:
    patch: PlanPatch | None
    action: str
    reason: str
    requires_human: bool = False


class EvidenceDrivenGraphReplanner:
    """Create finite structural patches after a real scheduler failure."""

    def __init__(self, *, max_task_attempts: int = 2) -> None:
        self.max_task_attempts = max(1, max_task_attempts)
        self.role_profiles = default_role_execution_profiles()

    def propose(self, store: TaskGraphStore, outcome: SchedulerOutcome) -> GraphReplanResult:
        failed = [store.graph.nodes[task_id] for task_id in outcome.failed_task_ids if task_id in store.graph.nodes]
        if not failed:
            return GraphReplanResult(None, "request_human", "scheduler blocked without a failed task", True)
        if any(node.attempt >= self.max_task_attempts for node in failed):
            return GraphReplanResult(
                None,
                "request_human",
                "a task exhausted its bounded alternate-strategy attempts",
                True,
            )
        operations: list[PlanPatchOperation] = []
        actions: list[str] = []
        for node in failed:
            if node.role == "verifier":
                refuter_id = f"{node.task_id}_refuter_v{store.plan.version + 1}"
                refuter_tools = tuple(
                    tool for tool in self.role_profiles["refuter"].tool_capabilities
                    if tool in set(store.available_tools)
                )
                refuter = PlanNodeProposal(
                    task_id=refuter_id,
                    title=f"Refute blocked verdict for {node.title}",
                    role="refuter",
                    objective="Independently seek counter-evidence and alternate explanations for the rejected verdict.",
                    dependencies=list(node.dependencies),
                    inputs=list(node.inputs),
                    context_refs=list(node.context_refs),
                    allowed_capabilities=list(refuter_tools),
                    expected_outputs=["counter-evidence verdict"],
                    success_criteria=["counter-evidence is bound to reproducible tool results"],
                    failure_signals=["no independent evidence", "executor wording copied"],
                    budget=TaskBudgetProposal(**node.budget.__dict__),
                    priority=node.priority + 1,
                    parallel_group="independent_review",
                    workspace_policy="isolated",
                    verification_policy="clean_context",
                )
                operations.append(PlanPatchOperation(operation="add_node", node=refuter))
                dependencies = list(dict.fromkeys((*node.dependencies, refuter_id)))
                actions.append("review_refute")
            else:
                dependencies = list(node.dependencies)
                actions.append("switch_hypothesis")
            replacement_id = f"{node.task_id}_alternative_v{store.plan.version + 1}"
            replacement = self._replacement(node, replacement_id, dependencies)
            operations.append(PlanPatchOperation(
                operation="replace_node",
                task_id=node.task_id,
                node=replacement,
            ))
            operations.append(PlanPatchOperation(
                operation="change_hypothesis",
                hypothesis_id=f"hyp_alternative_{replacement_id}",
                hypothesis={
                    "statement": f"A disjoint strategy can replace blocked task {node.task_id}.",
                    "falsification_test": f"Execute {replacement_id} once with a changed strategy/tool path.",
                    "success_signal": "new independently referenced evidence",
                    "status": "open",
                },
            ))
        reason = f"scheduler failure triggered structural replan: {', '.join(outcome.failed_task_ids)}"
        patch = PlanPatch(
            reason=reason,
            evidence_refs=list(outcome.evidence_ids),
            operations=operations,
        )
        return GraphReplanResult(patch, "+".join(dict.fromkeys(actions)), reason)

    @staticmethod
    def _replacement(node: TaskNode, replacement_id: str, dependencies: list[str]) -> PlanNodeProposal:
        return PlanNodeProposal(
            task_id=replacement_id,
            title=f"Alternate strategy: {node.title}",
            role=node.role,
            objective=(node.objective or node.title) + " Use a disjoint hypothesis or tool path; do not repeat identical calls.",
            dependencies=dependencies,
            inputs=list(node.inputs),
            context_refs=list(node.context_refs),
            allowed_capabilities=list(node.allowed_tools),
            expected_outputs=list(node.expected_outputs or (node.expected_output,)),
            success_criteria=list(node.success_criteria),
            failure_signals=list(node.failure_signals or ("same error repeats", "no evidence gain")),
            budget=TaskBudgetProposal(**node.budget.__dict__),
            priority=node.priority + 1,
            parallel_group=node.parallel_group,
            workspace_policy=node.workspace_policy,
            verification_policy=node.verification_policy,
            attempt=node.attempt + 1,
        )

