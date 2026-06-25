"""
Judge - LLM + rule dual-mode evaluation of tool results.
"""
import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)

JUDGE_SYSTEM_PROMPT = """你是授权网络安全任务评估 Agent（CyberPilot）。
你的任务是：根据安全工具的执行结果，判断风险等级，并给出下一步决策建议。
如果这是 CTF / FinalOps solve 场景，你不能根据题名、公开 writeup、历史记忆、相似题库直接给答案；只能基于当前 challenge 输入、附件内容、工具输出、人工回填和当前 Evidence 推理。
每个答案候选必须绑定 evidence_id；缺少 evidence_id 时置信度最高不得超过 0.3；如果模型想起公开题答案，必须标记 disallowed_memory_guess，不能作为候选。
输出必须是 JSON，格式如下：
{
  "source": "llm",
  "risk_level": "low|medium|high",
  "summary": "<对本步骤结果的简短总结>",
  "observations": ["<关键观察>"],
  "evidence": ["<证据>"],
  "next_decision": "<下一步应该做什么>",
  "should_continue": true,
  "should_replan": false,
  "suggested_next_steps": [],
  "confidence": 0.0-1.0,
  "evidence_ids": [],
  "reasoning_basis": "<current_input|tool_output|manual_result|evidence>",
  "disallowed_sources_checked": true,
  "memory_guess_detected": false,
  "confidence_cap_reason": ""
}
不允许输出攻击性建议。"""


class Judge:
    """Dual-mode: LLM (when enabled) + rule-based fallback."""

    def _with_defaults(self, result: Dict[str, Any], tool_result: Dict[str, Any]) -> Dict[str, Any]:
        summary = result.get("summary") or tool_result.get("summary", "")
        evidence = result.get("evidence") or tool_result.get("evidence", [])
        observations = result.get("observations") or ([summary] if summary else [])
        result.setdefault("source", "rule")
        result.setdefault("risk_level", "low")
        result["summary"] = summary
        result["observations"] = observations
        result["evidence"] = evidence
        result.setdefault("next_decision", "步骤执行完成，继续执行后续步骤")
        result.setdefault("should_continue", bool(tool_result.get("success", False)))
        result.setdefault("should_replan", False)
        result.setdefault("suggested_next_steps", [])
        result.setdefault("confidence", 1.0)
        return result

    def _rule_evaluate(self, step_action: str, tool_result: Dict[str, Any], memory_summary: str) -> Dict[str, Any]:
        success = tool_result.get("success", False)
        summary = tool_result.get("summary", "")

        if not success:
            return {
                "source": "rule",
                "risk_level": "low",
                "summary": f"工具执行失败：{summary}",
                "next_decision": f"工具执行失败（{summary}），跳过后续依赖步骤，继续执行下一步骤",
                "confidence": 1.0,
            }

        action_lower = step_action.lower()
        details = tool_result.get("details", {})
        evidence = tool_result.get("evidence", [])

        if "文件解析" in action_lower or "file" in action_lower:
            project_type = details.get("project_type", "")
            if project_type == "java_project":
                decision = "识别为 Java 项目，继续进行 Controller 识别和越权风险扫描"
            elif project_type == "log_files":
                decision = "识别为日志文件，继续进行日志解析和异常分析"
            elif project_type == "frontend_project":
                decision = "识别为前端项目，继续进行 JS 接口提取"
            else:
                decision = "继续执行后续分析步骤"
            return {"source": "rule", "risk_level": "low", "summary": summary, "next_decision": decision, "confidence": 1.0}

        if "http" in action_lower or "指纹" in action_lower:
            status = details.get("status_code", 0)
            if status == 200:
                decision = "站点可访问，继续进行路径探测"
            elif status in (301, 302):
                decision = "站点存在跳转，注意跟踪重定向目标，继续路径探测"
            else:
                decision = "站点响应异常，继续执行后续步骤"
            return {"source": "rule", "risk_level": "low", "summary": summary, "next_decision": decision, "confidence": 1.0}

        if "路径" in action_lower or "probe" in action_lower:
            decision = f"发现 {len(evidence)} 个可访问路径，继续分析 JS 接口信息" if evidence else "未发现明显可访问敏感路径，继续执行后续步骤"
            return {"source": "rule", "risk_level": "low", "summary": summary, "next_decision": decision, "confidence": 1.0}

        if "越权" in action_lower or "audit" in action_lower or "controller" in action_lower or "参数" in action_lower:
            high_risk = details.get("high_risk_count", 0)
            if high_risk > 0:
                return {"source": "rule", "risk_level": "high", "summary": summary,
                        "next_decision": f"发现 {high_risk} 个高风险越权疑似点，重点标注并继续生成报告", "confidence": 0.9}
            medium_risk = details.get("medium_risk_count", 0)
            if medium_risk > 0:
                return {"source": "rule", "risk_level": "medium", "summary": summary,
                        "next_decision": f"发现 {medium_risk} 个中风险越权疑似点，继续生成报告", "confidence": 0.85}
            return {"source": "rule", "risk_level": "low", "summary": summary,
                    "next_decision": "未发现明显越权风险，继续生成报告", "confidence": 0.9}

        if "日志" in action_lower or "log" in action_lower or "ip" in action_lower or "path" in action_lower:
            suspicious = details.get("suspicious_count", 0)
            if suspicious > 0:
                return {"source": "rule", "risk_level": "medium", "summary": summary,
                        "next_decision": f"发现 {suspicious} 个可疑路径访问，需重点关注", "confidence": 0.9}
            return {"source": "rule", "risk_level": "low", "summary": summary,
                    "next_decision": "日志分析完成，继续执行后续步骤", "confidence": 1.0}

        return {"source": "rule", "risk_level": "low", "summary": summary,
                "next_decision": "步骤执行完成，继续执行后续步骤", "confidence": 1.0}

    def evaluate(
        self,
        step_action: str,
        tool_result: Dict[str, Any],
        memory_summary: str,
    ) -> Dict[str, Any]:
        """
        Returns structured dict with source/risk_level/summary/next_decision/confidence.
        For backward compat, also returns str via evaluate_str().
        """
        from app.core.llm_client import llm_client

        if llm_client.enabled:
            try:
                result_summary = tool_result.get("summary", "")
                evidence_str = "\n".join(tool_result.get("evidence", [])[:5])
                user_msg = (
                    f"步骤动作: {step_action}\n"
                    f"工具执行结果: {result_summary}\n"
                    f"关键证据:\n{evidence_str or '(无)'}\n"
                    f"历史摘要:\n{memory_summary[:500] or '(无)'}\n\n"
                    "请评估本步骤结果，判断风险等级，给出下一步建议（JSON格式）。"
                )
                llm_result = llm_client.chat(
                    messages=[
                        {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                        {"role": "user", "content": user_msg},
                    ],
                    max_tokens=512,
                )
                if llm_result["success"]:
                    parsed = llm_client.extract_json(llm_result["content"])
                    if parsed and "next_decision" in parsed:
                        parsed["source"] = "llm"
                        parsed.setdefault("risk_level", "low")
                        parsed.setdefault("confidence", 0.8)
                        parsed.setdefault("summary", tool_result.get("summary", ""))
                        return self._with_defaults(parsed, tool_result)
            except Exception as e:
                logger.warning(f"LLM judge failed: {e}")

        # Rule fallback
        return self._with_defaults(self._rule_evaluate(step_action, tool_result, memory_summary), tool_result)

    def evaluate_str(self, step_action: str, tool_result: Dict[str, Any], memory_summary: str) -> str:
        """Backward-compatible string return."""
        result = self.evaluate(step_action, tool_result, memory_summary)
        return result.get("next_decision", "步骤执行完成")
