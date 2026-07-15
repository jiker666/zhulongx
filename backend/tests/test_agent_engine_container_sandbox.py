import os
import threading
import time

import pytest

from app.agent_engine.abort import AbortToken
from app.agent_engine.sandbox.container import ContainerSandbox


@pytest.fixture
def container_sandbox(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    sandbox = ContainerSandbox(workspace)
    if not sandbox.release_capable:
        pytest.skip("preloaded Docker/Podman sandbox image is unavailable")
    return workspace, sandbox


def test_container_workspace_isolation_and_minimal_environment(container_sandbox, tmp_path, monkeypatch):
    workspace, sandbox = container_sandbox
    outside = tmp_path / "host_secret.txt"
    outside.write_text("host-only-secret", encoding="utf-8")
    monkeypatch.setenv("TEST_ONLY_API_KEY", "must-not-enter-container")
    code = f"""
import os
import pathlib
assert not pathlib.Path({str(outside)!r}).exists()
assert os.environ.get('TEST_ONLY_API_KEY') is None
pathlib.Path('created.txt').write_text('inside-workspace')
print('isolated')
"""

    result = sandbox.run(
        ["python3", "-c", code],
        cwd=workspace,
        timeout_seconds=10,
        abort_token=AbortToken(),
    )

    assert result.success is True
    assert result.stdout.strip() == "isolated"
    assert (workspace / "created.txt").read_text() == "inside-workspace"


def test_container_readonly_input_overlay(container_sandbox):
    workspace, _ = container_sandbox
    original = workspace / "original.txt"
    original.write_text("original", encoding="utf-8")
    original_mode = original.stat().st_mode
    sandbox = ContainerSandbox(workspace, readonly_paths=[original])

    read_result = sandbox.run(
        ["python3", "-c", "import pathlib; print(pathlib.Path('original.txt').read_text())"],
        cwd=workspace,
        timeout_seconds=10,
        abort_token=AbortToken(),
    )

    result = sandbox.run(
        ["python3", "-c", "import pathlib; pathlib.Path('original.txt').write_text('changed')"],
        cwd=workspace,
        timeout_seconds=10,
        abort_token=AbortToken(),
    )
    tamper_result = sandbox.run(
        ["python3", "-c", """
import os
import pathlib

path = pathlib.Path('original.txt')
for operation in (
    lambda: os.chmod(path, 0o644),
    path.unlink,
    lambda: path.rename('moved.txt'),
):
    try:
        operation()
    except PermissionError:
        continue
    raise SystemExit(2)
print('immutable')
"""],
        cwd=workspace,
        timeout_seconds=10,
        abort_token=AbortToken(),
    )

    assert read_result.success is True
    assert read_result.stdout.strip() == "original"
    assert result.success is False
    assert tamper_result.success is True
    assert tamper_result.stdout.strip() == "immutable"
    assert original.read_text() == "original"
    assert original.stat().st_mode == original_mode


def test_container_network_is_disabled(container_sandbox):
    workspace, sandbox = container_sandbox
    code = """
import socket
try:
    socket.create_connection(('1.1.1.1', 53), timeout=1)
except OSError:
    print('network-blocked')
else:
    raise SystemExit(2)
"""

    result = sandbox.run(
        ["python3", "-c", code],
        cwd=workspace,
        timeout_seconds=5,
        abort_token=AbortToken(),
    )

    assert result.success is True
    assert "network-blocked" in result.stdout


def test_container_timeout_removes_process(container_sandbox):
    workspace, sandbox = container_sandbox
    started = time.monotonic()

    result = sandbox.run(
        ["python3", "-c", "import time; time.sleep(60)"],
        cwd=workspace,
        timeout_seconds=0.5,
        abort_token=AbortToken(),
    )

    assert result.timed_out is True
    assert time.monotonic() - started < 3


def test_container_abort_removes_process(container_sandbox):
    workspace, sandbox = container_sandbox
    token = AbortToken()
    holder = {}
    thread = threading.Thread(
        target=lambda: holder.setdefault(
            "result",
            sandbox.run(
                ["python3", "-c", "import time; time.sleep(60)"],
                cwd=workspace,
                timeout_seconds=30,
                abort_token=token,
            ),
        ),
        daemon=True,
    )
    thread.start()
    deadline = time.monotonic() + 3
    while not sandbox._active and time.monotonic() < deadline:
        time.sleep(0.02)
    assert sandbox._active

    started = time.monotonic()
    token.abort("test abort")
    thread.join(timeout=3)

    assert not thread.is_alive()
    assert time.monotonic() - started < 3
    assert holder["result"].aborted is True
