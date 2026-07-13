"""Isolated Linux Worker with task-scoped, reaped process lifecycle."""
from __future__ import annotations

import os
import pty
import re
import select
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

ROOT = Path(os.environ.get("WORKER_WORKSPACE_ROOT", "/workspace/tasks")).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
BOOT_ID = uuid.uuid4().hex
TERMINATE_GRACE_SECONDS = float(os.environ.get("WORKER_TERMINATE_GRACE_SECONDS", "1.5"))
app = FastAPI(title="ZHULONG-X Linux Worker", version="1.1")
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
    arguments: list[str] = []
    cwd: str
    environment: Dict[str, str] = {}
    timeout_seconds: int = Field(60, ge=1, le=3600)
    max_output_bytes: int = Field(20000, ge=1, le=1000000)
    shell: bool = False
    capture_stdout: bool = True
    capture_stderr: bool = True


@dataclass
class Session:
    task_id: str
    challenge_id: str
    competition_id: str
    pid: int
    master_fd: int
    created_at: float
    timeout: int
    status: str = "ACTIVE"
    output_cursor: int = 0
    last_activity_at: float = field(default_factory=time.time)


sessions: Dict[str, Session] = {}
commands: Dict[str, Dict[str, Any]] = {}


def _safe_pgid(pid: int) -> int | None:
    try:
        return os.getpgid(pid)
    except ProcessLookupError:
        return None


def _terminate_group(pid: int, *, grace: float = TERMINATE_GRACE_SECONDS) -> None:
    """Terminate exactly the child process group and always reap the leader."""
    pgid = _safe_pgid(pid)
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        try:
            waited, _ = os.waitpid(pid, os.WNOHANG)
            if waited:
                return
        except ChildProcessError:
            return
        time.sleep(0.03)
    pgid = _safe_pgid(pid)
    if pgid is not None:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def _owned(session_id: str, task_id: str) -> Session:
    session = sessions.get(session_id)
    if not session or session.task_id != task_id:
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


def _run_command(command_id: str, payload: CommandRequest) -> None:
    with _lock:
        rec = commands[command_id]
        if rec["cancellation_requested"]:
            rec.update({"status": "CANCELLED", "completed_at": time.time()})
            return
        rec["status"] = "RUNNING"
    env = {"PATH": "/usr/bin:/bin", **payload.environment}
    argv = ["/bin/sh", "-lc", payload.command] if payload.shell else [payload.command, *payload.arguments]
    try:
        proc = subprocess.Popen(argv, cwd=payload.cwd, env=env, stdout=subprocess.PIPE if payload.capture_stdout else subprocess.DEVNULL, stderr=subprocess.PIPE if payload.capture_stderr else subprocess.DEVNULL, start_new_session=True, text=True)
        with _lock:
            rec.update({"pid": proc.pid, "pgid": _safe_pgid(proc.pid), "_proc": proc})
            cancelled = rec["cancellation_requested"]
        if cancelled:
            _terminate_group(proc.pid)
        try:
            out, err = proc.communicate(timeout=payload.timeout_seconds)
            _finish_command(rec, proc, out, err)
        except subprocess.TimeoutExpired:
            with _lock:
                rec["status"] = "CANCELLING"
            _terminate_group(proc.pid)
            out, err = proc.communicate()
            with _lock:
                rec.update({"status": "TIMED_OUT", "exit_code": proc.returncode, "stdout": (out or "")[:rec["max_output_bytes"]], "stderr": (err or "")[:rec["max_output_bytes"]], "completed_at": time.time()})
    except Exception as exc:
        with _lock:
            rec.update({"status": "FAILED", "error_type": type(exc).__name__, "stderr": str(exc), "completed_at": time.time()})


@app.post("/commands")
def create_command(payload: CommandRequest):
    cwd = Path(payload.cwd).resolve()
    if ROOT not in cwd.parents and cwd != ROOT:
        raise HTTPException(403, "workspace outside worker root")
    cwd.mkdir(parents=True, exist_ok=True)
    command_id = f"cmd_{uuid.uuid4().hex[:12]}"
    rec = {"command_id": command_id, "competition_id": payload.competition_id, "challenge_id": payload.challenge_id, "task_id": payload.task_id, "status": "QUEUED", "pid": None, "pgid": None, "started_at": time.time(), "completed_at": None, "exit_code": None, "stdout": "", "stderr": "", "truncated": False, "cancellation_requested": False, "error_type": "", "max_output_bytes": payload.max_output_bytes}
    with _lock:
        commands[command_id] = rec
        thread = threading.Thread(target=_run_command, args=(command_id, payload), daemon=True)
        rec["_thread"] = thread
        thread.start()
    return _command_view(rec)


@app.get("/commands/{command_id}")
def get_command(command_id: str, task_id: str):
    rec = commands.get(command_id)
    if not rec or rec["task_id"] != task_id:
        raise HTTPException(404, "command not found")
    return _command_view(rec)


@app.post("/commands/{command_id}/cancel")
def cancel_command(command_id: str, task_id: str):
    rec = commands.get(command_id)
    if not rec or rec["task_id"] != task_id:
        raise HTTPException(404, "command not found")
    with _lock:
        if rec["status"] in {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"}:
            return _command_view(rec)
        rec["cancellation_requested"] = True
        rec["status"] = "CANCELLING"
        proc = rec.get("_proc")
    if proc is not None:
        _terminate_group(proc.pid)
    return _command_view(rec)


@app.get("/tasks/{task_id}/commands")
def list_commands(task_id: str):
    return {"commands": [_command_view(rec) for rec in commands.values() if rec["task_id"] == task_id]}


@app.post("/sessions/pty")
def create_pty(payload: PtyCreate):
    workspace = Path(payload.workspace).resolve()
    if ROOT not in workspace.parents and workspace != ROOT:
        raise HTTPException(403, "workspace outside worker root")
    workspace.mkdir(parents=True, exist_ok=True)
    with _lock:
        if len(sessions) >= 16:
            raise HTTPException(429, "PTY session limit reached")
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.environ.clear(); os.environ.update({"PATH": "/usr/bin:/bin", "HOME": "/tmp", "TERM": "xterm"})
        os.execv("/bin/sh", ["/bin/sh", "-lc", payload.command])
    session_id = f"pty_{uuid.uuid4().hex[:12]}"
    with _lock:
        sessions[session_id] = Session(payload.task_id, payload.challenge_id, payload.competition_id, pid, master, time.time(), payload.timeout)
    return {"session_id": session_id, "task_id": payload.task_id, "challenge_id": payload.challenge_id, "pid": pid, "pgid": _safe_pgid(pid), "status": "ACTIVE"}


@app.post("/sessions/{session_id}/write")
def write_pty(session_id: str, payload: PtyWrite):
    session = _owned(session_id, payload.task_id)
    try:
        os.write(session.master_fd, payload.data.encode())
    except OSError as exc:
        raise HTTPException(409, f"session closed: {exc}")
    session.last_activity_at = time.time()
    return {"session_id": session_id, "written": len(payload.data)}


@app.get("/sessions/{session_id}/read")
def read_pty(session_id: str, task_id: str, limit: int = 8192):
    session = _owned(session_id, task_id); limit = max(1, min(limit, 20000)); chunks: list[bytes] = []
    while sum(map(len, chunks)) < limit:
        ready, _, _ = select.select([session.master_fd], [], [], 0)
        if not ready:
            break
        try:
            chunks.append(os.read(session.master_fd, limit - sum(map(len, chunks))))
        except OSError:
            break
    raw = b"".join(chunks); session.output_cursor += len(raw); session.last_activity_at = time.time()
    try:
        waited, _ = os.waitpid(session.pid, os.WNOHANG)
        if waited:
            session.status = "EXITED"
    except ChildProcessError:
        session.status = "EXITED"
    return {"session_id": session_id, "status": session.status, "cursor": session.output_cursor, "raw_output": raw.decode(errors="replace"), "clean_output": raw.decode(errors="replace")}


@app.post("/sessions/{session_id}/expect")
def expect_pty(session_id: str, payload: PtyExpect):
    session = _owned(session_id, payload.task_id); started = time.time(); collected = b""
    while time.time() - started < payload.timeout and len(collected) < payload.max_bytes:
        data = read_pty(session_id, payload.task_id, min(4096, payload.max_bytes - len(collected)))
        collected += data["raw_output"].encode(); text = collected.decode(errors="replace")
        match = re.search(payload.pattern, text) if payload.regex else re.search(re.escape(payload.pattern), text)
        if match:
            return {"matched": True, "match_text": match.group(0), "before": text[:match.start()], "after": text[match.end():], "next_cursor": data["cursor"], "session_status": data["status"], "exit_code": None, "truncated": len(collected) >= payload.max_bytes}
        time.sleep(.02)
    return {"matched": False, "match_text": "", "before": collected.decode(errors="replace"), "after": "", "next_cursor": session.output_cursor, "session_status": session.status, "exit_code": None, "truncated": len(collected) >= payload.max_bytes}


@app.delete("/sessions/{session_id}")
def close_pty(session_id: str, task_id: str):
    _owned(session_id, task_id)
    return _close_session(session_id)


@app.get("/tasks/{task_id}/sessions")
def list_sessions(task_id: str):
    return {"sessions": [{"session_id": sid, "task_id": item.task_id, "challenge_id": item.challenge_id, "pid": item.pid, "status": item.status, "created_at": item.created_at} for sid, item in sessions.items() if item.task_id == task_id]}


@app.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: str):
    session_ids = [sid for sid, item in sessions.items() if item.task_id == task_id]
    command_ids = [cid for cid, item in commands.items() if item["task_id"] == task_id]
    closed = [_close_session(sid) for sid in session_ids]
    cancelled = [cancel_command(cid, task_id) for cid in command_ids]
    return {"task_id": task_id, "sessions": closed, "commands": cancelled, "status": "CANCEL_REQUESTED"}


@app.get("/health")
def health():
    return {"status": "ok", "boot_id": BOOT_ID, "platform": "linux", "capabilities": {"pty": True, "cancel": True, "process_groups": True}}


@app.get("/capabilities")
def capabilities():
    return {"worker_id": "worker-base", "boot_id": BOOT_ID, "online": True, "platform": "linux", "architecture": os.uname().machine, "supports_pty": True, "supports_cancel": True, "supports_process_group": True, "supports_command": True, "supports_python": True, "supports_gdb": bool(os.path.exists("/usr/bin/gdb")), "max_sessions": 16, "active_sessions": len(sessions), "version": "1.1"}


@app.on_event("shutdown")
async def shutdown():
    for sid in list(sessions):
        _close_session(sid, terminal_status="SHUTDOWN")
    for cid, rec in list(commands.items()):
        if rec["status"] not in {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"}:
            cancel_command(cid, rec["task_id"])
