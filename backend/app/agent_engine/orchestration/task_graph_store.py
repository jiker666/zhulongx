from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Literal, Mapping

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.agent_engine.contracts.plan import Plan
from app.agent_engine.contracts.task import TaskBudget, TaskNode, TaskStatus
from app.agent_engine.orchestration.planner import PlanNodeProposal
from app.agent_engine.orchestration.task_graph import TaskGraph


PatchOperationName = Literal[
    "add_node",
    "replace_node",
    "split_node",
    "cancel_node",
    "add_dependency",
    "remove_dependency",
    "reprioritize",
    "change_role",
    "change_budget",
    "change_tool_scope",
    "change_hypothesis",
]


class PlanPatchOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation: PatchOperationName
    task_id: str = ""
    dependency_id: str = ""
    node: PlanNodeProposal | None = None
    nodes: list[PlanNodeProposal] = Field(default_factory=list)
    priority: int | None = None
    role: str = ""
    budget: dict[str, Any] = Field(default_factory=dict)
    allowed_capabilities: list[str] = Field(default_factory=list, max_length=128)
    hypothesis_id: str = ""
    hypothesis: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_shape(self):
        if self.operation in {"add_node", "replace_node"} and self.node is None:
            raise ValueError(f"{self.operation} requires node")
        if self.operation == "split_node" and len(self.nodes) < 2:
            raise ValueError("split_node requires at least two nodes")
        if self.operation != "add_node" and not self.task_id and self.operation != "change_hypothesis":
            raise ValueError(f"{self.operation} requires task_id")
        return self


class PlanPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=20_000)
    evidence_refs: list[str] = Field(default_factory=list)
    operations: list[PlanPatchOperation] = Field(min_length=1, max_length=50)


@dataclass(frozen=True)
class PlanRevision:
    old_version: int
    new_version: int
    plan: Plan
    diff: tuple[Mapping[str, Any], ...]
    reason: str
    evidence_refs: tuple[str, ...]


class TaskGraphStore:
    def __init__(
        self,
        plan: Plan,
        *,
        allowed_roles: tuple[str, ...],
        available_tools: tuple[str, ...],
        max_total_tool_calls: int = 2000,
    ) -> None:
        self.allowed_roles = allowed_roles
        self.available_tools = available_tools
        self.max_total_tool_calls = max_total_tool_calls
        self._versions: dict[int, Plan] = {plan.version: plan}
        self._current = TaskGraph(plan, allowed_roles=allowed_roles, available_tools=available_tools)
        self._validate_budget(plan)

    @property
    def plan(self) -> Plan:
        return self._current.plan

    @property
    def graph(self) -> TaskGraph:
        return self._current

    def versions(self) -> tuple[Plan, ...]:
        return tuple(self._versions[index] for index in sorted(self._versions))

    def apply(
        self,
        patch: PlanPatch,
        *,
        protected_task_ids: set[str] | None = None,
        completed_task_ids: set[str] | None = None,
        failed_task_ids: set[str] | None = None,
    ) -> PlanRevision:
        protected = protected_task_ids or set()
        old = self.plan
        nodes = {node.task_id: node for node in old.nodes}
        for task_id in completed_task_ids or set():
            if task_id in nodes:
                nodes[task_id] = replace(nodes[task_id], status=TaskStatus.COMPLETED)
        for task_id in failed_task_ids or set():
            if task_id in nodes:
                nodes[task_id] = replace(nodes[task_id], status=TaskStatus.FAILED)
        hypotheses = {str(item.get("hypothesis_id")): dict(item) for item in old.hypotheses}
        diff: list[Mapping[str, Any]] = []
        for operation in patch.operations:
            name = operation.operation
            task_id = operation.task_id
            if name == "add_node":
                assert operation.node is not None
                node = operation.node.to_task_node()
                if node.task_id in nodes:
                    raise ValueError(f"patch adds duplicate task: {node.task_id}")
                nodes[node.task_id] = node
                diff.append({"operation": name, "task_id": node.task_id, "node": node.to_dict()})
            elif name == "replace_node":
                assert operation.node is not None
                self._require_node(nodes, task_id)
                if task_id in protected:
                    raise ValueError(f"cannot replace protected evidence task: {task_id}")
                replacement = operation.node.to_task_node()
                if replacement.task_id != task_id and replacement.task_id in nodes:
                    raise ValueError(f"replacement task already exists: {replacement.task_id}")
                nodes[task_id] = replace(nodes[task_id], status=TaskStatus.CANCELLED)
                nodes[replacement.task_id] = replacement
                self._rewire(nodes, task_id, (replacement.task_id,))
                diff.append({
                    "operation": name,
                    "task_id": task_id,
                    "replacement_task_id": replacement.task_id,
                    "node": replacement.to_dict(),
                })
            elif name == "split_node":
                self._require_node(nodes, task_id)
                if task_id in protected:
                    raise ValueError(f"cannot split protected evidence task: {task_id}")
                replacements = tuple(item.to_task_node() for item in operation.nodes)
                if any(node.task_id in nodes for node in replacements):
                    raise ValueError("split task id already exists")
                nodes[task_id] = replace(nodes[task_id], status=TaskStatus.CANCELLED)
                for node in replacements:
                    nodes[node.task_id] = node
                self._rewire(nodes, task_id, tuple(node.task_id for node in replacements))
                diff.append({"operation": name, "task_id": task_id, "new_task_ids": [node.task_id for node in replacements]})
            elif name == "cancel_node":
                self._require_node(nodes, task_id)
                if task_id in protected:
                    raise ValueError(f"cannot cancel protected evidence task: {task_id}")
                nodes[task_id] = replace(nodes[task_id], status=TaskStatus.CANCELLED)
                diff.append({"operation": name, "task_id": task_id})
            elif name in {"add_dependency", "remove_dependency"}:
                self._require_node(nodes, task_id)
                self._require_node(nodes, operation.dependency_id)
                dependencies = list(nodes[task_id].dependencies)
                if name == "add_dependency" and operation.dependency_id not in dependencies:
                    dependencies.append(operation.dependency_id)
                if name == "remove_dependency":
                    dependencies = [item for item in dependencies if item != operation.dependency_id]
                nodes[task_id] = replace(nodes[task_id], dependencies=tuple(dependencies))
                diff.append({"operation": name, "task_id": task_id, "dependency_id": operation.dependency_id})
            elif name == "reprioritize":
                self._require_node(nodes, task_id)
                if operation.priority is None:
                    raise ValueError("reprioritize requires priority")
                nodes[task_id] = replace(nodes[task_id], priority=operation.priority)
                diff.append({"operation": name, "task_id": task_id, "priority": operation.priority})
            elif name == "change_role":
                self._require_node(nodes, task_id)
                nodes[task_id] = replace(nodes[task_id], role=operation.role)
                diff.append({"operation": name, "task_id": task_id, "role": operation.role})
            elif name == "change_budget":
                self._require_node(nodes, task_id)
                budget = TaskBudget(**{**nodes[task_id].budget.__dict__, **operation.budget})
                nodes[task_id] = replace(nodes[task_id], budget=budget)
                diff.append({"operation": name, "task_id": task_id, "budget": budget.__dict__})
            elif name == "change_tool_scope":
                self._require_node(nodes, task_id)
                nodes[task_id] = replace(nodes[task_id], allowed_tools=tuple(operation.allowed_capabilities))
                diff.append({"operation": name, "task_id": task_id, "allowed_tools": operation.allowed_capabilities})
            elif name == "change_hypothesis":
                if not operation.hypothesis_id:
                    raise ValueError("change_hypothesis requires hypothesis_id")
                hypotheses[operation.hypothesis_id] = {
                    "hypothesis_id": operation.hypothesis_id,
                    **operation.hypothesis,
                }
                diff.append({"operation": name, "hypothesis_id": operation.hypothesis_id})
        ordered = self._stable_order(old, nodes)
        revised = replace(
            old,
            version=old.version + 1,
            nodes=ordered,
            hypotheses=tuple(hypotheses.values()),
            revision_reason=patch.reason,
        )
        self._validate_budget(revised)
        graph = TaskGraph(revised, allowed_roles=self.allowed_roles, available_tools=self.available_tools)
        self._versions[revised.version] = revised
        self._current = graph
        return PlanRevision(
            old.version,
            revised.version,
            revised,
            tuple(diff),
            patch.reason,
            tuple(patch.evidence_refs),
        )

    def _validate_budget(self, plan: Plan) -> None:
        total = sum(node.budget.max_tool_calls for node in plan.nodes if node.status != TaskStatus.CANCELLED)
        if total > self.max_total_tool_calls:
            raise ValueError("plan patch exceeds total tool budget")

    @staticmethod
    def _require_node(nodes: Mapping[str, TaskNode], task_id: str) -> None:
        if task_id not in nodes:
            raise ValueError(f"patch references unknown task: {task_id}")

    @staticmethod
    def _rewire(nodes: dict[str, TaskNode], old_id: str, new_ids: tuple[str, ...]) -> None:
        for task_id, node in tuple(nodes.items()):
            if task_id == old_id or old_id not in node.dependencies:
                continue
            dependencies: list[str] = []
            for dependency in node.dependencies:
                dependencies.extend(new_ids if dependency == old_id else (dependency,))
            nodes[task_id] = replace(node, dependencies=tuple(dict.fromkeys(dependencies)))

    @staticmethod
    def _stable_order(old: Plan, nodes: Mapping[str, TaskNode]) -> tuple[TaskNode, ...]:
        ordered = [nodes[node.task_id] for node in old.nodes if node.task_id in nodes]
        known = {node.task_id for node in ordered}
        ordered.extend(node for task_id, node in nodes.items() if task_id not in known)
        return tuple(ordered)
