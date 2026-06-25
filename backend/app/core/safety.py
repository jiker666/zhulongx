"""
Safety filter for LLM-generated plans.
Blocks dangerous actions before execution.
"""
from typing import Any, Dict, List

DANGEROUS_KEYWORDS = [
    "爆破", "暴力破解", "getshell", "反弹shell", "反弹 shell", "木马", "后门",
    "持久化", "提权", "窃取", "删除数据", "破坏", "勒索", "内网横向",
    "payload", "exploit", "reverse shell", "bruteforce", "password spraying",
    "credential stuffing", "rce", "命令执行", "代码注入", "sql注入攻击",
    "webshell", "bind shell", "privilege escalation",
]


def check_plan_safety(
    plan_steps: List[Dict[str, Any]],
    registered_tool_names: List[str],
) -> Dict[str, Any]:
    """
    Check if an LLM-generated plan is safe to execute.
    Returns {"safe": bool, "reason": str, "fallback_required": bool}
    """
    dangerous_found = []

    for step in plan_steps:
        action = (step.get("action") or "").lower()
        reason = (step.get("reason") or "").lower()
        tool_name = step.get("tool_name") or step.get("tool") or ""
        text_to_check = action + " " + reason

        for kw in DANGEROUS_KEYWORDS:
            if kw.lower() in text_to_check:
                dangerous_found.append(f"危险关键词 '{kw}' 出现在步骤 '{step.get('action', '')}'")

        # Check tool is registered
        if tool_name and tool_name != "Reporter" and tool_name not in registered_tool_names:
            dangerous_found.append(f"工具 '{tool_name}' 未在 ToolRegistry 中注册")

    if dangerous_found:
        return {
            "safe": False,
            "reason": "；".join(dangerous_found),
            "fallback_required": True,
        }

    return {
        "safe": True,
        "reason": "",
        "fallback_required": False,
    }
