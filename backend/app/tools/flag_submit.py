"""
SubmitFlagTool — 提交候选 flag。

- 使用 FlagVerifier 验证格式
- 写入 candidate_flags
- 验证成功进入 DONE
- 验证失败回到 agent loop，不直接结束
"""
from __future__ import annotations

import re
from typing import Any, Dict

from app.tools.base import BaseTool
from app.core.tool_protocol import ToolSpec


class SubmitFlagTool(BaseTool):
    name = "submit_flag"
    description = "提交候选 flag。必须提供 flag 值、置信度和证据。格式验证失败不结束任务，回到 agent loop。"
    category = "ctf"
    input_schema = {
        "type": "object",
        "properties": {
            "flag": {"type": "string", "description": "候选 flag 值"},
            "confidence": {"type": "number", "description": "置信度 (0-1)", "default": 0.5},
            "evidence": {"type": "array", "items": {"type": "string"}, "description": "支持此 flag 的证据列表"},
        },
        "required": ["flag"],
    }
    output_schema = {
        "type": "object",
        "properties": {
            "accepted": {"type": "boolean"},
            "reason": {"type": "string"},
        },
    }
    permissions = ["submit_flag"]
    risk_level = "low"
    timeout_seconds = 5

    FLAG_PATTERN = re.compile(
        r"flag\{[^}]+\}|FLAG\{[^}]+\}|ctf\{[^}]+\}|CTF\{[^}]+\}|sctf\{[^}]+\}|key\{[^}]+\}",
        re.IGNORECASE,
    )

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        flag = context.get("flag", "")
        if not flag:
            return {"success": False, "summary": "no flag specified", "details": {"error": "no_flag"}, "evidence": []}
        confidence = float(context.get("confidence", 0.5))
        evidence_list = context.get("evidence", [])
        flag_format = context.get("flag_format", None)
        is_valid = bool(self.FLAG_PATTERN.search(flag))
        format_reason = ""
        if flag_format:
            try:
                if not re.search(flag_format, flag):
                    format_reason = f"flag '{flag}' 不符合格式 {flag_format}"
                    is_valid = False
                else:
                    is_valid = True
            except re.error:
                pass
        if is_valid:
            return {
                "success": True,
                "summary": f"flag 已接受: {flag} (confidence={confidence:.2f})",
                "details": {"accepted": True, "flag": flag, "confidence": confidence, "evidence": evidence_list, "valid_format": True},
                "evidence": [{"flag": flag, "confidence": confidence}],
            }
        else:
            reason = format_reason or f"flag '{flag}' 不符合常见 flag 格式"
            return {
                "success": False,
                "summary": reason,
                "details": {"accepted": False, "flag": flag, "confidence": confidence, "reason": reason, "valid_format": is_valid},
                "evidence": [],
            }

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )
