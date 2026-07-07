"""
RunPythonTool — 封装 CodeExecutionSandbox 写脚本+执行。

安全约束：
- 使用 sandbox.write_script 和 sandbox.run_python
- 返回 stdout/stderr/exit_code
- 自动提取 candidate flag 写入 blackboard
"""
from __future__ import annotations

from typing import Any, Dict

from app.tools.base import BaseTool
from app.core.tool_protocol import ToolSpec
from app.config import settings


class RunPythonTool(BaseTool):
    name = "run_python"
    description = "执行 Python 代码。代码写入 workspace 后运行。自动提取 flag 候选。"
    category = "execution"
    input_schema = {
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Python 代码（必须完整可运行）"},
            "filename": {"type": "string", "description": "脚本文件名", "default": "solve.py"},
            "timeout": {"type": "integer", "description": "超时秒数", "default": 15},
        },
        "required": ["code"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "exit_code": {"type": "integer"},
            "stdout": {"type": "string"},
            "stderr": {"type": "string"},
            "duration_ms": {"type": "integer"},
        },
    }
    permissions = ["local_execute"]
    risk_level = "medium"
    timeout_seconds = 60

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        from app.core.code_execution_sandbox import get_sandbox, SandboxResult
        from app.core.flag_verifier import FlagVerifier
        code = context.get("code", "")
        if not code:
            return {"success": False, "summary": "empty code", "details": {"error": "empty_code"}, "evidence": []}
        workspace = context.get("workspace", ".")
        filename = context.get("filename", "solve.py")
        timeout = int(context.get("timeout", settings.CTF_SANDBOX_TIMEOUT))
        allow_network = context.get("allow_network", False) and context.get("authorized", False)
        try:
            sandbox = get_sandbox(allow_network=allow_network) if allow_network else get_sandbox(allow_network=False)
            script_path = sandbox.write_script(workspace, filename, code)
            res: SandboxResult = sandbox.run_python(script_path, workdir=workspace, timeout=timeout)
            verifier = FlagVerifier()
            flags_in_output = verifier.extract_from_text(res.stdout, source="stdout")
            candidate_flags = [fc.to_dict() for fc in flags_in_output] if flags_in_output else []
            return {
                "success": res.success,
                "summary": f"exit_code={res.exit_code} duration={res.duration_ms}ms",
                "details": {
                    "exit_code": res.exit_code,
                    "stdout": res.stdout[:5000],
                    "stderr": res.stderr[:2000],
                    "duration_ms": res.duration_ms,
                    "timed_out": res.timed_out,
                    "candidate_flags": candidate_flags,
                },
                "evidence": [fc.to_dict() for fc in flags_in_output] if flags_in_output else [],
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
