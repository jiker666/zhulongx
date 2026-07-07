"""
Observer — 旁路监督（v6 借鉴 BreachWeave）。

职责：
- 不直接执行工具，不直接生成攻击 payload
- 只观察最近 evidence、blackboard、intent 状态
- 输出 ObserverAdvice：是否陷入循环、是否需要压缩、是否升级 expert、是否人工接管

规则优先，不要每次都调 LLM：
- 同一脚本 hash 连续运行 2 次且 stderr 类似 → loop
- 同一错误类型重复 2 次 → need reflect
- 有高置信候选 flag 但未进入 verify → should_replan
- rounds 接近上限且无新 fact → should_stop / HUMAN_REQUIRED
- 最近 3 步无新增 fact → drift

只有规则判断不清楚时，才通过 cheap 模型生成简短建议。
"""
from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from app.core.blackboard import Blackboard, get_blackboard

logger = logging.getLogger(__name__)


@dataclass
class ObserverAdvice:
    """旁路 Observer 给出的建议。"""
    should_replan: bool = False
    should_escalate_model: bool = False
    should_stop: bool = False
    loop_detected: bool = False
    drift_detected: bool = False
    advice: str = ""
    confidence: float = 0.5
    # v8: 新增建议类型
    should_switch_hypothesis: bool = False
    should_expand_context: bool = False
    should_run_tool_check: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "should_replan": self.should_replan,
            "should_escalate_model": self.should_escalate_model,
            "should_stop": self.should_stop,
            "loop_detected": self.loop_detected,
            "drift_detected": self.drift_detected,
            "advice": self.advice,
            "confidence": self.confidence,
        }


def _script_hash(script: str) -> str:
    if not script:
        return ""
    return hashlib.sha256(script.encode("utf-8", "ignore")).hexdigest()[:12]


def _stderr_signature(stderr: str) -> str:
    """提取 stderr 的错误特征（保留异常类型 + 第一行）。"""
    if not stderr:
        return ""
    lines = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    if not lines:
        return ""
    # 找第一个含 Error/Exception 的行
    for ln in lines:
        if "Error" in ln or "Exception" in ln:
            return ln[:80]
    return lines[-1][:80]


class Observer:
    """旁路监督器（规则优先）。"""

    def __init__(self, blackboard: Optional[Blackboard] = None) -> None:
        self.bb = blackboard or get_blackboard()
        # 每个 task 的最近脚本 hash 历史
        self._script_history: Dict[str, List[str]] = {}
        # 每个 task 的最近 stderr signature 历史
        self._stderr_history: Dict[str, List[str]] = {}
        # 每个 task 的最近 fact 数量快照（用于 drift 判定）
        self._last_fact_count: Dict[str, int] = {}
        # 每个 task 的连续 drift 次数
        self._drift_streak: Dict[str, int] = {}

    def observe(
        self,
        *,
        task_id: str,
        rounds_used: int,
        max_rounds: int,
        script_runs: List[Dict[str, Any]],
        current_script: str = "",
        candidate_flags: Optional[List[Dict[str, Any]]] = None,
        state: str = "",
    ) -> ObserverAdvice:
        """观察最近执行，给出建议。不修改任何状态。"""
        candidate_flags = candidate_flags or []

        # 1. loop 检测：同一脚本 hash 连续运行 2 次且 stderr 类似
        loop_detected = self._detect_loop(task_id, current_script, script_runs)

        # 2. drift 检测：连续 2 次观察无新增 fact（非首次）
        drift_detected = self._detect_drift(task_id)

        # 3. should_replan：有高置信候选 flag 但未进入 verify
        has_high_conf_candidate = any(
            (c.get("confidence") or 0) >= 0.7 for c in candidate_flags
        )
        should_replan = (
            has_high_conf_candidate
            and state not in ("VERIFY_FLAG", "GENERATE_WRITEUP", "DONE")
        )

        # 4. repeated error → escalate
        repeated_error = self._detect_repeated_error(task_id, script_runs)
        should_escalate = loop_detected or repeated_error

        # 5. should_stop：仅当接近轮次上限 AND 无候选 flag AND 无新事实（真耗尽）
        near_cap = rounds_used >= max_rounds - 1
        no_candidates = not candidate_flags
        should_stop = near_cap and no_candidates and (drift_detected or loop_detected)

        advice_text = self._build_advice(
            loop_detected, drift_detected, should_replan, should_escalate, should_stop,
            has_high_conf_candidate, rounds_used, max_rounds,
        )

        return ObserverAdvice(
            should_replan=should_replan,
            should_escalate_model=should_escalate,
            should_stop=should_stop,
            loop_detected=loop_detected,
            drift_detected=drift_detected,
            advice=advice_text,
            confidence=0.7 if (loop_detected or repeated_error) else 0.5,
        )

    # ---------- internal rule helpers ----------

    def _detect_loop(
        self, task_id: str, current_script: str, script_runs: List[Dict[str, Any]]
    ) -> bool:
        """同一脚本 hash 连续运行 2 次且 stderr 类似。"""
        if not current_script or len(script_runs) < 1:
            # 记录当前 hash
            h = _script_hash(current_script)
            self._script_history.setdefault(task_id, []).append(h)
            return False

        h = _script_hash(current_script)
        history = self._script_history.setdefault(task_id, [])
        history.append(h)
        # 看最近 2 次 hash
        if len(history) >= 2 and history[-1] == history[-2] and history[-1]:
            # stderr 也类似？
            if len(script_runs) >= 2:
                sigs = [_stderr_signature(r.get("stderr", "")) for r in script_runs[-2:]]
                if sigs[0] and sigs[0] == sigs[1]:
                    return True
        return False

    def _detect_drift(self, task_id: str) -> bool:
        """连续 2 次观察无新增 fact（非首次）。"""
        current = self.bb.fact_count(task_id)
        prev = self._last_fact_count.get(task_id)  # None = 首次
        drift_count = self._drift_streak.get(task_id, 0)
        # 只有有事实基线时才算 drift
        if prev is None:
            new_streak = 0
        elif current > 0 and current == prev:
            new_streak = drift_count + 1
        else:
            new_streak = 0
        self._drift_streak[task_id] = new_streak
        self._last_fact_count[task_id] = current
        # 连续 2 次无新增才报 drift
        return new_streak >= 2

    def _detect_repeated_error(self, task_id: str, script_runs: List[Dict[str, Any]]) -> bool:
        """同一错误类型重复 2 次。"""
        if len(script_runs) < 2:
            return False
        recent = script_runs[-2:]
        sigs = [_stderr_signature(r.get("stderr", "")) for r in recent]
        return bool(sigs[0] and sigs[0] == sigs[1])

    @staticmethod
    def _build_advice(
        loop: bool, drift: bool, replan: bool,
        escalate: bool, stop: bool, high_conf: bool,
        rounds: int, max_rounds: int,
    ) -> str:
        parts: List[str] = []
        if stop:
            parts.append(f"已达 {rounds}/{max_rounds} 轮且无候选 flag，建议人工接管")
        if loop:
            parts.append("检测到脚本循环，建议升级 expert 模型或重规划")
        if drift:
            parts.append("最近无新事实，建议切换解题方向")
        if replan:
            parts.append("已有高置信候选 flag，建议立即进入 VERIFY_FLAG")
        if escalate and not stop:
            parts.append("建议升级到 expert 模型 (GLM-5.2)")
        if not parts:
            parts.append("状态正常，继续推进")
        return "；".join(parts)

    # ---------- bookkeeping ----------

    def reset(self, task_id: str) -> None:
        """清空某 task 的 observer 状态。"""
        self._script_history.pop(task_id, None)
        self._stderr_history.pop(task_id, None)
        self._last_fact_count.pop(task_id, None)
        self._drift_streak.pop(task_id, None)


# 全局单例
_observer: Optional[Observer] = None


def get_observer() -> Observer:
    global _observer
    if _observer is None:
        _observer = Observer()
    return _observer
