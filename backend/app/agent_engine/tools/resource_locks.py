from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from typing import Iterator

from app.agent_engine.abort import AbortToken, RunAborted


class ResourceLockTimeout(RuntimeError):
    pass


class ResourceLockManager:
    """Run-scoped named locks shared by root and child tool executors."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}

    @contextmanager
    def acquire(
        self,
        names: tuple[str, ...],
        *,
        timeout_seconds: float,
        abort_token: AbortToken,
    ) -> Iterator[None]:
        ordered = tuple(sorted(set(names)))
        acquired: list[threading.RLock] = []
        deadline = time.monotonic() + max(0.01, timeout_seconds)
        try:
            for name in ordered:
                with self._guard:
                    lock = self._locks.setdefault(name, threading.RLock())
                while True:
                    if abort_token.is_aborted:
                        raise RunAborted(abort_token.reason)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ResourceLockTimeout(f"resource lock timeout: {name}")
                    if lock.acquire(timeout=min(0.05, remaining)):
                        acquired.append(lock)
                        break
            yield
        finally:
            for lock in reversed(acquired):
                lock.release()
