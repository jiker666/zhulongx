from typing import Any, Dict

from app.tools.base import BaseTool


class ManualActionStep(BaseTool):
    name = "ManualActionStep"
    description = "记录需要队员执行或确认的人工动作，不自动访问目标"
    category = "general"
    input_schema = {"type": "object", "properties": {"instruction": {"type": "string"}}}
    output_schema = {"type": "object", "properties": {"requires_human": {"type": "boolean"}}}
    permissions = ["human_review"]
    risk_level = "medium"
    timeout_seconds = 1
    tags = ["human", "final_ops", "confirmation"]

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        instruction = context.get("instruction") or context.get("reason") or "请队员进行人工验证并回填结果"
        return {
            "success": False,
            "summary": instruction,
            "details": {"requires_human": True, "instruction": instruction},
            "evidence": ["等待人工动作回填"],
        }
