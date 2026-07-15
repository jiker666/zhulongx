from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

from app.agent_engine.orchestration.workflow import WorkflowNode, WorkflowPrimitive, WorkflowSpec


@dataclass(frozen=True)
class WorkflowResult:
    success: bool
    status: str
    value: Any = None
    evidence_ids: tuple[str, ...] = ()
    attempts: int = 1
    children: tuple["WorkflowResult", ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)


class TaskDispatcher(Protocol):
    def dispatch(self, task_id: str, context: Mapping[str, Any]) -> WorkflowResult:
        ...


class WorkflowScheduler:
    def __init__(self, dispatcher: TaskDispatcher) -> None:
        self.dispatcher = dispatcher

    def execute(self, spec: WorkflowSpec, context: Mapping[str, Any] | None = None) -> WorkflowResult:
        return self._execute(spec.root, dict(context or {}))

    def _execute(self, node: WorkflowNode, context: Mapping[str, Any]) -> WorkflowResult:
        primitive = node.primitive
        if primitive == WorkflowPrimitive.TASK:
            return self.dispatcher.dispatch(node.task_id, context)
        if primitive == WorkflowPrimitive.SERIES:
            results: list[WorkflowResult] = []
            current = dict(context)
            for child in node.children:
                result = self._execute(child, current)
                results.append(result)
                current = {**current, "previous_result": result}
                if not result.success:
                    return WorkflowResult(False, "blocked", children=tuple(results))
            return WorkflowResult(True, "completed", value=results[-1].value, children=tuple(results))
        if primitive == WorkflowPrimitive.PARALLEL:
            with ThreadPoolExecutor(max_workers=min(node.max_concurrency, len(node.children))) as pool:
                futures = [pool.submit(self._execute, child, dict(context)) for child in node.children]
                results = tuple(future.result() for future in futures)
            return WorkflowResult(all(item.success for item in results), "completed" if all(item.success for item in results) else "partial", children=results)
        if primitive == WorkflowPrimitive.RETRY:
            attempts: list[WorkflowResult] = []
            for index in range(node.max_attempts):
                result = self._execute(node.children[0], {**context, "attempt": index + 1})
                attempts.append(result)
                if result.success:
                    return WorkflowResult(True, "completed", result.value, result.evidence_ids, index + 1, tuple(attempts))
            return WorkflowResult(False, "exhausted", attempts=node.max_attempts, children=tuple(attempts))
        if primitive == WorkflowPrimitive.RACE:
            with ThreadPoolExecutor(max_workers=min(node.max_concurrency, len(node.children))) as pool:
                futures = {pool.submit(self._execute, child, dict(context)): child for child in node.children}
                results: list[WorkflowResult] = []
                while futures:
                    done, pending = wait(futures, return_when=FIRST_COMPLETED)
                    for future in done:
                        result = future.result()
                        results.append(result)
                        futures.pop(future, None)
                        if self._predicate(node.success_predicate, result):
                            for item in pending:
                                item.cancel()
                            return WorkflowResult(True, "completed", result.value, result.evidence_ids, children=tuple(results))
            return WorkflowResult(False, "no_winner", children=tuple(results))
        if primitive == WorkflowPrimitive.LOOP_UNTIL:
            results = []
            current = dict(context)
            for index in range(node.max_iterations):
                result = self._execute(node.children[0], {**current, "iteration": index + 1})
                results.append(result)
                if self._condition(node.condition, result):
                    return WorkflowResult(True, "completed", result.value, result.evidence_ids, index + 1, tuple(results))
                current = {**current, "previous_result": result}
            return WorkflowResult(False, "iteration_limit", attempts=node.max_iterations, children=tuple(results))
        if primitive in {WorkflowPrimitive.REVIEW, WorkflowPrimitive.REFUTE}:
            produced = self._execute(node.children[0], context)
            if not produced.success:
                return WorkflowResult(False, "producer_failed", children=(produced,))
            reviewed = self._execute(node.children[1], {**context, "candidate_result": produced})
            return WorkflowResult(reviewed.success, "completed" if reviewed.success else "conflict", reviewed.value, reviewed.evidence_ids, children=(produced, reviewed))
        if primitive == WorkflowPrimitive.SYNTHESIZE:
            results: list[WorkflowResult] = []
            for child in node.children[:-1]:
                results.append(self._execute(child, context))
            synthesis = self._execute(node.children[-1], {**context, "input_results": tuple(results)})
            return WorkflowResult(synthesis.success, synthesis.status, synthesis.value, synthesis.evidence_ids, children=tuple(results) + (synthesis,))
        if primitive == WorkflowPrimitive.VOTE:
            results = tuple(self._execute(child, context) for child in node.children)
            votes: dict[str, int] = {}
            values: dict[str, Any] = {}
            for result in results:
                if not result.success:
                    continue
                key = repr(result.value)
                votes[key] = votes.get(key, 0) + 1
                values[key] = result.value
            winner = max(votes, key=votes.get) if votes else ""
            success = bool(winner and votes[winner] >= node.quorum)
            return WorkflowResult(success, "completed" if success else "no_quorum", values.get(winner), children=results, metadata={"votes": votes})
        if primitive == WorkflowPrimitive.HUMAN_GATE:
            return WorkflowResult(False, "human_required", metadata={"question_schema": dict(node.question_schema)})
        raise ValueError(f"unsupported workflow primitive: {primitive}")

    @staticmethod
    def _predicate(predicate: str, result: WorkflowResult) -> bool:
        return result.success and predicate in {"any_success", "first_verified"}

    @staticmethod
    def _condition(condition: str, result: WorkflowResult) -> bool:
        if condition == "until_success":
            return result.success
        if condition == "until_nonempty":
            return result.value is not None and result.value != "" and result.value != () and result.value != [] and result.value != {}
        if condition == "until_verified":
            return result.success and bool(result.metadata.get("verified", False))
        return False
