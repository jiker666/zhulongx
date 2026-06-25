"""
WebSocket Connection Manager.
Manages per-task WebSocket connections.
Executor runs in a background thread; broadcast is fire-and-forget via new event loops.
"""
import logging
from typing import Dict, List

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        # task_id -> list of active websockets
        self._connections: Dict[int, List[WebSocket]] = {}

    async def connect(self, task_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.setdefault(task_id, []).append(websocket)
        logger.info(f"WS connected: task_id={task_id}, total={len(self._connections[task_id])}")

    def disconnect(self, task_id: int, websocket: WebSocket) -> None:
        if task_id in self._connections:
            try:
                self._connections[task_id].remove(websocket)
            except ValueError:
                pass
            if not self._connections[task_id]:
                del self._connections[task_id]
        logger.info(f"WS disconnected: task_id={task_id}")

    async def broadcast(self, task_id: int, message: dict) -> None:
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


ws_manager = ConnectionManager()
