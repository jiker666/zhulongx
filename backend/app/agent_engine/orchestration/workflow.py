from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Mapping


class WorkflowPrimitive(str, Enum):
    TASK = "task"
    SERIES = "series"
    PARALLEL = "parallel"
    RETRY = "retry"
    RACE = "race"
    LOOP_UNTIL = "loop_until"
    REVIEW = "review"
    REFUTE = "refute"
    SYNTHESIZE = "synthesize"
    VOTE = "vote"
    HUMAN_GATE = "human_gate"


@dataclass(frozen=True)
class WorkflowNode:
    node_id: str
    primitive: WorkflowPrimitive
    children: tuple["WorkflowNode", ...] = ()
    task_id: str = ""
    max_concurrency: int = 1
    max_attempts: int = 1
    max_iterations: int = 1
    condition: str = ""
    success_predicate: str = ""
    quorum: int = 1
    question_schema: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["primitive"] = self.primitive.value
        return value

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "WorkflowNode":
        value = dict(raw)
        value["primitive"] = WorkflowPrimitive(value["primitive"])
        value["children"] = tuple(cls.from_dict(item) for item in value.get("children", ()))
        return cls(**value)


@dataclass(frozen=True)
class WorkflowSpec:
    workflow_id: str
    version: int
    root: WorkflowNode
    allowed_roles: tuple[str, ...]
    allowed_tools: tuple[str, ...]
    max_budget_units: int = 100

    def to_dict(self) -> dict[str, Any]:
        return {
            "workflow_id": self.workflow_id,
            "version": self.version,
            "root": self.root.to_dict(),
            "allowed_roles": list(self.allowed_roles),
            "allowed_tools": list(self.allowed_tools),
            "max_budget_units": self.max_budget_units,
        }


class WorkflowValidationError(ValueError):
    pass


class WorkflowValidator:
    _CONDITIONS = {"until_success", "until_nonempty", "until_verified"}
    _PREDICATES = {"any_success", "first_verified"}

    def validate(self, spec: WorkflowSpec, *, task_ids: set[str], task_roles: Mapping[str, str]) -> None:
        if not spec.workflow_id or spec.version < 1 or spec.max_budget_units < 1:
            raise WorkflowValidationError("workflow identity, version, and budget are required")
        seen_node_ids: set[str] = set()
        active_objects: set[int] = set()
        estimated = self._validate_node(
            spec.root,
            spec,
            task_ids,
            task_roles,
            seen_node_ids,
            active_objects,
        )
        if estimated > spec.max_budget_units:
            raise WorkflowValidationError(
                f"workflow estimated budget {estimated} exceeds limit {spec.max_budget_units}"
            )

    def _validate_node(
        self,
        node: WorkflowNode,
        spec: WorkflowSpec,
        task_ids: set[str],
        task_roles: Mapping[str, str],
        seen_node_ids: set[str],
        active_objects: set[int],
    ) -> int:
        if not node.node_id or node.node_id in seen_node_ids:
            raise WorkflowValidationError(f"workflow node ids must be unique: {node.node_id}")
        if id(node) in active_objects:
            raise WorkflowValidationError("workflow contains a cycle")
        seen_node_ids.add(node.node_id)
        active_objects.add(id(node))
        if node.primitive == WorkflowPrimitive.TASK:
            if node.task_id not in task_ids:
                raise WorkflowValidationError(f"workflow references unknown task: {node.task_id}")
            role = task_roles.get(node.task_id, "")
            if role not in spec.allowed_roles:
                raise WorkflowValidationError(f"workflow task uses disallowed role: {role}")
            if node.children:
                raise WorkflowValidationError("task nodes cannot have children")
            cost = 1
        elif node.primitive in {WorkflowPrimitive.SERIES, WorkflowPrimitive.SYNTHESIZE}:
            self._require_children(node)
            cost = sum(self._child_costs(node, spec, task_ids, task_roles, seen_node_ids, active_objects))
        elif node.primitive == WorkflowPrimitive.PARALLEL:
            self._require_children(node)
            if node.max_concurrency < 1:
                raise WorkflowValidationError("parallel workflow requires bounded concurrency")
            cost = sum(self._child_costs(node, spec, task_ids, task_roles, seen_node_ids, active_objects))
        elif node.primitive == WorkflowPrimitive.RETRY:
            self._require_exact_children(node, 1)
            if node.max_attempts < 1:
                raise WorkflowValidationError("retry requires a positive attempt limit")
            cost = self._child_costs(node, spec, task_ids, task_roles, seen_node_ids, active_objects)[0] * node.max_attempts
        elif node.primitive == WorkflowPrimitive.RACE:
            self._require_children(node)
            if node.success_predicate not in self._PREDICATES or node.max_concurrency < 1:
                raise WorkflowValidationError("race requires a supported predicate and bounded concurrency")
            cost = sum(self._child_costs(node, spec, task_ids, task_roles, seen_node_ids, active_objects))
        elif node.primitive == WorkflowPrimitive.LOOP_UNTIL:
            self._require_exact_children(node, 1)
            if node.condition not in self._CONDITIONS or node.max_iterations < 1:
                raise WorkflowValidationError("loop_until requires a supported condition and iteration limit")
            cost = self._child_costs(node, spec, task_ids, task_roles, seen_node_ids, active_objects)[0] * node.max_iterations
        elif node.primitive in {WorkflowPrimitive.REVIEW, WorkflowPrimitive.REFUTE}:
            self._require_exact_children(node, 2)
            cost = sum(self._child_costs(node, spec, task_ids, task_roles, seen_node_ids, active_objects))
        elif node.primitive == WorkflowPrimitive.VOTE:
            self._require_children(node)
            if node.quorum < 1 or node.quorum > len(node.children):
                raise WorkflowValidationError("vote quorum is not achievable")
            cost = sum(self._child_costs(node, spec, task_ids, task_roles, seen_node_ids, active_objects))
        elif node.primitive == WorkflowPrimitive.HUMAN_GATE:
            if node.children or not node.question_schema.get("questions"):
                raise WorkflowValidationError("human_gate requires a structured question schema and no children")
            cost = 1
        else:
            raise WorkflowValidationError(f"unsupported workflow primitive: {node.primitive}")
        active_objects.remove(id(node))
        return cost

    def _child_costs(self, node, spec, task_ids, task_roles, seen, active):
        return [self._validate_node(child, spec, task_ids, task_roles, seen, active) for child in node.children]

    @staticmethod
    def _require_children(node: WorkflowNode) -> None:
        if not node.children:
            raise WorkflowValidationError(f"{node.primitive.value} requires children")

    @staticmethod
    def _require_exact_children(node: WorkflowNode, count: int) -> None:
        if len(node.children) != count:
            raise WorkflowValidationError(f"{node.primitive.value} requires exactly {count} child nodes")
