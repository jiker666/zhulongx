from __future__ import annotations

import threading

from app.agent_engine.session import AgentSession
from app.agent_engine.state import RunStatus, SessionState


class RunManager:
    """Control-plane ownership of session threads, never solve decisions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, AgentSession] = {}
        self._threads: dict[str, threading.Thread] = {}

    def add(self, session: AgentSession) -> str:
        with self._lock:
            if session.run_id in self._sessions:
                raise ValueError(f"run already exists: {session.run_id}")
            self._sessions[session.run_id] = session
        return session.run_id

    def get(self, run_id: str) -> AgentSession | None:
        with self._lock:
            return self._sessions.get(run_id)

    def start(self, run_id: str) -> bool:
        with self._lock:
            session = self._sessions.get(run_id)
            if session is None:
                raise KeyError(run_id)
            thread = self._threads.get(run_id)
            if thread and thread.is_alive():
                return False
            if session.state.status not in {RunStatus.CREATED, RunStatus.RUNNING}:
                return False
            thread = threading.Thread(target=self._run, args=(run_id, session), daemon=True, name=f"agent-session-{run_id}")
            self._threads[run_id] = thread
            thread.start()
        return True

    def _run(self, run_id: str, session: AgentSession) -> None:
        try:
            session.run()
        finally:
            with self._lock:
                self._threads.pop(run_id, None)

    def abort(self, run_id: str, reason: str = "cancelled by user") -> bool:
        session = self.get(run_id)
        if session is None:
            raise KeyError(run_id)
        return session.abort(reason)

    def state(self, run_id: str) -> SessionState:
        session = self.get(run_id)
        if session is None:
            raise KeyError(run_id)
        return session.state

    def is_running(self, run_id: str) -> bool:
        with self._lock:
            thread = self._threads.get(run_id)
            return bool(thread and thread.is_alive())

    def wait(self, run_id: str, timeout: float | None = None) -> bool:
        with self._lock:
            thread = self._threads.get(run_id)
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()


run_manager = RunManager()
