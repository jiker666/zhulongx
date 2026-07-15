from __future__ import annotations

import itertools
from typing import Any, Mapping, Sequence

from app.agent_engine.orchestration.workflow import WorkflowNode, WorkflowPrimitive


_ids = itertools.count(1)


def _id(prefix: str) -> str:
    return f"{prefix}_{next(_ids)}"


def task(task_id: str, *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(node_id or _id("task"), WorkflowPrimitive.TASK, task_id=task_id)


def series(nodes: Sequence[WorkflowNode], *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(node_id or _id("series"), WorkflowPrimitive.SERIES, tuple(nodes))


def parallel(nodes: Sequence[WorkflowNode], max_concurrency: int, *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(
        node_id or _id("parallel"), WorkflowPrimitive.PARALLEL, tuple(nodes), max_concurrency=max_concurrency,
    )


def retry(node: WorkflowNode, policy: Mapping[str, Any], *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(
        node_id or _id("retry"), WorkflowPrimitive.RETRY, (node,), max_attempts=int(policy.get("max_attempts", 1)),
    )


def race(
    nodes: Sequence[WorkflowNode],
    success_predicate: str,
    *,
    max_concurrency: int,
    node_id: str = "",
) -> WorkflowNode:
    return WorkflowNode(
        node_id or _id("race"), WorkflowPrimitive.RACE, tuple(nodes), max_concurrency=max_concurrency,
        success_predicate=success_predicate,
    )


def loop_until(node: WorkflowNode, condition: str, max_iterations: int, *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(
        node_id or _id("loop"), WorkflowPrimitive.LOOP_UNTIL, (node,), max_iterations=max_iterations,
        condition=condition,
    )


def review(producer: WorkflowNode, reviewer: WorkflowNode, *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(node_id or _id("review"), WorkflowPrimitive.REVIEW, (producer, reviewer))


def refute(candidate: WorkflowNode, refuter: WorkflowNode, *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(node_id or _id("refute"), WorkflowPrimitive.REFUTE, (candidate, refuter))


def synthesize(inputs: Sequence[WorkflowNode], synthesizer: WorkflowNode, *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(node_id or _id("synthesize"), WorkflowPrimitive.SYNTHESIZE, tuple(inputs) + (synthesizer,))


def vote(candidates: Sequence[WorkflowNode], quorum: int, *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(node_id or _id("vote"), WorkflowPrimitive.VOTE, tuple(candidates), quorum=quorum)


def human_gate(question_schema: Mapping[str, Any], *, node_id: str = "") -> WorkflowNode:
    return WorkflowNode(
        node_id or _id("human"), WorkflowPrimitive.HUMAN_GATE, question_schema=dict(question_schema),
    )
