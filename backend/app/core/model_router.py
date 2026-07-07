"""
Model Router — 模型路由器（v6 成本控制核心）。

职责：
- 根据任务状态选择 STATIC_ONLY / CHEAP / EXPERT / FALLBACK / STOP
- 读取环境变量中的 cheap / expert / fallback 配置
- 统一返回 RouteDecision

分级规则：
- STATIC_ONLY：静态分析已找到 flag，不调用 LLM
- CHEAP：分类、计划、普通脚本生成、短错误修复
- EXPERT：满足以下任一条件才调用：
  - rounds_used >= 3 且无候选 flag
  - 同一错误类型重复 2 次
  - 附件分析摘要超过阈值，需要长上下文综合
  - Observer 判断陷入循环
  - 用户手动指定 use_expert=true
- STOP：超过任务预算，转入 HUMAN_REQUIRED

无 key 时不报错，返回 mock / cheap 兼容。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.config import settings
from app.core.cost_accounting import get_cost_accounting


@dataclass
class RouteDecision:
    """路由决策结果。"""
    lane: str  # static_only | cheap | expert | fallback | stop
    provider: str
    model: str
    reason: str
    max_tokens: int
    temperature: float
    budget_remaining: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "lane": self.lane,
            "provider": self.provider,
            "model": self.model,
            "reason": self.reason,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "budget_remaining": round(self.budget_remaining, 6),
        }


# 各 lane 默认 max_tokens（按规格第 3.3 节）
STEP_TOKEN_BUDGET = {
    "classify": 800,
    "plan": 1200,
    "agent_think": 4096,
    "generate_script": 2048,
    "reflect_error": 1200,
    "generate_writeup": 2000,
    "verify_flag": 400,
    "analyze_files": 800,
    "reason": 800,
    "observer": 400,
    "default": 2048,
}


def _has_real_key(key: str) -> bool:
    return bool(key and key != "replace_me")


def _cheap_available() -> bool:
    """cheap lane 是否有真实 key（否则降级到 mock）。"""
    if not settings.LLM_ROUTER_ENABLED:
        return False
    return _has_real_key(settings.LLM_CHEAP_API_KEY) or settings.LLM_ENABLED


def _expert_available() -> bool:
    if not settings.LLM_ROUTER_ENABLED:
        return False
    return _has_real_key(settings.LLM_EXPERT_API_KEY)


def _fallback_available() -> bool:
    if not settings.LLM_ROUTER_ENABLED:
        return False
    return _has_real_key(settings.LLM_FALLBACK_API_KEY)


class ModelRouter:
    """根据任务状态决定走哪条 lane。"""

    def __init__(self) -> None:
        self.router_enabled = settings.LLM_ROUTER_ENABLED
        self.budget_per_task = settings.LLM_BUDGET_PER_TASK_USD
        self.compress_threshold = settings.LLM_COMPRESS_THRESHOLD_CHARS

    # ---------- public API ----------

    def decide(
        self,
        *,
        task_id: str,
        step: str,
        rounds_used: int = 0,
        max_rounds: int = 8,
        candidate_flags: Optional[List[Dict[str, Any]]] = None,
        static_solved: bool = False,
        repeated_error_count: int = 0,
        analysis_summary_chars: int = 0,
        observer_loop_detected: bool = False,
        force_expert: bool = False,
        allow_network: bool = False,
    ) -> RouteDecision:
        """决定本轮 step 走哪条 lane。"""
        candidate_flags = candidate_flags or []
        budget_remaining = self._budget_remaining(task_id)

        # 1. 静态命中：不调用 LLM
        if static_solved:
            return RouteDecision(
                lane="static_only",
                provider="static",
                model="static",
                reason="static_analysis_found_flag",
                max_tokens=0,
                temperature=0.0,
                budget_remaining=budget_remaining,
            )

        # 2. 超预算：停止
        acc = get_cost_accounting()
        if acc.is_budget_exceeded(task_id):
            return RouteDecision(
                lane="stop",
                provider="static",
                model="static",
                reason="task_budget_exceeded",
                max_tokens=0,
                temperature=0.0,
                budget_remaining=max(0.0, budget_remaining),
            )
        if acc.is_daily_budget_exceeded():
            return RouteDecision(
                lane="stop",
                provider="static",
                model="static",
                reason="daily_budget_exceeded",
                max_tokens=0,
                temperature=0.0,
                budget_remaining=max(0.0, budget_remaining),
            )

        # 3. EXPERT 升级条件
        escalate_reason = self._should_escalate_expert(
            rounds_used=rounds_used,
            max_rounds=max_rounds,
            candidate_flags=candidate_flags,
            repeated_error_count=repeated_error_count,
            analysis_summary_chars=analysis_summary_chars,
            observer_loop_detected=observer_loop_detected,
            force_expert=force_expert,
        )

        if escalate_reason and _expert_available():
            return RouteDecision(
                lane="expert",
                provider=settings.LLM_EXPERT_PROVIDER,
                model=settings.LLM_EXPERT_MODEL,
                reason=escalate_reason,
                max_tokens=settings.LLM_EXPERT_MAX_TOKENS,
                temperature=settings.LLM_EXPERT_TEMPERATURE,
                budget_remaining=budget_remaining,
            )

        # 3b. EXPERT 升级但无 key → 尝试 fallback
        if escalate_reason and not _expert_available() and _fallback_available():
            return RouteDecision(
                lane="fallback",
                provider=settings.LLM_FALLBACK_PROVIDER,
                model=settings.LLM_FALLBACK_MODEL,
                reason=f"expert_unavailable_fallback:{escalate_reason}",
                max_tokens=1800,
                temperature=0.2,
                budget_remaining=budget_remaining,
            )

        # 4. CHEAP lane（默认）
        if _cheap_available():
            max_tok = STEP_TOKEN_BUDGET.get(step, STEP_TOKEN_BUDGET["default"])
            return RouteDecision(
                lane="cheap",
                provider=settings.LLM_CHEAP_PROVIDER,
                model=settings.LLM_CHEAP_MODEL,
                reason="cheap_default",
                max_tokens=max_tok,
                temperature=settings.LLM_CHEAP_TEMPERATURE,
                budget_remaining=budget_remaining,
            )

        # 5. 无任何真实 key → 走 mock（用主 LLM_ADAPTER 的 mock）
        max_tok = STEP_TOKEN_BUDGET.get(step, STEP_TOKEN_BUDGET["default"])
        return RouteDecision(
            lane="cheap",
            provider="mock",
            model=settings.LLM_MODEL or "mock",
            reason="no_real_key_mock_mode",
            max_tokens=max_tok,
            temperature=0.2,
            budget_remaining=budget_remaining,
        )

    # ---------- helpers ----------

    def _budget_remaining(self, task_id: str) -> float:
        summary = get_cost_accounting().get_task_summary(task_id)
        return max(0.0, self.budget_per_task - summary.total_cost_usd)

    @staticmethod
    def _should_escalate_expert(
        *,
        rounds_used: int,
        max_rounds: int,
        candidate_flags: List[Dict[str, Any]],
        repeated_error_count: int,
        analysis_summary_chars: int,
        observer_loop_detected: bool,
        force_expert: bool,
    ) -> str:
        """返回升级原因（空字符串 = 不升级）。"""
        if force_expert:
            return "user_force_expert"
        # v8: hard mode 下困难题型直接 expert
        if settings.CTF_HARD_MODE:
            # hard mode: 有错误就升级，不等 3 轮
            if repeated_error_count >= 1:
                return "hard_mode_repeated_error"
            if rounds_used >= 2 and not candidate_flags:
                return "hard_mode_rounds_no_candidate"
        # 连续失败 3 轮且无候选 flag
        if rounds_used >= 3 and not candidate_flags:
            return "rounds_no_candidate"
        # 同一错误重复 2 次
        if repeated_error_count >= 2:
            return "repeated_error"
        # 附件分析摘要超阈值
        if analysis_summary_chars > 8000:
            return "long_context"
        # Observer 判断循环
        if observer_loop_detected:
            return "observer_loop"
        return ""

    def status(self) -> Dict[str, Any]:
        """供 /api/llm/router/status 接口使用（脱敏）。"""
        def _host(url: str) -> str:
            if not url:
                return ""
            return url.split("//")[-1].split("/")[0]
        return {
            "router_enabled": self.router_enabled,
            "budget_per_task_usd": self.budget_per_task,
            "budget_daily_usd": settings.LLM_BUDGET_DAILY_USD,
            "compress_threshold_chars": self.compress_threshold,
            "cheap": {
                "provider": settings.LLM_CHEAP_PROVIDER,
                "model": settings.LLM_CHEAP_MODEL,
                "base_url_host": _host(settings.LLM_CHEAP_BASE_URL),
                "api_key_configured": _has_real_key(settings.LLM_CHEAP_API_KEY),
                "max_tokens": settings.LLM_CHEAP_MAX_TOKENS,
            },
            "expert": {
                "provider": settings.LLM_EXPERT_PROVIDER,
                "model": settings.LLM_EXPERT_MODEL,
                "base_url_host": _host(settings.LLM_EXPERT_BASE_URL),
                "api_key_configured": _has_real_key(settings.LLM_EXPERT_API_KEY),
                "max_tokens": settings.LLM_EXPERT_MAX_TOKENS,
            },
            "fallback": {
                "provider": settings.LLM_FALLBACK_PROVIDER,
                "model": settings.LLM_FALLBACK_MODEL,
                "base_url_host": _host(settings.LLM_FALLBACK_BASE_URL),
                "api_key_configured": _has_real_key(settings.LLM_FALLBACK_API_KEY),
            },
            "daily_total_cost_usd": get_cost_accounting().get_daily_total_cost(),
        }


# 全局单例
_router: Optional[ModelRouter] = None


def get_model_router() -> ModelRouter:
    global _router
    if _router is None:
        _router = ModelRouter()
    return _router
