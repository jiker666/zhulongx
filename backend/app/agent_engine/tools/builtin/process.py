from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import Any, Mapping

from app.agent_engine.tools.types import ToolContext, ToolResult


def _process_result(result: object, label: str) -> ToolResult:
    stdout = getattr(result, "stdout", "") or ""
    stderr = getattr(result, "stderr", "") or ""
    output = f"exit_code={getattr(result, 'exit_code', -1)}\n{stdout}"
    if stderr:
        output += f"\n--- stderr ---\n{stderr}"
    if getattr(result, "timed_out", False):
        return ToolResult(False, f"{label} timed out", output=output, error="timeout")
    if getattr(result, "aborted", False):
        return ToolResult(False, f"{label} aborted", output=output, error="aborted")
    return ToolResult(bool(getattr(result, "success", False)), f"{label} completed", output=output, error="" if getattr(result, "success", False) else stderr)


class RunShellExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        timeout = float(arguments.get("timeout_seconds", 15))
        result = context.sandbox.run(
            ["/bin/sh", "-c", str(arguments["command"])],
            cwd=context.workspace,
            timeout_seconds=min(timeout, 30),
            abort_token=context.abort_token,
        )
        return _process_result(result, "shell")


class RunPythonExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        work_dir = context.workspace / ".agent_work"
        work_dir.mkdir(parents=True, exist_ok=True)
        script = work_dir / f"run_{uuid.uuid4().hex}.py"
        script.write_text(str(arguments["code"]), encoding="utf-8")
        timeout = float(arguments.get("timeout_seconds", 15))
        result = context.sandbox.run(
            [sys.executable, str(script)],
            cwd=context.workspace,
            timeout_seconds=min(timeout, 30),
            abort_token=context.abort_token,
        )
        tool_result = _process_result(result, "python")
        return ToolResult(
            tool_result.success,
            tool_result.summary,
            output=tool_result.output,
            error=tool_result.error,
            artifacts=({"path": str(script.relative_to(context.workspace)), "kind": "generated_script"},),
            metadata=tool_result.metadata,
        )
