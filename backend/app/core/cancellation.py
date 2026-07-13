"""Task-scoped cancellation state and resource ownership registry."""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class CancellationContext:
    task_id: str
    cancelled: bool = False
    cancelled_at: float | None = None
    reason: str = ""
    resources: Dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))

    def request(self, reason: str = "user_cancelled") -> bool:
        if self.cancelled:
            return False
        self.cancelled = True; self.cancelled_at = time.time(); self.reason = reason
        return True


class CancellationRegistry:
    """In-memory ownership index; persistence remains TaskState snapshots."""
    def __init__(self) -> None:
        self._contexts: Dict[str, CancellationContext] = {}
        self._lock = threading.RLock()

    def context(self, task_id: str) -> CancellationContext:
        with self._lock:
            return self._contexts.setdefault(task_id, CancellationContext(task_id))

    def register(self, task_id: str, resource_type: str, resource_id: str) -> None:
        if resource_id:
            with self._lock:
                self.context(task_id).resources[resource_type].add(resource_id)

    def release(self, task_id: str, resource_type: str, resource_id: str) -> None:
        with self._lock:
            self.context(task_id).resources[resource_type].discard(resource_id)

    def request(self, task_id: str, reason: str = "user_cancelled") -> CancellationContext:
        with self._lock:
            context = self.context(task_id); context.request(reason); return context

    def resources(self, task_id: str) -> Dict[str, List[str]]:
        with self._lock:
            return {kind: sorted(ids) for kind, ids in self.context(task_id).resources.items()}


cancellation_registry = CancellationRegistry()
