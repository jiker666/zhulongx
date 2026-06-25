"""
Planner - LLM + Rule dual-mode task planning.
LLM_ENABLED=false → rule mode
LLM_ENABLED=true  → try LLM first, fallback to rules on failure
"""
import json
import logging
from typing import Any, Dict, List, Optional

from app.core.intent_analyzer import TaskIntentAnalyzer

logger = logging.getLogger(__name__)


class PlanStep:
    def __init__(
        self,
        action: str,
        tool: str,
        reason: str,
        phase: str = "execution",
        plan_source: str = "rule",
        confidence: float = 1.0,
        risk_level: str = "low",
        requires_confirmation: bool = False,
        expected_input: str = "",
        expected_output: str = "",
        preconditions: Optional[List[str]] = None,
        fallback_strategy: str = "若本步骤失败，记录原因并继续执行可独立的后续只读分析步骤",
        intent: Optional[Dict[str, Any]] = None,
    ):
        self.action = action
        self.tool = tool
        self.reason = reason
        self.phase = phase
        self.plan_source = plan_source
        self.confidence = confidence
        self.risk_level = risk_level
        self.requires_confirmation = requires_confirmation
        self.expected_input = expected_input
        self.expected_output = expected_output
        self.preconditions = preconditions or []
        self.fallback_strategy = fallback_strategy
        self.intent = intent or {}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "action": self.action,
            "tool": self.tool,
            "reason": self.reason,
            "phase": self.phase,
            "plan_source": self.plan_source,
            "confidence": self.confidence,
            "risk_level": self.risk_level,
            "requires_confirmation": self.requires_confirmation,
            "expected_input": self.expected_input,
            "expected_output": self.expected_output,
            "preconditions": self.preconditions,
            "fallback_strategy": self.fallback_strategy,
            "tool_name": self.tool,
        }


TOOL_IO_HINTS = {
    "FileParserTool": ("uploaded_file/file_path", "文件类型、项目类型、关键文件和解析证据"),
    "HttpFingerprintTool": ("target URL", "HTTP 状态码、标题、Server、响应大小和重定向链"),
    "DirectoryProbeTool": ("target URL", "固定安全路径的状态码、响应大小和 content-type"),
    "JSInterfaceExtractorTool": ("target URL 或 JS/HTML 文件", "疑似 API 路径、来源页面和 JS 文件证据"),
    "JavaCodeAuditTool": ("Java 文件、源码目录或 ZIP", "接口、资源 ID 参数、鉴权证据和风险分级"),
    "LogAnalyzerTool": ("access.log/error.log/JSON line/Spring Boot 日志", "Top IP、Top Path、异常状态码、可疑路径和 UA"),
    "ArtifactTriageTool": ("uploaded_file + challenge_type", "附件类型、关键文件、指标、候选答案和推荐工具"),
    "HttpReplayTool": ("method/url/reason/challenge_id", "HTTP 响应摘要、证据 ID、答案候选和下一步建议"),
    "APIRunnerTool": ("OpenAPI/Postman/JS API 路径", "API map、GET 响应摘要、异常接口和候选答案"),
    "ManualActionStep": ("人工动作说明", "等待队员确认或回填结果"),
    "Reporter": ("全部步骤结果", "Markdown/HTML 安全分析报告"),
}


def _make_rule_steps(steps_def: List[tuple], source: str = "rule", intent: Optional[Dict[str, Any]] = None) -> List[PlanStep]:
    steps = []
    for action, tool, reason, phase in steps_def:
        expected_input, expected_output = TOOL_IO_HINTS.get(tool, ("任务上下文", "结构化工具输出"))
        steps.append(PlanStep(
            action=action,
            tool=tool,
            reason=reason,
            phase=phase,
            plan_source=source,
            confidence=float((intent or {}).get("confidence", 1.0)) if phase == "planning" else 1.0,
            risk_level="low",
            requires_confirmation=False,
            expected_input=expected_input,
            expected_output=expected_output,
            preconditions=[] if tool == "Reporter" else ["安全策略允许", "工具已启用"],
            intent=intent,
        ))
    return steps


WEB_SCAN_DEF = [
    ("任务理解", "FileParserTool", "分析任务目标，确认目标类型为 Web 扫描", "planning"),
    ("HTTP 指纹识别", "HttpFingerprintTool", "获取目标站点基础信息：状态码、Server、Content-Type 等", "execution"),
    ("安全路径探测", "DirectoryProbeTool", "探测目标站点少量固定安全路径，识别暴露端点", "execution"),
    ("JS 接口提取", "JSInterfaceExtractorTool", "若获取到 JS 文件，提取疑似 API 路径", "execution"),
    ("报告生成", "Reporter", "汇总分析结果，生成 Markdown 安全报告", "reporting"),
]

CODE_AUDIT_DEF = [
    ("文件解析", "FileParserTool", "解析上传文件，识别文件类型和项目结构", "planning"),
    ("Controller 识别", "JavaCodeAuditTool", "扫描 Java 文件，识别 Controller 层接口定义", "execution"),
    ("资源 ID 参数识别", "JavaCodeAuditTool", "识别接口中 userId、accountId、orderId 等高风险参数", "execution"),
    ("疑似越权风险判断", "JavaCodeAuditTool", "基于规则判断是否存在越权风险（缺少鉴权逻辑）", "execution"),
    ("报告生成", "Reporter", "汇总审计结果，生成 Markdown 代码审计报告", "reporting"),
]

LOG_ANALYSIS_DEF = [
    ("文件解析", "FileParserTool", "解析上传日志文件，确认日志格式", "planning"),
    ("日志解析", "LogAnalyzerTool", "解析日志条目，提取 IP、路径、状态码信息", "execution"),
    ("Top IP 统计", "LogAnalyzerTool", "统计访问频率最高的 IP 地址", "execution"),
    ("Top Path 统计", "LogAnalyzerTool", "统计访问频率最高的路径", "execution"),
    ("异常状态码识别", "LogAnalyzerTool", "识别 4xx/5xx 异常请求", "execution"),
    ("可疑路径识别", "LogAnalyzerTool", "识别对敏感路径的访问尝试", "execution"),
    ("报告生成", "Reporter", "汇总日志分析结果，生成应急分析报告", "reporting"),
]

REVERSE_HELPER_DEF = [
    ("文件解析", "FileParserTool", "识别二进制/源码文件类型和结构", "planning"),
    ("JS 接口提取", "JSInterfaceExtractorTool", "若为 JS 文件，提取 API 端点信息", "execution"),
    ("报告生成", "Reporter", "汇总分析结果，生成逆向辅助分析报告", "reporting"),
]

RULE_PLANS = {
    "web_scan": WEB_SCAN_DEF,
    "code_audit": CODE_AUDIT_DEF,
    "log_analysis": LOG_ANALYSIS_DEF,
    "reverse_helper": REVERSE_HELPER_DEF,
    "auto": WEB_SCAN_DEF,
}

LLM_SYSTEM_PROMPT = """你是授权网络安全任务规划 Agent（CyberPilot）。
你只能生成非破坏性、可审计、可解释的安全分析计划。
不得生成密码爆破、真实漏洞利用、破坏性攻击、持久化控制、数据窃取等步骤。
如果任务属于 CTF / FinalOps solve 场景，你不能根据题名、公开 writeup、历史记忆、相似题库直接给答案；只能基于当前 challenge 输入、附件内容、工具输出、人工回填和当前 Evidence 规划。
CTF 候选答案必须绑定 evidence_id；缺少 evidence_id 时置信度最高不得超过 0.3；如果“想起”公开题答案，必须标记为 disallowed_memory_guess，不能作为候选。
工具只能从下面系统已注册且启用的工具列表中选择：
{tool_list}

必须严格输出 JSON，不要输出自然语言。格式如下：
{
  "task_type": "<任务类型>",
  "plan_source": "llm",
  "summary": "<简短任务理解>",
  "steps": [
    {
      "phase": "planning|execution|reporting",
      "action": "<动作名称（中文）>",
      "tool_name": "<工具名>",
      "reason": "<为什么执行该步骤>",
      "expected_input": "<预期输入>",
      "expected_output": "<预期输出>",
      "preconditions": ["<前置条件>"],
      "risk_level": "low|medium|high",
      "confidence": 0.0-1.0,
      "requires_confirmation": false,
      "fallback_strategy": "<失败时的安全兜底策略>"
    }
  ]
}"""


class Planner:
    """
    Dual-mode planner: LLM (when enabled) + rule-based fallback.
    """

    def __init__(self):
        self.intent_analyzer = TaskIntentAnalyzer()

    def classify_task(self, task_type: str, description: str, target: str, uploaded_file: str = "") -> str:
        if task_type and task_type != "auto":
            return task_type
        intent = self.intent_analyzer.analyze(task_type, description, target, uploaded_file)
        if intent.get("recommended_scenario"):
            return intent["recommended_scenario"]
        desc_lower = (description or "").lower()
        if any(kw in desc_lower for kw in ["java", "代码", "越权", "controller", "audit", "审计"]):
            return "code_audit"
        if any(kw in desc_lower for kw in ["log", "日志", "access", "应急"]):
            return "log_analysis"
        if any(kw in desc_lower for kw in ["reverse", "逆向", "apk", "binary", "二进制"]):
            return "reverse_helper"
        if target and (target.startswith("http") or "." in target):
            return "web_scan"
        return "web_scan"

    def _rule_plan(
        self,
        task_type: str,
        description: str,
        target: str,
        uploaded_file: str = "",
        source: str = "rule",
    ) -> List[PlanStep]:
        intent = self.intent_analyzer.analyze(task_type, description, target, uploaded_file)
        effective_type = intent.get("recommended_scenario") or self.classify_task(task_type, description, target, uploaded_file)
        defs = RULE_PLANS.get(effective_type, WEB_SCAN_DEF)
        return _make_rule_steps(defs, source=source, intent=intent)

    def _llm_plan(
        self,
        task_type: str,
        description: str,
        target: str,
        uploaded_file: str,
        tool_names: List[str],
    ) -> Optional[List[PlanStep]]:
        """Try to generate plan via LLM. Returns None on failure."""
        from app.core.llm_client import llm_client
        from app.core.safety import check_plan_safety

        if not llm_client.enabled:
            return None

        tool_list = "\n".join(f"- {t}" for t in tool_names)
        system_prompt = LLM_SYSTEM_PROMPT.format(tool_list=tool_list)

        user_msg = (
            f"任务类型: {task_type}\n"
            f"任务描述: {description or '(无描述)'}\n"
            f"分析目标: {target or '(无 URL)'}\n"
            f"上传文件: {uploaded_file or '(无上传文件)'}\n\n"
            "请根据以上信息生成执行计划（JSON格式）。"
        )

        result = llm_client.chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ]
        )

        if not result["success"]:
            logger.warning(f"LLM plan request failed: {result['error']}")
            return None

        plan_dict = llm_client.extract_json(result["content"])
        if not plan_dict or "steps" not in plan_dict:
            logger.warning("LLM returned non-JSON or missing 'steps' field")
            return None

        steps_raw = plan_dict.get("steps", [])
        if not steps_raw:
            return None

        # Safety check
        safety = check_plan_safety(steps_raw, tool_names)
        if not safety["safe"]:
            logger.warning(f"LLM plan failed safety check: {safety['reason']}")
            return None

        # Convert to PlanStep
        plan_steps = []
        for s in steps_raw:
            plan_steps.append(PlanStep(
                action=s.get("action", "未知动作"),
                tool=s.get("tool_name", "FileParserTool"),
                reason=s.get("reason", ""),
                phase=s.get("phase", "execution"),
                plan_source="llm",
                confidence=float(s.get("confidence", 0.8)),
                risk_level=s.get("risk_level", "low"),
                requires_confirmation=bool(s.get("requires_confirmation", False)),
                expected_input=s.get("expected_input", s.get("input_summary", "")),
                expected_output=s.get("expected_output", ""),
                preconditions=s.get("preconditions", []),
                fallback_strategy=s.get("fallback_strategy", "失败时记录原因并继续安全步骤"),
            ))

        logger.info(f"LLM plan generated: {len(plan_steps)} steps")
        return plan_steps

    def generate_plan(
        self,
        task_type: str,
        description: str,
        target: str,
        uploaded_file: str = "",
        file_path: str = "",
        tool_names: Optional[List[str]] = None,
    ) -> List[PlanStep]:
        from app.core.llm_client import llm_client

        if tool_names is None:
            from app.core.tool_registry import tool_registry
            tool_names = tool_registry.all_names()

        # Try LLM mode
        if llm_client.enabled:
            llm_result = self._llm_plan(task_type, description, target, uploaded_file or file_path, tool_names)
            if llm_result:
                return self._filter_enabled_plan(llm_result, tool_names)
            # Fallback
            logger.info("LLM plan failed, falling back to rule mode")
            return self._filter_enabled_plan(
                self._rule_plan(task_type, description, target, uploaded_file or file_path, source="fallback"),
                tool_names,
            )

        # Rule mode
        return self._filter_enabled_plan(
            self._rule_plan(task_type, description, target, uploaded_file or file_path, source="rule"),
            tool_names,
        )

    def analyze_intent(self, task_type: str, description: str, target: str, uploaded_file: str = "") -> Dict[str, Any]:
        return self.intent_analyzer.analyze(task_type, description, target, uploaded_file)

    def _filter_enabled_plan(self, plan: List[PlanStep], enabled_tool_names: List[str]) -> List[PlanStep]:
        allowed = set(enabled_tool_names) | {"Reporter"}
        return [step for step in plan if step.tool in allowed]
