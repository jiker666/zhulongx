"""
Decision trace helpers for auditable execution.
"""
import datetime
import hashlib
import json
from typing import Any, Dict, List


def _json_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def build_decision_trace(
    *,
    plan_step: Any,
    tool_name: str,
    input_summary: str,
    tool_result: Dict[str, Any],
    judge_result: Dict[str, Any],
    policy_result: Dict[str, Any],
    selected_action: str,
    rejected_actions: List[str],
) -> Dict[str, Any]:
    return {
        "observation": judge_result.get("summary") or tool_result.get("summary", ""),
        "evidence": tool_result.get("evidence", [])[:20],
        "hypothesis": judge_result.get("next_decision", ""),
        "selected_action": selected_action,
        "rejected_actions": rejected_actions,
        "safety_check": policy_result,
        "confidence": judge_result.get("confidence", getattr(plan_step, "confidence", 1.0)),
        "reproducibility": {
            "tool_name": tool_name,
            "input_summary": input_summary,
            "config": {
                "risk_level": getattr(plan_step, "risk_level", "low"),
                "requires_confirmation": getattr(plan_step, "requires_confirmation", False),
                "plan_source": getattr(plan_step, "plan_source", "rule"),
            },
            "timestamp": datetime.datetime.utcnow().isoformat() + "Z",
            "result_hash": _json_hash(tool_result),
        },
    }
