from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Mapping, Sequence

from app.agent_engine.abort import AbortToken
from app.agent_engine.sandbox.base import ProcessResult, Sandbox


class LocalTestSandbox(Sandbox):
    """Host process runner for tests only; it is never release-capable."""

    release_capable = False

    def __init__(self, workspace: str | Path, *, max_output_chars: int = 20_000) -> None:
        self.workspace = Path(workspace).resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        self.max_output_chars = max_output_chars
        self._lock = threading.Lock()
        self._processes: set[subprocess.Popen[str]] = set()

    def _safe_cwd(self, cwd: Path) -> Path:
        resolved = cwd.resolve()
        try:
            resolved.relative_to(self.workspace)
        except ValueError as exc:
            raise ValueError(f"cwd escapes workspace: {cwd}") from exc
        resolved.mkdir(parents=True, exist_ok=True)
        return resolved

    @staticmethod
    def _minimal_env(extra: Mapping[str, str] | None) -> dict[str, str]:
        safe = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": "/tmp",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        if extra:
            safe.update({str(key): str(value) for key, value in extra.items()})
        return safe

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        abort_token: AbortToken,
        env: Mapping[str, str] | None = None,
    ) -> ProcessResult:
        abort_token.raise_if_aborted()
        safe_cwd = self._safe_cwd(cwd)
        started = time.monotonic()
        proc = subprocess.Popen(
            [str(item) for item in argv],
            cwd=safe_cwd,
            env=self._minimal_env(env),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=(os.name == "posix"),
        )
        with self._lock:
            self._processes.add(proc)
        unregister = abort_token.register(lambda: self._terminate(proc))
        timed_out = False
        try:
            try:
                stdout, stderr = proc.communicate(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                timed_out = True
                self._terminate(proc)
                stdout, stderr = proc.communicate(timeout=1)
        finally:
            unregister()
            with self._lock:
                self._processes.discard(proc)
        aborted = abort_token.is_aborted
        stdout = (stdout or "")[: self.max_output_chars]
        stderr = (stderr or "")[: self.max_output_chars]
        return ProcessResult(
            success=proc.returncode == 0 and not timed_out and not aborted,
            exit_code=proc.returncode if proc.returncode is not None else -1,
            stdout=stdout,
            stderr=stderr,
            duration_ms=int((time.monotonic() - started) * 1000),
            timed_out=timed_out,
            aborted=aborted,
        )

    def abort_all(self) -> None:
        with self._lock:
            processes = list(self._processes)
        for proc in processes:
            self._terminate(proc)

    @staticmethod
    def _terminate(proc: subprocess.Popen[str], grace_seconds: float = 0.25) -> None:
        if proc.poll() is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            else:
                proc.terminate()
        except ProcessLookupError:
            return
        deadline = time.monotonic() + grace_seconds
        while proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        if proc.poll() is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            else:
                proc.kill()
        except ProcessLookupError:
            pass
