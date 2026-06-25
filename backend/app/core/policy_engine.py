"""
Execution policy for authorized, read-only security tasks.
"""
from typing import Any, Dict


DENY_KEYWORDS = [
    "爆破", "暴力破解", "getshell", "反弹 shell", "反弹shell", "持久化", "窃取",
    "删除", "破坏", "破坏数据", "横向移动", "漏洞利用", "真实漏洞利用", "注入",
    "payload", "exploit", "reverse shell",
    "bruteforce", "credential stuffing", "webshell",
]

ALLOWED_PERMISSIONS = {"local_file_read", "network_read", "read_only_analysis", "local_read"}


class PolicyEngine:
    def evaluate(self, plan_step: Any, tool: Any, context: Dict[str, Any]) -> Dict[str, Any]:
        text = f"{getattr(plan_step, 'action', '')} {getattr(plan_step, 'reason', '')}".lower()
        for keyword in DENY_KEYWORDS:
            if keyword.lower() in text:
                return {
                    "decision": "deny",
                    "reason": f"命中禁止动作关键词: {keyword}",
                    "safety_check": "denied",
                }

        risk_level = (getattr(plan_step, "risk_level", "") or getattr(tool, "risk_level", "low") or "low").lower()
        permissions = set(getattr(tool, "permissions", []) or [])
        unknown_permissions = permissions - ALLOWED_PERMISSIONS
        if unknown_permissions:
            return {
                "decision": "deny",
                "reason": f"工具请求未授权权限: {', '.join(sorted(unknown_permissions))}",
                "safety_check": "denied",
            }

        if getattr(plan_step, "requires_confirmation", False) or risk_level in {"medium", "high"}:
            return {
                "decision": "require_confirmation",
                "reason": f"步骤风险等级为 {risk_level} 或显式要求人工确认",
                "safety_check": "requires_confirmation",
            }

        return {
            "decision": "allow",
            "reason": "只读低风险动作，安全策略允许执行",
            "safety_check": "passed",
        }
