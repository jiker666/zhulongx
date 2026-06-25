"""
WebSocket endpoint: WS /ws/tasks/{task_id}
Real-time execution log streaming.
"""
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.core.ws_manager import ws_manager

router = APIRouter()


@router.websocket("/ws/tasks/{task_id}")
async def task_ws(websocket: WebSocket, task_id: int):
    await ws_manager.connect(task_id, websocket)
    try:
        # Keep alive - just listen for disconnects
        while True:
            data = await websocket.receive_text()
            # Echo ping/pong for keepalive
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(task_id, websocket)
