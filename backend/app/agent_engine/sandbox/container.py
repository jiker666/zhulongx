from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Mapping, Sequence

from app.agent_engine.abort import AbortToken
from app.agent_engine.sandbox.base import ProcessResult, Sandbox


class SandboxUnavailable(RuntimeError):
    pass


class ContainerSandbox(Sandbox):
    """Ephemeral Docker/Podman execution with no network and one workspace bind."""

    def __init__(
        self,
        workspace: str | Path | None = None,
        *,
        readonly_paths: Sequence[str | Path] = (),
        runtime: str | None = None,
        image: str | None = None,
        max_output_chars: int = 20_000,
    ) -> None:
        self.workspace = Path(workspace).expanduser().resolve() if workspace is not None else None
        self.readonly_paths = tuple(Path(item).expanduser().resolve(strict=False) for item in readonly_paths)
        configured_runtime = runtime or os.environ.get("AGENT_SANDBOX_RUNTIME", "")
        self.runtime = shutil.which(configured_runtime) if configured_runtime else (shutil.which("podman") or shutil.which("docker"))
        self.image = image or os.environ.get("AGENT_SANDBOX_IMAGE", "python:3.11-slim")
        self.max_output_chars = max_output_chars
        self._lock = threading.Lock()
        self._active: dict[subprocess.Popen[str], str] = {}
        self.release_capable = bool(self.runtime and self._image_available())

    def _image_available(self) -> bool:
        assert self.runtime is not None
        try:
            result = subprocess.run(
                [self.runtime, "image", "inspect", self.image],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        abort_token: AbortToken,
        env: Mapping[str, str] | None = None,
    ) -> ProcessResult:
        if not self.release_capable or self.runtime is None:
            raise SandboxUnavailable(
                f"container sandbox unavailable: runtime={self.runtime or 'missing'} image={self.image!r} (image pulls are disabled)"
            )
        abort_token.raise_if_aborted()
        workspace = self.workspace or cwd.resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        safe_cwd = cwd.resolve()
        try:
            relative_cwd = safe_cwd.relative_to(workspace)
        except ValueError as exc:
            raise ValueError(f"cwd escapes workspace: {cwd}") from exc

        name = "zhulongx-agent-" + re.sub(r"[^a-z0-9_.-]", "-", uuid.uuid4().hex.lower())[:32]
        command = self._command(name, workspace, relative_cwd, argv, env)
        started = time.monotonic()
        protected_modes = self._protect_workspace(workspace)
        try:
            proc = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=(os.name == "posix"),
            )
        except Exception:
            self._restore_modes(protected_modes)
            raise
        with self._lock:
            self._active[proc] = name
        unregister = abort_token.register(lambda: self._terminate(name, proc))
        timed_out = False
        try:
            try:
                stdout, stderr = proc.communicate(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                timed_out = True
                self._terminate(name, proc)
                stdout, stderr = proc.communicate(timeout=2)
        finally:
            unregister()
            with self._lock:
                self._active.pop(proc, None)
            self._restore_modes(protected_modes)
        aborted = abort_token.is_aborted
        return ProcessResult(
            success=proc.returncode == 0 and not timed_out and not aborted,
            exit_code=proc.returncode if proc.returncode is not None else -1,
            stdout=(stdout or "")[: self.max_output_chars],
            stderr=(stderr or "")[: self.max_output_chars],
            duration_ms=int((time.monotonic() - started) * 1000),
            timed_out=timed_out,
            aborted=aborted,
        )

    def _command(
        self,
        name: str,
        workspace: Path,
        relative_cwd: Path,
        argv: Sequence[str],
        env: Mapping[str, str] | None,
    ) -> list[str]:
        assert self.runtime is not None
        container_cwd = Path("/workspace") / relative_cwd
        command = [
            self.runtime,
            "run",
            "--pull=never",
            "--name", name,
            "--rm",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=64",
            "--memory=2g",
            "--cpus=1",
            "--ulimit=nofile=256:256",
            "--ulimit=fsize=524288:524288",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864",
            "--volume", f"{workspace}:/workspace:rw",
            "--workdir", str(container_cwd),
            "--env", "HOME=/tmp",
            "--env", "LANG=C.UTF-8",
            "--env", "PYTHONUNBUFFERED=1",
            "--env", "PYTHONDONTWRITEBYTECODE=1",
        ]
        command.extend(["--user", "65532:65532"])
        for key, value in (env or {}).items():
            if re.fullmatch(r"[A-Z_][A-Z0-9_]*", str(key)):
                command.extend(["--env", f"{key}={value}"])
        command.extend([self.image, *self._translate_argv(workspace, argv)])
        return command

    def _protect_workspace(self, workspace: Path) -> list[tuple[Path, int]]:
        original_modes: dict[Path, int] = {}

        def protect(path: Path, mode: int) -> None:
            if path not in original_modes:
                original_modes[path] = path.stat().st_mode & 0o7777
            path.chmod(mode)

        protect(workspace, 0o1777)
        for readonly in self.readonly_paths:
            try:
                relative = readonly.relative_to(workspace)
            except ValueError:
                continue
            target = workspace / relative
            if not target.exists():
                continue
            parent = target.parent
            while parent != workspace:
                mode = parent.stat().st_mode & 0o7777
                protect(parent, mode & ~0o022)
                parent = parent.parent
            members = [target]
            if target.is_dir():
                members.extend(sorted(target.rglob("*"), key=lambda item: len(item.parts)))
            for member in members:
                if member.is_symlink() or not member.exists():
                    continue
                mode = member.stat().st_mode & 0o7777
                protect(member, mode & ~0o222)
        return list(original_modes.items())

    @staticmethod
    def _restore_modes(original_modes: Sequence[tuple[Path, int]]) -> None:
        for path, mode in sorted(original_modes, key=lambda item: len(item[0].parts), reverse=True):
            try:
                path.chmod(mode)
            except OSError:
                pass

    @staticmethod
    def _translate_argv(workspace: Path, argv: Sequence[str]) -> list[str]:
        translated = []
        for index, raw in enumerate(argv):
            value = str(raw)
            path = Path(value)
            if path.is_absolute():
                try:
                    relative = path.resolve(strict=False).relative_to(workspace)
                    translated.append(str(Path("/workspace") / relative))
                    continue
                except ValueError:
                    pass
            if index == 0 and path.name.startswith("python"):
                translated.append("python3")
            else:
                translated.append(value)
        return translated

    def abort_all(self) -> None:
        with self._lock:
            active = list(self._active.items())
        for proc, name in active:
            self._terminate(name, proc)

    def _terminate(self, name: str, proc: subprocess.Popen[str]) -> None:
        self._terminate_process(proc)
        self._remove_container(name)

    @staticmethod
    def _terminate_process(proc: subprocess.Popen[str]) -> None:
        if proc.poll() is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            else:
                proc.terminate()
            proc.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            try:
                if os.name == "posix":
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                else:
                    proc.kill()
                proc.wait(timeout=0.5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
        except ProcessLookupError:
            pass

    def _remove_container(self, name: str) -> None:
        if not self.runtime:
            return
        command = [self.runtime, "rm", "--force"]
        if Path(self.runtime).name == "podman":
            command.extend(["--time", "0"])
        command.append(name)
        cleanup: subprocess.Popen[bytes] | None = None
        try:
            cleanup = subprocess.Popen(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=(os.name == "posix"),
            )
            cleanup.wait(timeout=0.75)
        except (OSError, subprocess.TimeoutExpired):
            if cleanup is None or cleanup.poll() is not None:
                return
            try:
                if os.name == "posix":
                    os.killpg(os.getpgid(cleanup.pid), signal.SIGKILL)
                else:
                    cleanup.kill()
                cleanup.wait(timeout=0.25)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass
