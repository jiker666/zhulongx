"""Isolated Linux Worker with task-scoped, reaped process lifecycle."""
from __future__ import annotations

import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.landlock import apply_workspace_landlock

ROOT = Path(os.environ.get("WORKER_WORKSPACE_ROOT", "/workspace/tasks")).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
BOOT_ID = uuid.uuid4().hex
TERMINATE_GRACE_SECONDS = float(os.environ.get("WORKER_TERMINATE_GRACE_SECONDS", "1.5"))
app = FastAPI(title="ZHULONG-X Linux Worker", version="1.2")
_lock = threading.RLock()


class PtyCreate(BaseModel):
    competition_id: str = ""
    challenge_id: str = ""
    task_id: str
    workspace: str
    command: str = "/bin/sh"
    timeout: int = Field(60, ge=1, le=3600)


class PtyWrite(BaseModel):
    task_id: str
    data: str = Field(max_length=8192)


class PtyExpect(BaseModel):
    task_id: str
    pattern: str
    regex: bool = False
    timeout: float = Field(5, ge=0.1, le=60)
    from_cursor: int = 0
    max_bytes: int = Field(20000, ge=1, le=100000)


class CommandRequest(BaseModel):
    competition_id: str = ""
    challenge_id: str
    task_id: str
    command: str
    arguments: list[str] = Field(default_factory=list, max_length=200)
    cwd: str
    environment: Dict[str, str] = Field(default_factory=dict)
    timeout_seconds: int = Field(60, ge=1, le=3600)
    max_output_bytes: int = Field(20000, ge=1, le=1000000)
    shell: bool = False
    capture_stdout: bool = True
    capture_stderr: bool = True


class InvocationContext(BaseModel):
    run_id: str = Field(min_length=1, max_length=128)
    session_id: str = Field(min_length=1, max_length=128)
    task_id: str = Field(min_length=1, max_length=200)
    tool_call_id: str = Field(min_length=1, max_length=200)
    workspace: str = Field(min_length=1, max_length=4096)
    authorization: Dict[str, Any]
    scope: Dict[str, Any]


@dataclass
class Session:
    run_id: str
    agent_session_id: str
    tool_call_id: str
    task_id: str
    challenge_id: str
    competition_id: str
    pid: int
    master_fd: int
    created_at: float
    timeout: int
    status: str = "ACTIVE"
    output_cursor: int = 0
    output_start: int = 0
    output: bytearray = field(default_factory=bytearray, repr=False)
    last_activity_at: float = field(default_factory=time.time)


sessions: Dict[str, Session] = {}
commands: Dict[str, Dict[str, Any]] = {}
cancelled_runs: set[tuple[str, str]] = set()
workspace_owners: Dict[str, tuple[str, str]] = {}
_reaper_stop = threading.Event()
_reaper_thread: threading.Thread | None = None


@app.middleware("http")
async def require_invocation_context(request: Request, call_next):
    protected = request.url.path.startswith(("/commands", "/sessions", "/tasks"))
    if protected:
        try:
            invocation = InvocationContext(
                run_id=request.headers.get("X-Agent-Run-Id", ""),
                session_id=request.headers.get("X-Agent-Session-Id", ""),
                task_id=request.headers.get("X-Agent-Task-Id", ""),
                tool_call_id=request.headers.get("X-Agent-Tool-Call-Id", ""),
                workspace=request.headers.get("X-Agent-Workspace", ""),
                authorization=json.loads(request.headers.get("X-Agent-Authorization", "{}")),
                scope=json.loads(request.headers.get("X-Agent-Scope", "{}")),
            )
        except Exception:
            return JSONResponse(status_code=400, content={"detail": "invalid Agent Engine invocation context"})
        if not bool(invocation.authorization.get("allow_worker", False)):
            return JSONResponse(status_code=403, content={"detail": "Worker execution is not enabled for this run"})
        process_action = (
            (request.method == "POST" and request.url.path == "/commands")
            or (request.method == "POST" and request.url.path == "/sessions/pty")
            or (request.method == "POST" and request.url.path.endswith("/write"))
        )
        if process_action and not bool(invocation.authorization.get("allow_process", False)):
            return JSONResponse(status_code=403, content={"detail": "process execution is not enabled for this run"})
        if process_action and invocation.scope.get("network_mode", "deny") != "deny":
            return JSONResponse(
                status_code=409,
                content={"detail": "this Worker only supports network_mode=deny"},
            )
        request.state.invocation = invocation
    return await call_next(request)


def _invocation(request: Request, task_id: str) -> InvocationContext:
    value: InvocationContext = request.state.invocation
    if value.task_id != task_id:
        raise HTTPException(403, "invocation task mismatch")
    return value


def _same_owner(value: Any, invocation: InvocationContext) -> bool:
    if isinstance(value, Session):
        return (
            value.task_id == invocation.task_id
            and value.run_id == invocation.run_id
            and value.agent_session_id == invocation.session_id
        )
    return (
        value.get("task_id") == invocation.task_id
        and value.get("run_id") == invocation.run_id
        and value.get("agent_session_id") == invocation.session_id
    )


def _safe_workspace(raw: str, invocation: InvocationContext) -> Path:
    try:
        workspace = Path(raw).resolve()
        run_workspace = Path(invocation.workspace).resolve()
    except OSError as exc:
        raise HTTPException(403, f"workspace path is inaccessible: {type(exc).__name__}") from exc
    if ROOT not in run_workspace.parents and run_workspace != ROOT:
        raise HTTPException(403, "run workspace outside worker root")
    if run_workspace not in workspace.parents and workspace != run_workspace:
        raise HTTPException(403, "workspace outside run workspace")
    owner = (invocation.run_id, invocation.task_id)
    with _lock:
        existing = workspace_owners.get(str(run_workspace))
        if existing is not None and existing != owner:
            raise HTTPException(409, "run workspace is owned by another task")
        workspace_owners[str(run_workspace)] = owner
    try:
        run_workspace.mkdir(parents=True, exist_ok=True)
        workspace.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(403, f"workspace is inaccessible: {type(exc).__name__}") from exc
    return workspace


def _temporary_directory(run_workspace: Path) -> Path:
    temporary = run_workspace / ".worker_tmp"
    try:
        temporary.mkdir(exist_ok=True)
    except OSError as exc:
        raise HTTPException(403, f"worker temporary directory is inaccessible: {type(exc).__name__}") from exc
    return temporary


def _ensure_active(invocation: InvocationContext) -> None:
    if (invocation.run_id, invocation.task_id) in cancelled_runs:
        raise HTTPException(409, "run was cancelled")


def _safe_pgid(pid: int) -> int | None:
    try:
        return os.getpgid(pid)
    except ProcessLookupError:
        return None


def _terminate_group(pid: int, *, grace: float = TERMINATE_GRACE_SECONDS, reap: bool = True) -> None:
    """Terminate one child process group; PTY owners also reap the leader."""
    pgid = _safe_pgid(pid)
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + grace
    if reap:
        while time.monotonic() < deadline:
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
                if waited:
                    return
            except ChildProcessError:
                return
            time.sleep(0.03)
    else:
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.03)
    pgid = _safe_pgid(pid)
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if reap:
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass


def _owned(session_id: str, task_id: str, invocation: InvocationContext) -> Session:
    session = sessions.get(session_id)
    if not session or session.task_id != task_id or not _same_owner(session, invocation):
        raise HTTPException(404, "session not found")
    return session


def _close_session(session_id: str, *, terminal_status: str = "CANCELLED") -> Dict[str, Any]:
    with _lock:
        session = sessions.pop(session_id, None)
    if not session:
        return {"session_id": session_id, "status": "already_closed"}
    _terminate_group(session.pid)
    try:
        os.close(session.master_fd)
    except OSError:
        pass
    session.status = terminal_status
    return {"session_id": session_id, "task_id": session.task_id, "status": terminal_status}


def _command_view(rec: Dict[str, Any]) -> Dict[str, Any]:
    return {key: value for key, value in rec.items() if key not in {"_proc", "_thread"}}


def _finish_command(rec: Dict[str, Any], proc: subprocess.Popen[str], out: str, err: str) -> None:
    with _lock:
        cancelled = rec["cancellation_requested"]
        rec.update({
            "status": "CANCELLED" if cancelled else ("COMPLETED" if proc.returncode == 0 else "FAILED"),
            "exit_code": proc.returncode,
            "stdout": (out or "")[:rec["max_output_bytes"]],
            "stderr": (err or "")[:rec["max_output_bytes"]],
            "completed_at": time.time(),
            "truncated": len(out or "") > rec["max_output_bytes"] or len(err or "") > rec["max_output_bytes"],
        })


def _run_command(command_id: str, payload: CommandRequest, run_workspace: str) -> None:
    with _lock:
        rec = commands[command_id]
        if rec["cancellation_requested"]:
            rec.update({"status": "CANCELLED", "completed_at": time.time()})
            return
        rec["status"] = "RUNNING"
    temporary = Path(run_workspace) / ".worker_tmp"
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": run_workspace,
        "TMPDIR": str(temporary),
        "PYTHONPATH": "/opt/worker",
        "PYTHONDONTWRITEBYTECODE": "1",
        **payload.environment,
    }
    command = ["/bin/sh", "-lc", payload.command] if payload.shell else [payload.command, *payload.arguments]
    argv = [sys.executable, "-m", "app.sandbox_exec", run_workspace, "--", *command]
    try:
        proc = subprocess.Popen(argv, cwd=payload.cwd, env=env, stdout=subprocess.PIPE if payload.capture_stdout else subprocess.DEVNULL, stderr=subprocess.PIPE if payload.capture_stderr else subprocess.DEVNULL, start_new_session=True, text=True)
        with _lock:
            rec.update({"pid": proc.pid, "pgid": _safe_pgid(proc.pid), "_proc": proc})
            cancelled = rec["cancellation_requested"]
        if cancelled:
            _terminate_group(proc.pid, reap=False)
        try:
            out, err = proc.communicate(timeout=payload.timeout_seconds)
            _finish_command(rec, proc, out, err)
        except subprocess.TimeoutExpired:
            with _lock:
                rec["status"] = "CANCELLING"
            _terminate_group(proc.pid, reap=False)
            out, err = proc.communicate()
            with _lock:
                rec.update({
                    "status": "TIMED_OUT",
                    "exit_code": proc.returncode,
                    "stdout": (out or "")[:rec["max_output_bytes"]],
                    "stderr": (err or "")[:rec["max_output_bytes"]],
                    "completed_at": time.time(),
                    "truncated": (
                        len(out or "") > rec["max_output_bytes"]
                        or len(err or "") > rec["max_output_bytes"]
                    ),
                })
    except Exception as exc:
        with _lock:
            rec.update({"status": "FAILED", "error_type": type(exc).__name__, "stderr": str(exc), "completed_at": time.time()})


@app.post("/commands")
def create_command(payload: CommandRequest, request: Request):
    invocation = _invocation(request, payload.task_id)
    _ensure_active(invocation)
    cwd = _safe_workspace(payload.cwd, invocation)
    run_workspace = _safe_workspace(invocation.workspace, invocation)
    _temporary_directory(run_workspace)
    payload.cwd = str(cwd)
    command_id = f"cmd_{uuid.uuid4().hex[:12]}"
    rec = {
        "command_id": command_id,
        "run_id": invocation.run_id,
        "agent_session_id": invocation.session_id,
        "tool_call_id": invocation.tool_call_id,
        "authorization": invocation.authorization,
        "scope": invocation.scope,
        "competition_id": payload.competition_id,
        "challenge_id": payload.challenge_id,
        "task_id": payload.task_id,
        "status": "QUEUED",
        "pid": None,
        "pgid": None,
        "started_at": time.time(),
        "completed_at": None,
        "exit_code": None,
        "stdout": "",
        "stderr": "",
        "truncated": False,
        "cancellation_requested": False,
        "error_type": "",
        "max_output_bytes": payload.max_output_bytes,
    }
    with _lock:
        commands[command_id] = rec
        thread = threading.Thread(target=_run_command, args=(command_id, payload, str(run_workspace)), daemon=True)
        rec["_thread"] = thread
        thread.start()
    return _command_view(rec)


@app.get("/commands/{command_id}")
def get_command(command_id: str, task_id: str, request: Request):
    invocation = _invocation(request, task_id)
    rec = commands.get(command_id)
    if not rec or rec["task_id"] != task_id or not _same_owner(rec, invocation):
        raise HTTPException(404, "command not found")
    return _command_view(rec)


def _cancel_command(rec: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        if rec["status"] in {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"}:
            return _command_view(rec)
        rec["cancellation_requested"] = True
        rec["status"] = "CANCELLING"
        proc = rec.get("_proc")
    if proc is not None:
        _terminate_group(proc.pid, reap=False)
    return _command_view(rec)


@app.post("/commands/{command_id}/cancel")
def cancel_command(command_id: str, task_id: str, request: Request):
    invocation = _invocation(request, task_id)
    rec = commands.get(command_id)
    if not rec or rec["task_id"] != task_id or not _same_owner(rec, invocation):
        raise HTTPException(404, "command not found")
    return _cancel_command(rec)


@app.get("/tasks/{task_id}/commands")
def list_commands(task_id: str, request: Request):
    invocation = _invocation(request, task_id)
    return {"commands": [_command_view(rec) for rec in commands.values() if _same_owner(rec, invocation)]}


@app.post("/sessions/pty")
def create_pty(payload: PtyCreate, request: Request):
    invocation = _invocation(request, payload.task_id)
    _ensure_active(invocation)
    workspace = _safe_workspace(payload.workspace, invocation)
    temporary = _temporary_directory(workspace)
    with _lock:
        if len(sessions) >= 16:
            raise HTTPException(429, "PTY session limit reached")
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.environ.clear(); os.environ.update({"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(workspace), "TMPDIR": str(temporary), "TERM": "xterm"})
        try:
            apply_workspace_landlock(workspace)
        except Exception as exc:
            os.write(2, f"workspace sandbox initialization failed: {type(exc).__name__}: {exc}\n".encode())
            os._exit(126)
        os.execv("/bin/sh", ["/bin/sh", "-lc", payload.command])
    session_id = f"pty_{uuid.uuid4().hex[:12]}"
    with _lock:
        sessions[session_id] = Session(
            invocation.run_id,
            invocation.session_id,
            invocation.tool_call_id,
            payload.task_id,
            payload.challenge_id,
            payload.competition_id,
            pid,
            master,
            time.time(),
            payload.timeout,
        )
    return {
        "session_id": session_id,
        "run_id": invocation.run_id,
        "agent_session_id": invocation.session_id,
        "tool_call_id": invocation.tool_call_id,
        "task_id": payload.task_id,
        "challenge_id": payload.challenge_id,
        "pid": pid,
        "pgid": _safe_pgid(pid),
        "status": "ACTIVE",
    }


@app.post("/sessions/{session_id}/write")
def write_pty(session_id: str, payload: PtyWrite, request: Request):
    invocation = _invocation(request, payload.task_id)
    session = _owned(session_id, payload.task_id, invocation)
    try:
        os.write(session.master_fd, payload.data.encode())
    except OSError as exc:
        raise HTTPException(409, f"session closed: {exc}")
    session.last_activity_at = time.time()
    return {"session_id": session_id, "written": len(payload.data)}


@app.get("/sessions/{session_id}/read")
def read_pty(session_id: str, task_id: str, request: Request, limit: int = 8192):
    invocation = _invocation(request, task_id)
    session = _owned(session_id, task_id, invocation); limit = max(1, min(limit, 20000)); chunks: list[bytes] = []
    while sum(map(len, chunks)) < limit:
        ready, _, _ = select.select([session.master_fd], [], [], 0)
        if not ready:
            break
        try:
            chunks.append(os.read(session.master_fd, limit - sum(map(len, chunks))))
        except OSError:
            break
    raw = b"".join(chunks)
    with _lock:
        session.output.extend(raw)
        session.output_cursor += len(raw)
        if len(session.output) > 1_000_000:
            overflow = len(session.output) - 1_000_000
            del session.output[:overflow]
            session.output_start += overflow
        cursor = session.output_cursor
        session.last_activity_at = time.time()
    try:
        waited, _ = os.waitpid(session.pid, os.WNOHANG)
        if waited:
            session.status = "EXITED"
    except ChildProcessError:
        session.status = "EXITED"
    return {"session_id": session_id, "status": session.status, "cursor": cursor, "raw_output": raw.decode(errors="replace"), "clean_output": raw.decode(errors="replace")}


@app.post("/sessions/{session_id}/expect")
def expect_pty(session_id: str, payload: PtyExpect, request: Request):
    invocation = _invocation(request, payload.task_id)
    session = _owned(session_id, payload.task_id, invocation)
    started = time.monotonic()
    while time.monotonic() - started < payload.timeout:
        with _lock:
            if payload.from_cursor < session.output_start:
                raise HTTPException(409, "requested PTY cursor has expired")
            if payload.from_cursor > session.output_cursor:
                raise HTTPException(400, "requested PTY cursor is ahead of output")
            offset = payload.from_cursor - session.output_start
            collected = bytes(session.output[offset:offset + payload.max_bytes])
            cursor = session.output_cursor
        text = collected.decode(errors="replace")
        match = re.search(payload.pattern, text) if payload.regex else re.search(re.escape(payload.pattern), text)
        if match:
            return {"matched": True, "match_text": match.group(0), "before": text[:match.start()], "after": text[match.end():], "next_cursor": cursor, "session_status": session.status, "exit_code": None, "truncated": len(collected) >= payload.max_bytes}
        if len(collected) >= payload.max_bytes or session.status == "EXITED":
            break
        read_pty(session_id, payload.task_id, request, min(4096, payload.max_bytes - len(collected)))
        time.sleep(.02)
    return {"matched": False, "match_text": "", "before": collected.decode(errors="replace"), "after": "", "next_cursor": session.output_cursor, "session_status": session.status, "exit_code": None, "truncated": len(collected) >= payload.max_bytes}


@app.delete("/sessions/{session_id}")
def close_pty(session_id: str, task_id: str, request: Request):
    invocation = _invocation(request, task_id)
    _owned(session_id, task_id, invocation)
    return _close_session(session_id)


@app.get("/tasks/{task_id}/sessions")
def list_sessions(task_id: str, request: Request):
    invocation = _invocation(request, task_id)
    return {"sessions": [{"session_id": sid, "task_id": item.task_id, "challenge_id": item.challenge_id, "pid": item.pid, "status": item.status, "created_at": item.created_at} for sid, item in sessions.items() if _same_owner(item, invocation)]}


@app.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: str, request: Request):
    invocation = _invocation(request, task_id)
    cancelled_runs.add((invocation.run_id, invocation.task_id))
    session_ids = [sid for sid, item in sessions.items() if _same_owner(item, invocation)]
    command_ids = [cid for cid, item in commands.items() if _same_owner(item, invocation)]
    closed = [_close_session(sid) for sid in session_ids]
    cancelled = [_cancel_command(commands[cid]) for cid in command_ids]
    with _lock:
        for workspace, owner in list(workspace_owners.items()):
            if owner == (invocation.run_id, invocation.task_id):
                workspace_owners.pop(workspace, None)
    return {"run_id": invocation.run_id, "task_id": task_id, "sessions": closed, "commands": cancelled, "status": "CANCEL_REQUESTED"}


@app.get("/health")
def health():
    return {"status": "ok", "boot_id": BOOT_ID, "platform": "linux", "capabilities": {"pty": True, "cancel": True, "process_groups": True, "landlock": True}}


@app.get("/capabilities")
def capabilities():
    return {"worker_id": "worker-base", "boot_id": BOOT_ID, "online": True, "platform": "linux", "architecture": os.uname().machine, "supports_pty": True, "supports_cancel": True, "supports_process_group": True, "supports_command": True, "supports_python": True, "supports_gdb": bool(os.path.exists("/usr/bin/gdb")), "max_sessions": 16, "active_sessions": len(sessions), "version": "1.2"}


def _reap_expired_sessions() -> None:
    while not _reaper_stop.wait(0.1):
        now = time.time()
        with _lock:
            expired = [
                session_id
                for session_id, session in sessions.items()
                if now - session.created_at >= session.timeout
            ]
        for session_id in expired:
            _close_session(session_id, terminal_status="TIMED_OUT")


@app.on_event("startup")
async def startup():
    global _reaper_thread
    _reaper_stop.clear()
    if _reaper_thread is None or not _reaper_thread.is_alive():
        _reaper_thread = threading.Thread(target=_reap_expired_sessions, daemon=True, name="worker-pty-reaper")
        _reaper_thread.start()


@app.on_event("shutdown")
async def shutdown():
    _reaper_stop.set()
    for sid in list(sessions):
        _close_session(sid, terminal_status="SHUTDOWN")
    for cid, rec in list(commands.items()):
        if rec["status"] not in {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"}:
            _cancel_command(rec)
