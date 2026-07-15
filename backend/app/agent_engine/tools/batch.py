from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Iterable

from app.agent_engine.tools.executor import ToolExecution, ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolCall, ToolContext


@dataclass(frozen=True)
class BatchExecution:
    call: ToolCall
    execution: ToolExecution


class BoundedToolBatchExecutor:
    """Parallelize only declared idempotent calls with non-conflicting locks."""

    def __init__(
        self,
        registry: ToolRegistry,
        executor: ToolExecutionService,
        *,
        max_concurrency: int = 4,
    ) -> None:
        self.registry = registry
        self.executor = executor
        self.max_concurrency = max(1, max_concurrency)

    def execute(
        self,
        calls: Iterable[ToolCall],
        context: ToolContext,
        *,
        parent_event_id: str | None = None,
    ) -> list[BatchExecution]:
        ordered = list(calls)
        output: list[BatchExecution] = []
        parallel_group: list[ToolCall] = []
        held_locks: set[str] = set()

        def flush() -> None:
            nonlocal parallel_group, held_locks
            if not parallel_group:
                return
            if len(parallel_group) == 1:
                call = parallel_group[0]
                output.append(BatchExecution(call, self.executor.execute(call, context, parent_event_id=parent_event_id)))
            else:
                workers = min(self.max_concurrency, len(parallel_group))
                with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="agent-tool") as pool:
                    futures = [
                        pool.submit(self.executor.execute, call, context, parent_event_id=parent_event_id)
                        for call in parallel_group
                    ]
                    output.extend(BatchExecution(call, future.result()) for call, future in zip(parallel_group, futures))
            parallel_group = []
            held_locks = set()

        for call in ordered:
            definition = self.registry.get(call.name)
            safe = bool(
                definition
                and definition.parallel_safe
                and definition.idempotency in {"read_only", "idempotent"}
                and definition.side_effect_level in {"none", "read"}
            )
            locks = set(definition.resource_locks if definition else ())
            if not safe or locks.intersection(held_locks):
                flush()
            if safe:
                parallel_group.append(call)
                held_locks.update(locks)
            else:
                output.append(BatchExecution(call, self.executor.execute(call, context, parent_event_id=parent_event_id)))
        flush()
        return output
