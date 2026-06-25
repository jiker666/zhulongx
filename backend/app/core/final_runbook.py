"""
Rule-first final competition runbook planner.
"""
from __future__ import annotations

from typing import Any, Dict, List

from app.core.planner import PlanStep


class FinalRunbookPlanner:
    def build(
        self,
        challenge_type: str,
        description: str = "",
        target: str = "",
        artifact_triage_result: Dict[str, Any] | None = None,
        scope_status: Dict[str, Any] | None = None,
        time_budget_minutes: int = 20,
    ) -> Dict[str, Any]:
        ctype = (challenge_type or "unknown").lower()
        triage = artifact_triage_result or {}
        scoped = bool(scope_status or {})
        strategy_map = {
            "web": "先确认 scope，再做指纹、页面/JS/API 提取和少量固定路径观察，所有非 GET 动作等待人工确认。",
            "code": "先识别项目结构和入口路由，再查鉴权、资源 ID、危险函数和敏感配置，输出利用条件而不自动攻击。",
            "log": "先建立时间线和 Top 统计，再提取异常路径、状态码、IOC 和答案候选。",
            "pcap": "先识别协议和明文线索；tshark 可用时提取 DNS/HTTP 摘要，不可用时给出手工命令。",
            "reverse": "只读识别文件类型、hash、strings、导入和 flag-like 字符串，不执行二进制。",
            "crypto": "尝试常见编码链、字符频率和格式识别，输出候选与证据。",
            "misc": "从附件格式、编码、隐藏文本和题面关键词开始，快速形成候选答案。",
        }
        strategy = strategy_map.get(ctype, "先做附件和目标轻量分诊，再根据证据选择 web/code/log/pcap/reverse/misc 路线。")

        recommended_tools = triage.get("recommended_tools") or []
        first_3 = [
            "录入题面、目标和附件，确认是否命中比赛 scope",
            "运行 ArtifactTriageTool 提取文件结构、线索和答案候选",
            "按题型运行第一轮只读工具，并把证据入库",
        ]
        if ctype == "web":
            first_3 = ["确认目标在 scope 内", "运行 HttpFingerprintTool 和 JSInterfaceExtractorTool", "对固定安全路径做少量 DirectoryProbeTool"]
        elif ctype == "code":
            first_3 = ["运行 ArtifactTriageTool 识别项目类型", "运行对应代码审计工具", "人工复核鉴权/资源归属判断"]
        elif ctype == "log":
            first_3 = ["运行 LogAnalyzerTool 建立统计摘要", "提取 IOC 和异常路径", "将答案候选与证据绑定"]

        return {
            "strategy": strategy,
            "first_3_actions": first_3,
            "parallel_actions": [
                "队员 A：录入题目、运行 Agent、维护状态",
                "队员 B：人工浏览器验证、确认中风险请求",
                "队员 C：整理证据、复制 Brief、提交答案",
            ],
            "human_actions": [
                "确认目标、附件和比赛授权范围无误",
                "对 POST/PUT/PATCH/DELETE 或状态改变请求做人工确认",
                "把页面返回、截图、提交结果或人工判断回填到 Challenge",
            ],
            "agent_actions": [
                "执行只读分诊和 scope 检查",
                "生成下一步建议和 AnswerCandidate",
                "保存 EvidenceVault 证据并更新 Challenge 状态",
            ],
            "stop_conditions": [
                "目标不在 scope 内",
                "请求数或响应大小超过限制",
                "出现需要人工确认的中高风险动作",
                "候选答案已被人工标记 accepted",
            ],
            "expected_answer_forms": ["flag{...}", "ctf{...}", "key=value", "题目指定格式"],
            "fallback_plan": "LLM 或网关不可用时继续使用规则 runbook、ArtifactTriageTool、日志/代码/JS/HTTP 只读工具。",
            "time_budget_minutes": time_budget_minutes,
            "scope_checked": scoped,
            "recommended_tools": recommended_tools,
        }

    def to_plan_steps(self, runbook: Dict[str, Any], challenge_type: str) -> List[PlanStep]:
        tools = runbook.get("recommended_tools") or []
        steps: List[PlanStep] = [
            PlanStep("附件/题面分诊", "ArtifactTriageTool", "决赛题目先统一提取格式、线索、候选答案和推荐工具", "planning", "runbook"),
        ]
        for tool in tools[:4]:
            if tool == "ArtifactTriageTool":
                continue
            steps.append(PlanStep(f"运行 {tool}", tool, "根据 runbook 推荐执行的只读分析步骤", "execution", "runbook"))
        steps.append(PlanStep("人工复核与结果回填", "ManualActionStep", "需要队员验证候选或确认中风险动作", "execution", "runbook", risk_level="medium", requires_confirmation=True))
        return steps


final_runbook_planner = FinalRunbookPlanner()
