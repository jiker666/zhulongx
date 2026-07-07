"""
WebSocket endpoint: WS /ws/ctf/{task_id}
Real-time Agent live event streaming.

Also retains legacy: WS /ws/tasks/{task_id} (integer task IDs).
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.core.ws_manager import ws_manager

router = APIRouter()


@router.websocket("/ws/ctf/{task_id}")
async def ctf_task_ws(websocket: WebSocket, task_id: str):
    """CTF task real-time event stream (string task IDs like 'ctf_xxx')."""
    await ws_manager.connect(task_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(task_id, websocket)


# Legacy: integer task IDs
@router.websocket("/ws/tasks/{task_id}")
async def task_ws(websocket: WebSocket, task_id: int):
    await ws_manager.connect(task_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(task_id, websocket)
