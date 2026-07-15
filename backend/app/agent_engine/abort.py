from __future__ import annotations

import threading
from typing import Callable, Optional


class RunAborted(RuntimeError):
    pass


class AbortToken:
    """Thread-safe cooperative cancellation with process cleanup callbacks."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._reason = "cancelled"
        self._callbacks: list[Callable[[], None]] = []

    @property
    def is_aborted(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> str:
        return self._reason

    def abort(self, reason: str = "cancelled") -> bool:
        with self._lock:
            if self._event.is_set():
                return False
            self._reason = reason
            self._event.set()
            callbacks = list(reversed(self._callbacks))
        for callback in callbacks:
            try:
                callback()
            except Exception:
                continue
        return True

    def register(self, callback: Callable[[], None]) -> Callable[[], None]:
        with self._lock:
            if self._event.is_set():
                run_now = True
            else:
                self._callbacks.append(callback)
                run_now = False
        if run_now:
            callback()

        def unregister() -> None:
            with self._lock:
                if callback in self._callbacks:
                    self._callbacks.remove(callback)

        return unregister

    def wait(self, timeout: Optional[float] = None) -> bool:
        return self._event.wait(timeout)

    def raise_if_aborted(self) -> None:
        if self._event.is_set():
            raise RunAborted(self._reason)
