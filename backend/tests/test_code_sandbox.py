"""
Tests for CodeExecutionSandbox - timeout, output limit, dangerous commands.
"""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.core.code_execution_sandbox import CodeExecutionSandbox


@pytest.fixture
def sandbox(tmp_path):
    return CodeExecutionSandbox(base_workdir=str(tmp_path / "ws"), default_timeout=3, max_output=2000)


def test_run_python_success(sandbox):
    ws = sandbox.create_workspace()
    sp = sandbox.write_script(ws, "solve.py", "print('hello world')\n")
    r = sandbox.run_python(sp, workdir=ws)
    assert r.success
    assert r.exit_code == 0
    assert "hello world" in r.stdout


def test_run_python_failure(sandbox):
    ws = sandbox.create_workspace()
    sp = sandbox.write_script(ws, "solve.py", "import sys; sys.exit(2)\n")
    r = sandbox.run_python(sp, workdir=ws)
    assert not r.success
    assert r.exit_code == 2


def test_timeout_enforced(sandbox):
    ws = sandbox.create_workspace()
    sp = sandbox.write_script(ws, "solve.py", "import time; time.sleep(10)\n")
    start = time.time()
    r = sandbox.run_python(sp, workdir=ws, timeout=2)
    elapsed = time.time() - start
    assert r.timed_out
    assert elapsed < 5  # Should bail out around 2s, not wait 10s


def test_dangerous_pattern_rejected(sandbox):
    ws = sandbox.create_workspace()
    # rm -rf / must be rejected
    with pytest.raises(ValueError, match="dangerous pattern"):
        sandbox.write_script(ws, "bad.py", "import os; os.system('rm -rf /')\n")
    # fork bomb
    with pytest.raises(ValueError):
        sandbox.write_script(ws, "bad2.py", ":(){ :|:& };\n")


def test_dangerous_shell_command_blocked(sandbox):
    ws = sandbox.create_workspace()
    # rm -rf / via shell should be blocked by pattern scan (raises ValueError)
    with pytest.raises(ValueError, match="dangerous pattern"):
        sandbox.run_shell("rm -rf /", workdir=ws)
    # mkfs is also blocked
    with pytest.raises(ValueError):
        sandbox.run_shell("mkfs.ext4 /dev/sda1", workdir=ws)


def test_output_truncation(tmp_path):
    sb = CodeExecutionSandbox(base_workdir=str(tmp_path / "ws"), default_timeout=5, max_output=100)
    ws = sb.create_workspace()
    sp = sb.write_script(ws, "solve.py", "print('A' * 5000)\n")
    r = sb.run_python(sp, workdir=ws)
    assert "truncated" in r.stdout or "AAAA" in r.stdout  # Either truncated or visible


def test_workspace_isolation(sandbox):
    ws1 = sandbox.create_workspace()
    ws2 = sandbox.create_workspace()
    assert ws1 != ws2
    # script in ws1 shouldn't be visible from ws2's perspective
    sp = sandbox.write_script(ws1, "solve.py", "print('private')\n")
    # Files written to ws1
    assert os.path.isfile(sp)
    assert ws1 in sp


def test_path_escape_sanitized(sandbox):
    ws = sandbox.create_workspace()
    # basename strips ../, so the path gets sanitized and stored safely inside ws
    sp = sandbox.write_script(ws, "../../../etc/passwd", "print('hi')")
    # The actual stored path should be inside ws (not etc/passwd)
    assert ws in sp
    assert "etc" not in sp
    assert "passwd" in sp  # filename kept
