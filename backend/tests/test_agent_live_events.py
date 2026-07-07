"""Tests for AgentLiveEvent WebSocket broadcasting."""
import json
import time

from app.core.ws_manager import emit_agent_live, ws_manager


def test_emit_agent_live_no_connections():
    """emit_agent_live should be a no-op when no WS connections exist."""
    # Just verify it doesn't raise
    emit_agent_live(
        "ctf_test_no_conn",
        event_type="thinking",
        phase="AGENT_THINK",
        title="Test thinking",
        detail="Should not crash",
    )


def test_emit_agent_live_payload_structure():
    """Verify the payload structure matches the AgentLiveEvent schema."""
    # Capture by monkey-patching broadcast_sync
    captured = {}

    original_sync = ws_manager.broadcast_sync

    def mock_broadcast_sync(task_id, message):
        captured["task_id"] = task_id
        captured["message"] = message

    ws_manager.broadcast_sync = mock_broadcast_sync

    try:
        emit_agent_live(
            "ctf_test_struct",
            event_type="action",
            phase="RUN_SHELL",
            title="⚡ Executing command",
            detail="Running `file challenge.bin`",
            code="file challenge.bin",
            output="ELF 64-bit LSB executable",
            success=True,
            extra={"exit_code": 0},
        )
        assert captured["task_id"] == "ctf_test_struct"
        msg = captured["message"]
        assert msg["type"] == "agent_live"
        assert msg["event_type"] == "action"
        assert msg["phase"] == "RUN_SHELL"
        assert msg["title"] == "⚡ Executing command"
        assert "file challenge.bin" in msg["detail"]
        assert msg["code"] == "file challenge.bin"
        assert msg["output"] == "ELF 64-bit LSB executable"
        assert msg["success"] is True
        assert msg["extra"]["exit_code"] == 0
        assert isinstance(msg["ts"], float)
        assert msg["ts"] > 0
    finally:
        ws_manager.broadcast_sync = original_sync


def test_emit_agent_live_truncation():
    """Very long detail/code/output should be truncated."""
    captured = {}

    original_sync = ws_manager.broadcast_sync

    def mock_broadcast_sync(task_id, message):
        captured["message"] = message

    ws_manager.broadcast_sync = mock_broadcast_sync

    try:
        long_detail = "x" * 10000
        long_code = "y" * 10000
        long_output = "z" * 10000

        emit_agent_live(
            "ctf_test_trunc",
            event_type="result",
            phase="RUN_SCRIPT",
            title="Big output",
            detail=long_detail,
            code=long_code,
            output=long_output,
        )
        msg = captured["message"]
        assert len(msg["detail"]) <= 3000
        assert len(msg["code"]) <= 5000
        assert len(msg["output"]) <= 5000
    finally:
        ws_manager.broadcast_sync = original_sync


def test_ws_manager_has_connections():
    """has_connections should return False when no connections exist."""
    assert not ws_manager.has_connections("nonexistent_task")
    assert not ws_manager.has_connections(42)


def test_ws_manager_broadcast_sync_no_connections():
    """broadcast_sync should be a no-op when no connections exist."""
    # Should not raise
    ws_manager.broadcast_sync("nonexistent", {"type": "test"})
