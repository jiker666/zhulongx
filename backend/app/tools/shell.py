"""
RunShellTool — 封装 CodeExecutionSandbox.run_shell 的工具。

安全约束：
- 继续使用危险命令扫描
- 禁止 rm/curl|sh/wget|sh/sudo/ssh/scp/docker/podman 等
- 默认禁网
- 记录 exit_code、duration_ms、timed_out
"""
from __future__ import annotations

from typing import Any, Dict

from app.tools.base import BaseTool
from app.core.tool_protocol import ToolSpec
from app.config import settings


class RunShellTool(BaseTool):
    name = "run_shell"
    description = "执行 shell 命令。禁止 rm/curl|sh/wget|sh/sudo/ssh/docker 等危险命令。默认禁网。"
    category = "execution"
    input_schema = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "要执行的 shell 命令"},
            "timeout": {"type": "integer", "description": "超时秒数", "default": 15},
            "purpose": {"type": "string", "description": "命令用途说明", "default": ""},
        },
        "required": ["command"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "exit_code": {"type": "integer"},
            "stdout": {"type": "string"},
            "stderr": {"type": "string"},
            "duration_ms": {"type": "integer"},
            "timed_out": {"type": "boolean"},
        },
    }
    permissions = ["local_execute"]
    risk_level = "medium"
    timeout_seconds = 30

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        from app.core.code_execution_sandbox import get_sandbox
        command = context.get("command", "")
        if not command:
            return {"success": False, "summary": "empty command", "details": {"error": "empty_command"}, "evidence": []}
        workspace = context.get("workspace", ".")
        timeout = int(context.get("timeout", settings.CTF_SANDBOX_TIMEOUT))
        allow_network = context.get("allow_network", False) and context.get("authorized", False)
        try:
            sandbox = get_sandbox(allow_network=allow_network) if allow_network else get_sandbox(allow_network=False)
            res = sandbox.run_shell(command, workdir=workspace, timeout=timeout)
            return {
                "success": res.success,
                "summary": f"exit_code={res.exit_code} duration={res.duration_ms}ms",
                "details": {
                    "exit_code": res.exit_code,
                    "stdout": res.stdout[:5000],
                    "stderr": res.stderr[:2000],
                    "duration_ms": res.duration_ms,
                    "timed_out": res.timed_out,
                },
                "evidence": [],
            }
        except ValueError as e:
            return {"success": False, "summary": f"沙箱拒绝: {e}", "details": {"error": str(e)}, "evidence": []}
        except Exception as e:
            return {"success": False, "summary": str(e), "details": {"error": str(e)}, "evidence": []}

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )
