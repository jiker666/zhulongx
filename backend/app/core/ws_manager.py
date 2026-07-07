"""
WebSocket Connection Manager.
Manages per-task WebSocket connections for real-time Agent live events.

Supports both integer task IDs (legacy) and string CTF task IDs.
Broadcast is fire-and-forget via new event loops to avoid blocking the runner thread.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Union

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        # task_id (str or int) -> list of active websockets
        self._connections: Dict[Union[str, int], List[WebSocket]] = {}

    async def connect(self, task_id: Union[str, int], websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.setdefault(task_id, []).append(websocket)
        logger.info(f"WS connected: task_id={task_id}, total={len(self._connections[task_id])}")

    def disconnect(self, task_id: Union[str, int], websocket: WebSocket) -> None:
        if task_id in self._connections:
            try:
                self._connections[task_id].remove(websocket)
            except ValueError:
                pass
            if not self._connections[task_id]:
                del self._connections[task_id]
        logger.info(f"WS disconnected: task_id={task_id}")

    async def broadcast(self, task_id: Union[str, int], message: dict) -> None:
        if task_id not in self._connections:
            return
        dead: List[WebSocket] = []
        for ws in list(self._connections[task_id]):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(task_id, ws)

    def has_connections(self, task_id: Union[str, int]) -> bool:
        """Check if there are active WebSocket connections for a task."""
        return task_id in self._connections and len(self._connections[task_id]) > 0

    def broadcast_sync(self, task_id: Union[str, int], message: dict) -> None:
        """Synchronous wrapper — safe to call from background threads.

        Creates a new event loop per call so it never interferes with
        the running asyncio loop.  Fire-and-forget; if no connections
        exist the call is a no-op.
        """
        if not self.has_connections(task_id):
            return
        try:
            loop = asyncio.new_event_loop()
            loop.run_until_complete(self.broadcast(task_id, message))
        except Exception as exc:  # noqa: BLE001
            logger.debug("broadcast_sync failed (no listeners?): %s", exc)
        finally:
            try:
                loop.close()
            except Exception:  # noqa: BLE001
                pass


ws_manager = ConnectionManager()


# ---------- Agent Live Event helpers ----------

def emit_agent_live(
    task_id: str,
    *,
    event_type: str,
    phase: str,
    title: str,
    detail: str = "",
    code: str = "",
    output: str = "",
    success: bool | None = None,
    extra: Dict[str, Any] | None = None,
) -> None:
    """Emit an AgentLiveEvent via WebSocket for real-time UI display.

    This is the single entry point the orchestrator calls to broadcast
    what the agent is doing/thinking.  Thread-safe (calls broadcast_sync).

    Parameters
    ----------
    task_id : str
        CTF task ID (e.g. "ctf_a1b2c3d4e5").
    event_type : str
        Broad category: "thinking" | "action" | "result" | "flag" | "error" | "info".
    phase : str
        Current state machine phase (e.g. "AGENT_THINK", "RUN_SHELL").
    title : str
        Short human-readable label for the event.
    detail : str
        Longer description / reasoning text.
    code : str
        Source code or shell command being executed.
    output : str
        stdout/stderr or LLM response.
    success : bool | None
        Outcome if applicable.
    extra : dict
        Any additional structured data.
    """
    payload = {
        "type": "agent_live",
        "task_id": task_id,
        "event_type": event_type,
        "phase": phase,
        "title": title,
        "detail": detail[:3000] if detail else "",
        "code": code[:5000] if code else "",
        "output": output[:5000] if output else "",
        "success": success,
        "extra": extra or {},
        "ts": __import__("time").time(),
    }
    ws_manager.broadcast_sync(task_id, payload)
