"""Broker-registered Worker PTY tools."""
from typing import Any, Dict
from app.tools.base import BaseTool

class _WorkerTool(BaseTool):
    permissions = ["worker_execute"]; risk_level = "high"; timeout_seconds = 60
    def _client(self, context):
        from app.core.worker_client import WorkerClient
        return WorkerClient(context.get("worker_base_url"))
    def _workspace(self, context): return context.get("worker_workspace") or f"/workspace/tasks/{context['task_id']}"
    def _error(self, exc): return {"success": False, "summary": str(exc), "details": {"error_type": getattr(exc, "error_type", "TOOL_NOT_AVAILABLE"), "retryable": getattr(exc, "retryable", False)}, "evidence": []}

class WorkerHealthTool(_WorkerTool):
    name = "worker.health"; description = "Check isolated Linux Worker health"; category = "worker"; input_schema = {"type": "object"}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "worker healthy", "details": client.sync(client.health()), "evidence": []}
        except Exception as exc: return self._error(exc)

class TerminalCreateTool(_WorkerTool):
    name = "terminal.create"; description = "Create a real Linux PTY session"; category = "worker"; input_schema = {"type": "object", "properties": {"command": {"type": "string"}, "timeout": {"type": "integer"}}, "required": []}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "PTY session created", "details": client.sync(client.create_pty_session(str(context["task_id"]), str(context.get("challenge_id", "")), self._workspace(context), context.get("command", "/bin/sh"), int(context.get("timeout", 60)), str(context.get("competition_id", "")))), "evidence": []}
        except Exception as exc: return self._error(exc)

class TerminalSendTool(_WorkerTool):
    name = "terminal.send"; description = "Write to a Linux PTY"; category = "worker"; input_schema = {"type": "object", "properties": {"session_id": {"type": "string"}, "data": {"type": "string"}}, "required": ["session_id", "data"]}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "PTY data sent", "details": client.sync(client.write_pty_session(str(context["task_id"]), context["session_id"], context["data"])), "evidence": []}
        except Exception as exc: return self._error(exc)

class TerminalReadTool(_WorkerTool):
    name = "terminal.read"; description = "Read incremental Linux PTY output"; category = "worker"; input_schema = {"type": "object", "properties": {"session_id": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["session_id"]}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "PTY output read", "details": client.sync(client.read_pty_session(str(context["task_id"]), context["session_id"], int(context.get("limit", 8192)))), "evidence": []}
        except Exception as exc: return self._error(exc)

class TerminalExpectTool(_WorkerTool):
    name = "terminal.expect"; description = "Wait for output from a Linux PTY"; category = "worker"; input_schema = {"type": "object", "properties": {"session_id": {"type": "string"}, "pattern": {"type": "string"}, "regex": {"type": "boolean"}, "timeout": {"type": "number"}, "from_cursor": {"type": "integer"}, "max_bytes": {"type": "integer"}}, "required": ["session_id", "pattern"]}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "PTY expect completed", "details": client.sync(client.expect_pty_session(str(context["task_id"]), context["session_id"], context["pattern"], regex=bool(context.get("regex", False)), timeout=float(context.get("timeout", 5)), from_cursor=int(context.get("from_cursor", 0)), max_bytes=int(context.get("max_bytes", 20000)))), "evidence": []}
        except Exception as exc: return self._error(exc)

class TerminalCloseTool(_WorkerTool):
    name = "terminal.close"; description = "Close a Linux PTY and process group"; category = "worker"; input_schema = {"type": "object", "properties": {"session_id": {"type": "string"}}, "required": ["session_id"]}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "PTY closed", "details": client.sync(client.close_pty_session(str(context["task_id"]), context["session_id"])), "evidence": []}
        except Exception as exc: return self._error(exc)

class WorkerCommandRunTool(_WorkerTool):
    name = "worker.command.run"; description = "Run a bounded command in the Linux Worker"; category = "worker"; input_schema = {"type": "object", "properties": {"command": {"type": "string"}, "cwd": {"type": "string"}, "timeout_seconds": {"type": "integer"}}, "required": ["command"]}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try:
            payload = {"competition_id": context.get("competition_id", ""), "challenge_id": context.get("challenge_id", ""), "task_id": context["task_id"], "command": context["command"], "arguments": context.get("arguments", []), "cwd": context.get("cwd", self._workspace(context)), "environment": context.get("environment", {}), "timeout_seconds": int(context.get("timeout_seconds", 60)), "max_output_bytes": int(context.get("max_output_bytes", 20000)), "shell": bool(context.get("shell", False))}
            return {"success": True, "summary": "worker command queued", "details": client.sync(client.run_command(payload)), "evidence": []}
        except Exception as exc: return self._error(exc)

class WorkerCommandStatusTool(_WorkerTool):
    name = "worker.command.status"; description = "Read Worker command status"; category = "worker"; input_schema = {"type": "object", "properties": {"command_id": {"type": "string"}}, "required": ["command_id"]}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "worker command status", "details": client.sync(client.get_command(context["task_id"], context["command_id"])), "evidence": []}
        except Exception as exc: return self._error(exc)

class WorkerCommandCancelTool(_WorkerTool):
    name = "worker.command.cancel"; description = "Cancel a Worker command process group"; category = "worker"; input_schema = {"type": "object", "properties": {"command_id": {"type": "string"}}, "required": ["command_id"]}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "worker command cancelled", "details": client.sync(client.cancel_command(context["task_id"], context["command_id"])), "evidence": []}
        except Exception as exc: return self._error(exc)

class WorkerTaskCancelTool(_WorkerTool):
    name = "worker.task.cancel"; description = "Cancel and reap all Worker resources owned by a task"; category = "worker"; input_schema = {"type": "object"}; output_schema = {"type": "object"}
    def run(self, context):
        client = self._client(context)
        try: return {"success": True, "summary": "worker task cancellation requested", "details": client.sync(client.cancel_task(str(context["task_id"]))), "evidence": []}
        except Exception as exc: return self._error(exc)
