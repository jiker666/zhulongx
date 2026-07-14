from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from app.agent_engine.tools.types import ToolContext, ToolDefinition, ToolResult
from app.config import settings
from app.core.worker_client import WorkerClient, WorkerError


def _worker_workspace(context: ToolContext) -> str:
    shared_root = Path(settings.WORKER_SHARED_ROOT).expanduser().resolve()
    workspace = context.workspace.expanduser().resolve()
    try:
        relative = workspace.relative_to(shared_root)
    except ValueError as exc:
        raise WorkerError(
            "WORKSPACE_NOT_SHARED",
            f"run workspace is outside WORKER_SHARED_ROOT: {workspace}",
        ) from exc
    root = PurePosixPath(settings.WORKER_WORKSPACE_ROOT)
    return str(root.joinpath(*relative.parts))


def _invocation(context: ToolContext, workspace: str) -> dict[str, Any]:
    authorization = context.request.authorization
    return {
        "run_id": context.run_id,
        "session_id": context.run_id,
        "task_id": context.request.task_id,
        "tool_call_id": context.tool_call_id,
        "workspace": workspace,
        "authorization": {
            "authorized": bool(authorization.get("authorized", False)),
            "allow_process": bool(authorization.get("allow_process", False)),
            "allow_worker": bool(authorization.get("allow_worker", False)),
            "approval_mode": str(authorization.get("approval_mode", "")),
        },
        "scope": {
            "network_mode": context.request.network_policy.mode,
            "allowed_hosts": list(context.request.network_policy.allowed_hosts),
            "allowed_ports": list(context.request.network_policy.allowed_ports),
        },
    }


def _child_workspace(root: str, raw: object) -> str:
    base = PurePosixPath(root)
    if raw in (None, "", "."):
        return str(base)
    candidate = PurePosixPath(str(raw))
    if candidate.is_absolute():
        try:
            candidate.relative_to(base)
        except ValueError as exc:
            raise WorkerError("WORKSPACE_NOT_SHARED", "worker cwd is outside the run workspace") from exc
        return str(candidate)
    if ".." in candidate.parts:
        raise WorkerError("WORKSPACE_NOT_SHARED", "worker cwd contains parent traversal")
    return str(base.joinpath(candidate))


def _register_task_abort(context: ToolContext, invocation: Mapping[str, Any]) -> None:
    task_id = context.request.task_id

    def cancel() -> None:
        client = WorkerClient()
        client.sync(client.cancel_task(task_id, invocation=invocation))

    context.abort_token.register(cancel)


class WorkerExecutor:
    def __init__(self, operation: str) -> None:
        self.operation = operation

    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        try:
            context.abort_token.raise_if_aborted()
            workspace = _worker_workspace(context)
            invocation = _invocation(context, workspace)
            client = WorkerClient()
            task_id = context.request.task_id
            challenge_id = str(context.request.authorization.get("challenge_id", task_id))
            competition_id = str(context.request.authorization.get("competition_id", ""))

            if self.operation == "health":
                response = client.sync(client.health(invocation))
            elif self.operation == "capabilities":
                response = client.sync(client.capabilities(invocation)).model_dump()
            elif self.operation == "command.run":
                _register_task_abort(context, invocation)
                response = client.sync(client.run_command({
                    "competition_id": competition_id,
                    "challenge_id": challenge_id,
                    "task_id": task_id,
                    "command": str(arguments["command"]),
                    "arguments": [str(item) for item in arguments.get("arguments", [])],
                    "cwd": _child_workspace(workspace, arguments.get("cwd")),
                    "environment": {str(key): str(value) for key, value in dict(arguments.get("environment", {})).items()},
                    "timeout_seconds": int(arguments.get("timeout_seconds", 60)),
                    "max_output_bytes": int(arguments.get("max_output_bytes", 20_000)),
                    "shell": bool(arguments.get("shell", False)),
                }, invocation=invocation))
            elif self.operation == "command.status":
                response = client.sync(client.get_command(task_id, str(arguments["command_id"]), invocation=invocation))
            elif self.operation == "command.cancel":
                response = client.sync(client.cancel_command(task_id, str(arguments["command_id"]), invocation=invocation))
            elif self.operation == "task.cancel":
                response = client.sync(client.cancel_task(task_id, invocation=invocation))
            elif self.operation == "terminal.create":
                _register_task_abort(context, invocation)
                response = client.sync(client.create_pty_session(
                    task_id,
                    challenge_id,
                    workspace,
                    str(arguments.get("command", "/bin/sh")),
                    int(arguments.get("timeout", 60)),
                    competition_id,
                    invocation=invocation,
                ))
            elif self.operation == "terminal.send":
                response = client.sync(client.write_pty_session(
                    task_id,
                    str(arguments["session_id"]),
                    str(arguments["data"]),
                    invocation=invocation,
                ))
            elif self.operation == "terminal.read":
                response = client.sync(client.read_pty_session(
                    task_id,
                    str(arguments["session_id"]),
                    int(arguments.get("limit", 8192)),
                    invocation=invocation,
                ))
            elif self.operation == "terminal.expect":
                response = client.sync(client.expect_pty_session(
                    task_id,
                    str(arguments["session_id"]),
                    str(arguments["pattern"]),
                    regex=bool(arguments.get("regex", False)),
                    timeout=float(arguments.get("timeout", 5)),
                    from_cursor=int(arguments.get("from_cursor", 0)),
                    max_bytes=int(arguments.get("max_bytes", 20_000)),
                    invocation=invocation,
                ))
            elif self.operation == "terminal.close":
                response = client.sync(client.close_pty_session(
                    task_id,
                    str(arguments["session_id"]),
                    invocation=invocation,
                ))
            else:
                raise WorkerError("WORKER_PROTOCOL_ERROR", f"unknown Worker operation: {self.operation}")
            return ToolResult(
                True,
                f"Worker {self.operation} completed",
                output=json.dumps(response, ensure_ascii=False, default=str),
                metadata={
                    "worker_operation": self.operation,
                    "run_id": context.run_id,
                    "task_id": task_id,
                    "tool_call_id": context.tool_call_id,
                    "worker_response": response,
                },
            )
        except WorkerError as exc:
            return ToolResult(
                False,
                f"Worker {self.operation} failed",
                error=str(exc),
                metadata={"code": exc.error_type, "retryable": exc.retryable},
            )


def _definition(
    name: str,
    description: str,
    operation: str,
    schema: Mapping[str, Any],
    *,
    process: bool = False,
    risk: str = "medium",
) -> ToolDefinition:
    permissions = ("worker_execution", "process_execution") if process else ("worker_execution",)
    return ToolDefinition(
        name=name,
        description=description,
        input_schema=schema,
        risk_level=risk,
        permissions=permissions,
        timeout_seconds=60,
        executor=WorkerExecutor(operation),
        idempotency="non_idempotent",
        side_effect_level="execute" if process else "read",
        resource_locks=("worker_task",),
        parallel_safe=False,
        evidence_type="worker_result",
    )


_EMPTY_SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}
_SESSION_SCHEMA = {
    "type": "object",
    "properties": {"session_id": {"type": "string", "minLength": 1, "maxLength": 100}},
    "required": ["session_id"],
    "additionalProperties": False,
}


def worker_definitions() -> tuple[ToolDefinition, ...]:
    return (
        _definition("worker.health", "Check the configured isolated Worker.", "health", _EMPTY_SCHEMA),
        _definition("worker.capabilities", "Read isolated Worker capability metadata.", "capabilities", _EMPTY_SCHEMA),
        _definition(
            "worker.command.run",
            "Queue a bounded command in the isolated Worker run workspace.",
            "command.run",
            {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "minLength": 1, "maxLength": 20_000},
                    "arguments": {"type": "array", "items": {"type": "string", "maxLength": 4096}, "maxItems": 200},
                    "cwd": {"type": "string", "maxLength": 4096},
                    "environment": {"type": "object", "additionalProperties": {"type": "string", "maxLength": 8192}},
                    "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 3600},
                    "max_output_bytes": {"type": "integer", "minimum": 1, "maximum": 1_000_000},
                    "shell": {"type": "boolean"},
                },
                "required": ["command"],
                "additionalProperties": False,
            },
            process=True,
            risk="high",
        ),
        _definition(
            "worker.command.status",
            "Read one task-owned Worker command result.",
            "command.status",
            {
                "type": "object",
                "properties": {"command_id": {"type": "string", "minLength": 1, "maxLength": 100}},
                "required": ["command_id"],
                "additionalProperties": False,
            },
        ),
        _definition(
            "worker.command.cancel",
            "Cancel one task-owned Worker command process group.",
            "command.cancel",
            {
                "type": "object",
                "properties": {"command_id": {"type": "string", "minLength": 1, "maxLength": 100}},
                "required": ["command_id"],
                "additionalProperties": False,
            },
            process=True,
            risk="high",
        ),
        _definition("worker.task.cancel", "Cancel all Worker resources owned by this run and task.", "task.cancel", _EMPTY_SCHEMA, process=True, risk="high"),
        _definition(
            "terminal.create",
            "Create a task-owned PTY in the isolated Worker workspace.",
            "terminal.create",
            {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "minLength": 1, "maxLength": 20_000},
                    "timeout": {"type": "integer", "minimum": 1, "maximum": 3600},
                },
                "additionalProperties": False,
            },
            process=True,
            risk="high",
        ),
        _definition(
            "terminal.send",
            "Write bounded input to a task-owned Worker PTY.",
            "terminal.send",
            {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "minLength": 1, "maxLength": 100},
                    "data": {"type": "string", "maxLength": 8192},
                },
                "required": ["session_id", "data"],
                "additionalProperties": False,
            },
            process=True,
            risk="high",
        ),
        _definition(
            "terminal.read",
            "Read bounded incremental output from a task-owned Worker PTY.",
            "terminal.read",
            {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "minLength": 1, "maxLength": 100},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20_000},
                },
                "required": ["session_id"],
                "additionalProperties": False,
            },
        ),
        _definition(
            "terminal.expect",
            "Wait for bounded output from a task-owned Worker PTY.",
            "terminal.expect",
            {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "minLength": 1, "maxLength": 100},
                    "pattern": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "regex": {"type": "boolean"},
                    "timeout": {"type": "number", "minimum": 0.1, "maximum": 60},
                    "from_cursor": {"type": "integer", "minimum": 0},
                    "max_bytes": {"type": "integer", "minimum": 1, "maximum": 100_000},
                },
                "required": ["session_id", "pattern"],
                "additionalProperties": False,
            },
        ),
        _definition("terminal.close", "Close a task-owned Worker PTY and process group.", "terminal.close", _SESSION_SCHEMA, process=True, risk="high"),
    )


__all__ = ["WorkerExecutor", "worker_definitions"]
