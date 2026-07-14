from __future__ import annotations

from dataclasses import replace
from typing import Iterable

from app.agent_engine.contracts.plan import Plan
from app.agent_engine.contracts.task import TaskNode, TaskStatus


class TaskGraphValidationError(ValueError):
    pass


class TaskGraph:
    def __init__(
        self,
        plan: Plan,
        *,
        allowed_roles: Iterable[str] = (),
        available_tools: Iterable[str] = (),
    ) -> None:
        self.plan = plan
        self.allowed_roles = set(allowed_roles)
        self.available_tools = set(available_tools)
        self.nodes = {node.task_id: node for node in plan.nodes}
        self.validate()

    def validate(self) -> None:
        if len(self.nodes) != len(self.plan.nodes):
            raise TaskGraphValidationError("task ids must be unique")
        for node in self.plan.nodes:
            missing = set(node.dependencies) - self.nodes.keys()
            if missing:
                raise TaskGraphValidationError(f"task {node.task_id} has missing dependencies: {sorted(missing)}")
            if node.task_id in node.dependencies:
                raise TaskGraphValidationError(f"task {node.task_id} depends on itself")
            if self.allowed_roles and node.role not in self.allowed_roles:
                raise TaskGraphValidationError(f"task {node.task_id} uses unknown role: {node.role}")
            missing_tools = set(node.allowed_tools) - self.available_tools if self.available_tools else set()
            if missing_tools:
                raise TaskGraphValidationError(f"task {node.task_id} uses unavailable tools: {sorted(missing_tools)}")
        self._topological_order()
        if self.plan.critical_path:
            unknown = set(self.plan.critical_path) - self.nodes.keys()
            if unknown:
                raise TaskGraphValidationError(f"critical path contains unknown tasks: {sorted(unknown)}")

    def _topological_order(self) -> tuple[str, ...]:
        indegree = {task_id: 0 for task_id in self.nodes}
        dependants: dict[str, list[str]] = {task_id: [] for task_id in self.nodes}
        for node in self.nodes.values():
            for dependency in node.dependencies:
                indegree[node.task_id] += 1
                dependants[dependency].append(node.task_id)
        ready = sorted(task_id for task_id, degree in indegree.items() if degree == 0)
        ordered: list[str] = []
        while ready:
            task_id = ready.pop(0)
            ordered.append(task_id)
            for dependant in dependants[task_id]:
                indegree[dependant] -= 1
                if indegree[dependant] == 0:
                    ready.append(dependant)
                    ready.sort()
        if len(ordered) != len(self.nodes):
            raise TaskGraphValidationError("task graph contains a dependency cycle")
        return tuple(ordered)

    def topological_order(self) -> tuple[str, ...]:
        return self._topological_order()

    def ready(self, completed: Iterable[str], active: Iterable[str] = ()) -> tuple[TaskNode, ...]:
        done = set(completed)
        running = set(active)
        return tuple(
            self.nodes[task_id]
            for task_id in self._topological_order()
            if task_id not in done and task_id not in running and set(self.nodes[task_id].dependencies) <= done
        )

    def with_status(self, task_id: str, status: TaskStatus) -> "TaskGraph":
        if task_id not in self.nodes:
            raise KeyError(task_id)
        nodes = tuple(replace(node, status=status) if node.task_id == task_id else node for node in self.plan.nodes)
        return TaskGraph(
            replace(self.plan, nodes=nodes),
            allowed_roles=self.allowed_roles,
            available_tools=self.available_tools,
        )
