import json
import os
import tempfile
import time
from unittest.mock import MagicMock, patch

import pytest
from app.core.tool_protocol import ToolSpec, make_tool_call


def _make_runtime(workspace=None, **kwargs):
    from app.core.agent_runtime import AgentRuntime
    ws = workspace or tempfile.mkdtemp(prefix="test_runtime_")
    rt = AgentRuntime(
        task_id="test_task", workspace=ws, title="Test", description="test task",
        category="misc", max_turns=3, max_time_sec=60, **kwargs,
    )
    rt.register_tool(ToolSpec(name="run_shell", description="shell", input_schema={}, risk_level="medium", timeout_seconds=10))
    rt.register_tool(ToolSpec(name="run_python", description="python", input_schema={}, risk_level="medium", timeout_seconds=10))
    rt.register_tool(ToolSpec(name="submit_flag", description="flag", input_schema={}, risk_level="low", timeout_seconds=5))
    return rt


def test_runtime_init():
    rt = _make_runtime()
    assert rt.task_id == "test_task"
    assert rt.state == "running"
    assert rt.max_turns == 3


def test_runtime_register_tool():
    rt = _make_runtime()
    spec = ToolSpec(name="list_dir", description="list dir", input_schema={}, risk_level="low")
    rt.register_tool(spec)
    assert "list_dir" in rt._tool_specs


def test_runtime_termination_max_turns():
    rt = _make_runtime()
    rt.turns = [MagicMock() for _ in range(3)]
    assert rt._check_termination() is True
    assert rt.state == "human_required"


def test_runtime_termination_timeout():
    rt = _make_runtime()
    rt.started_at = time.time() - 61
    assert rt._check_termination() is True
    assert "超时" in rt.error


def test_runtime_safe_path_blocks_escape():
    ws = tempfile.mkdtemp(prefix="test_safe_")
    rt = _make_runtime(workspace=ws)
    assert rt._safe_path("../../etc/passwd") is None
    assert rt._safe_path("subdir/file.txt") is not None


def test_runtime_safe_path_blocks_symlink_escape(tmp_path):
    ws = tmp_path / "workspace"
    outside = tmp_path / "outside"
    ws.mkdir()
    outside.mkdir()
    (ws / "escape").symlink_to(outside, target_is_directory=True)
    rt = _make_runtime(workspace=str(ws))
    assert rt._safe_path("escape/secret.txt") is None


def test_runtime_exec_list_dir():
    ws = tempfile.mkdtemp(prefix="test_ls_")
    with open(os.path.join(ws, "hello.txt"), "w") as f:
        f.write("hello")
    rt = _make_runtime(workspace=ws)
    output, error, success = rt._exec_list_dir({"path": "."})
    assert success is True
    assert "hello.txt" in output


def test_runtime_exec_read_file():
    ws = tempfile.mkdtemp(prefix="test_read_")
    with open(os.path.join(ws, "data.txt"), "w") as f:
        f.write("flag{read_test}")
    rt = _make_runtime(workspace=ws)
    output, error, success = rt._exec_read_file({"file": "data.txt"})
    assert success is True
    assert "flag{read_test}" in output


def test_runtime_exec_read_file_escape():
    ws = tempfile.mkdtemp(prefix="test_read_esc_")
    rt = _make_runtime(workspace=ws)
    output, error, success = rt._exec_read_file({"file": "../../etc/passwd"})
    assert success is False
    assert "超出 workspace" in error


def test_runtime_exec_write_file():
    ws = tempfile.mkdtemp(prefix="test_write_")
    rt = _make_runtime(workspace=ws)
    output, error, success = rt._exec_write_file({"path": "out.py", "content": "print(1)"})
    assert success is True
    assert os.path.isfile(os.path.join(ws, "out.py"))


def test_runtime_exec_write_file_escape():
    ws = tempfile.mkdtemp(prefix="test_write_esc_")
    rt = _make_runtime(workspace=ws)
    output, error, success = rt._exec_write_file({"path": "/tmp/evil.py", "content": "bad"})
    assert success is False
    assert "超出 workspace" in error


def test_runtime_exec_write_file_no_overwrite_attachment():
    ws = tempfile.mkdtemp(prefix="test_no_overwrite_")
    attachment = os.path.join(ws, "original.bin")
    with open(attachment, "wb") as f:
        f.write(b"original")
    rt = _make_runtime(workspace=ws, attachments=[attachment])
    output, error, success = rt._exec_write_file({"path": "original.bin", "content": "overwritten"})
    assert success is False
    assert "覆盖" in error or "overwrite" in error.lower()


def test_runtime_exec_submit_flag_valid():
    rt = _make_runtime()
    output, error, success = rt._exec_submit_flag({"flag": "flag{valid_flag}", "confidence": 0.9})
    assert success is True
    assert rt.best_flag == "flag{valid_flag}"
    assert rt.state == "done"


def test_runtime_exec_submit_flag_invalid_format():
    rt = _make_runtime()
    output, error, success = rt._exec_submit_flag({"flag": "not_a_flag", "confidence": 0.3})
    assert success is False
    assert rt.state == "running"


def test_runtime_exec_ask_human():
    rt = _make_runtime()
    output, error, success = rt._exec_ask_human({"question": "help needed"})
    assert success is True
    assert rt.state == "human_required"


def test_runtime_get_trace():
    rt = _make_runtime()
    trace = rt.get_trace()
    assert trace["task_id"] == "test_task"
    assert trace["state"] == "running"
    assert "turns" in trace
    assert "ledger" in trace
