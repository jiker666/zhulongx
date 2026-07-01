"""
Cost Accounting — LLM 调用成本核算（v6）。

职责：
- 估算 tokens 和费用
- 记录每个 task 的模型调用成本
- 提供 /api/ctf/tasks/{task_id}/cost 需要的数据
- 短期 prompt hash 缓存（避免重复问）

价格表保守估计，允许通过环境变量覆盖。
不追求绝对精确，答辩展示"成本可观测 + 可控"即可。
"""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)


# 内置保守价格（USD per 1M tokens，输入/输出分开）
# 参考 DeepSeek / GLM / Qwen 公开定价，向上取整避免低估
DEFAULT_PRICING: Dict[str, Dict[str, float]] = {
    # cheap lane
    "deepseek-v4-flash": {"input": 0.14, "output": 0.28},
    "deepseek-chat": {"input": 0.14, "output": 0.28},
    "deepseek-coder": {"input": 0.14, "output": 0.28},
    # expert lane
    "glm-5.2": {"input": 0.50, "output": 1.50},
    "glm-4.6": {"input": 0.50, "output": 1.50},
    "glm-4-plus": {"input": 0.50, "output": 1.50},
    # fallback lane
    "qwen-coder-plus": {"input": 0.35, "output": 1.05},
    "qwen2.5-coder": {"input": 0.35, "output": 1.05},
    # openai 兼容兜底
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "mock": {"input": 0.0, "output": 0.0},
}

# 字符 -> token 的粗略估算（中文 1 字符 ≈ 1 token，英文 4 字符 ≈ 1 token，取保守 3.5）
CHARS_PER_TOKEN = 3.5


def _estimate_tokens(text: str) -> int:
    """粗略估算 token 数。"""
    if not text:
        return 0
    return max(1, int(len(text) / CHARS_PER_TOKEN))


def _price_for(model: str) -> Dict[str, float]:
    """获取模型价格，未知模型用 mock 兜底（0 成本）。"""
    if not model:
        return DEFAULT_PRICING["mock"]
    return DEFAULT_PRICING.get(
        model.lower(),
        DEFAULT_PRICING.get(model, DEFAULT_PRICING["mock"]),
    )


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """估算单次调用 USD 成本。"""
    p = _price_for(model)
    return round(
        (input_tokens * p["input"] + output_tokens * p["output"]) / 1_000_000,
        6,
    )


@dataclass
class LlmUsageRecord:
    """单次 LLM 调用记录。"""
    task_id: str
    step: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: float
    success: bool
    route_reason: str
    created_at: float
    prompt_hash: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "step": self.step,
            "provider": self.provider,
            "model": self.model,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "estimated_cost_usd": self.estimated_cost_usd,
            "success": self.success,
            "route_reason": self.route_reason,
            "created_at": self.created_at,
            "prompt_hash": self.prompt_hash,
        }


@dataclass
class TaskCostSummary:
    """单个 task 的成本汇总。"""
    task_id: str
    total_calls: int = 0
    successful_calls: int = 0
    failed_calls: int = 0
    cheap_calls: int = 0
    expert_calls: int = 0
    fallback_calls: int = 0
    static_only_calls: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cost_usd: float = 0.0
    budget_per_task_usd: float = 0.0
    budget_exceeded: bool = False
    cache_hits: int = 0
    by_step: Dict[str, int] = field(default_factory=dict)
    by_model: Dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "total_calls": self.total_calls,
            "successful_calls": self.successful_calls,
            "failed_calls": self.failed_calls,
            "cheap_calls": self.cheap_calls,
            "expert_calls": self.expert_calls,
            "fallback_calls": self.fallback_calls,
            "static_only_calls": self.static_only_calls,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "total_cost_usd": round(self.total_cost_usd, 6),
            "budget_per_task_usd": self.budget_per_task_usd,
            "budget_exceeded": self.budget_exceeded,
            "cache_hits": self.cache_hits,
            "by_step": self.by_step,
            "by_model": self.by_model,
        }


def _prompt_hash(messages: List[Dict[str, str]], step: str) -> str:
    """对 prompt 做短期缓存 key（sha256 前 16 字符）。"""
    raw = step + "\n" + "\n".join(
        f"{m.get('role','')}:{m.get('content','')}" for m in messages
    )
    return hashlib.sha256(raw.encode("utf-8", errors="ignore")).hexdigest()[:16]


class CostAccounting:
    """LLM 成本核算中心（线程安全，内存为主，可选 DB 持久化）。"""

    def __init__(self, *, budget_per_task_usd: Optional[float] = None) -> None:
        self._lock = threading.Lock()
        self._records: Dict[str, List[LlmUsageRecord]] = {}  # task_id -> records
        self._cache: Dict[str, LlmUsageRecord] = {}  # prompt_hash -> record (short-term)
        self._cache_order: List[str] = []
        self._cache_max = 200
        self._daily_total_cost: float = 0.0
        self._daily_reset_day: int = time.gmtime().tm_yday
        self.budget_per_task_usd = (
            budget_per_task_usd
            if budget_per_task_usd is not None
            else settings.LLM_BUDGET_PER_TASK_USD
        )

    # ---------- recording ----------

    def record(
        self,
        *,
        task_id: str,
        step: str,
        provider: str,
        model: str,
        input_text: str = "",
        output_text: str = "",
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        success: bool = True,
        route_reason: str = "",
        messages: Optional[List[Dict[str, str]]] = None,
        use_cache: bool = True,
    ) -> LlmUsageRecord:
        """记录一次 LLM 调用。返回 LlmUsageRecord。

        如果启用 cache 且 prompt_hash 命中，直接返回缓存记录（不计新成本）。
        """
        # 日预算日切换重置
        self._maybe_reset_daily()

        p_hash = _prompt_hash(messages or [{"role": "user", "content": input_text}], step) if messages or input_text else ""

        if use_cache and p_hash and success:
            with self._lock:
                cached = self._cache.get(p_hash)
                if cached:
                    # 命中缓存：复制一份，标记 cache hit
                    rec = LlmUsageRecord(
                        task_id=task_id,
                        step=step,
                        provider=cached.provider,
                        model=cached.model,
                        input_tokens=cached.input_tokens,
                        output_tokens=cached.output_tokens,
                        estimated_cost_usd=0.0,  # 缓存命中不计费
                        success=True,
                        route_reason="cache_hit",
                        created_at=time.time(),
                        prompt_hash=p_hash,
                    )
                    self._records.setdefault(task_id, []).append(rec)
                    return rec

        it = input_tokens if input_tokens is not None else _estimate_tokens(input_text)
        ot = output_tokens if output_tokens is not None else _estimate_tokens(output_text)
        cost = estimate_cost(model, it, ot)

        rec = LlmUsageRecord(
            task_id=task_id,
            step=step,
            provider=provider,
            model=model,
            input_tokens=it,
            output_tokens=ot,
            estimated_cost_usd=cost,
            success=success,
            route_reason=route_reason,
            created_at=time.time(),
            prompt_hash=p_hash,
        )

        with self._lock:
            self._records.setdefault(task_id, []).append(rec)
            if p_hash and success:
                self._cache[p_hash] = rec
                self._cache_order.append(p_hash)
                if len(self._cache_order) > self._cache_max:
                    old = self._cache_order.pop(0)
                    self._cache.pop(old, None)
            self._daily_total_cost += cost
        return rec

    def record_static_only(self, *, task_id: str, step: str, reason: str = "static_solve") -> LlmUsageRecord:
        """静态分析命中，不调用 LLM，记录 0 成本调用。"""
        rec = LlmUsageRecord(
            task_id=task_id,
            step=step,
            provider="static",
            model="static",
            input_tokens=0,
            output_tokens=0,
            estimated_cost_usd=0.0,
            success=True,
            route_reason=reason,
            created_at=time.time(),
        )
        with self._lock:
            self._records.setdefault(task_id, []).append(rec)
        return rec

    # ---------- querying ----------

    def get_task_summary(self, task_id: str) -> TaskCostSummary:
        with self._lock:
            records = list(self._records.get(task_id, []))
        s = TaskCostSummary(task_id=task_id, budget_per_task_usd=self.budget_per_task_usd)
        for r in records:
            s.total_calls += 1
            s.total_input_tokens += r.input_tokens
            s.total_output_tokens += r.output_tokens
            s.total_cost_usd += r.estimated_cost_usd
            if r.success:
                s.successful_calls += 1
            else:
                s.failed_calls += 1
            # lane 判定
            reason = (r.route_reason or "").lower()
            if "static" in reason:
                s.static_only_calls += 1
            elif r.provider in ("glm", "openai") and "expert" in reason:
                s.expert_calls += 1
            elif "fallback" in reason:
                s.fallback_calls += 1
            elif reason == "cache_hit":
                s.cache_hits += 1
            else:
                s.cheap_calls += 1
            s.by_step[r.step] = s.by_step.get(r.step, 0) + 1
            s.by_model[r.model] = s.by_model.get(r.model, 0) + 1
        s.budget_exceeded = s.total_cost_usd > self.budget_per_task_usd
        return s

    def get_task_records(self, task_id: str) -> List[LlmUsageRecord]:
        with self._lock:
            return list(self._records.get(task_id, []))

    def get_daily_total_cost(self) -> float:
        self._maybe_reset_daily()
        with self._lock:
            return round(self._daily_total_cost, 6)

    def is_budget_exceeded(self, task_id: str) -> bool:
        return self.get_task_summary(task_id).budget_exceeded

    def is_daily_budget_exceeded(self) -> bool:
        return self.get_daily_total_cost() > settings.LLM_BUDGET_DAILY_USD

    def reset_task(self, task_id: str) -> None:
        with self._lock:
            self._records.pop(task_id, None)

    def reset_all(self) -> None:
        """测试用：清空所有记录。"""
        with self._lock:
            self._records.clear()
            self._cache.clear()
            self._cache_order.clear()
            self._daily_total_cost = 0.0
            self._daily_reset_day = time.gmtime().tm_yday

    # ---------- internal ----------

    def _maybe_reset_daily(self) -> None:
        today = time.gmtime().tm_yday
        if today != self._daily_reset_day:
            with self._lock:
                self._daily_total_cost = 0.0
                self._daily_reset_day = today


# 全局单例
_cost_accounting: Optional[CostAccounting] = None
_cost_lock = threading.Lock()


def get_cost_accounting() -> CostAccounting:
    global _cost_accounting
    if _cost_accounting is None:
        with _cost_lock:
            if _cost_accounting is None:
                _cost_accounting = CostAccounting()
    return _cost_accounting


def reset_cost_accounting_for_test() -> None:
    """测试用：重置全局单例。"""
    global _cost_accounting
    with _cost_lock:
        _cost_accounting = CostAccounting()
