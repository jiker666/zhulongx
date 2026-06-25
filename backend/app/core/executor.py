"""
Executor - executes the plan step by step, records logs, updates task state.
Round 2: persists plan_source/risk_level/confidence/requires_confirmation per step.
          broadcasts via ws_manager (async-to-sync bridge via asyncio).
"""
import asyncio
import datetime
import json
import logging
import time
from typing import Any, Dict, List

from sqlalchemy.orm import Session

from app.core.memory import Memory
from app.core.judge import Judge
from app.core.planner import PlanStep
from app.core.policy_engine import PolicyEngine
from app.core.decision_trace import build_decision_trace
from app.core.intent_analyzer import looks_like_uploaded_path
from app.core.tool_registry import tool_registry
from app.models.step import Step
from app.models.task import Task

logger = logging.getLogger(__name__)


def _broadcast_sync(task_id: int, message: dict) -> None:
    """Fire-and-forget WS broadcast from a sync thread."""
    try:
        from app.core.ws_manager import ws_manager
        loop = asyncio.new_event_loop()
        loop.run_until_complete(ws_manager.broadcast(task_id, message))
        loop.close()
    except Exception as e:
        logger.debug(f"WS broadcast skipped: {e}")


class Executor:
    def __init__(self, db: Session):
        self.db = db
        self.judge = Judge()
        self.policy = PolicyEngine()

    def _build_context(self, task: Task, memory: Memory, plan_step: PlanStep) -> Dict[str, Any]:
        ctx = memory.get_context()
        file_path = task.uploaded_file or ""
        target = task.target or ""
        if not file_path and looks_like_uploaded_path(target):
            file_path = target
            target = ""
        ctx["task_id"] = task.id
        ctx["task_title"] = task.title
        ctx["task_type"] = task.task_type
        ctx["task_description"] = task.description
        ctx["target"] = target
        ctx["uploaded_file"] = file_path
        ctx["file_path"] = file_path
        return ctx

    def _save_step(
        self,
        task_id: int,
        step_index: int,
        plan_step: PlanStep,
        input_summary: str,
        output_summary: str,
        next_decision: str,
        status: str,
        judge_result: Dict[str, Any] = None,
        decision_trace: Dict[str, Any] = None,
    ) -> Step:
        judge_result = judge_result or {}
        decision_trace = decision_trace or {}
        step = Step(
            task_id=task_id,
            step_index=step_index,
            phase=plan_step.phase,
            action=plan_step.action,
            reason=plan_step.reason,
            tool_name=plan_step.tool,
            input_summary=input_summary,
            output_summary=output_summary,
            next_decision=next_decision,
            status=status,
            created_at=datetime.datetime.utcnow(),
            # Round 2 fields
            plan_source=plan_step.plan_source,
            risk_level=judge_result.get("risk_level", plan_step.risk_level),
            confidence=judge_result.get("confidence", plan_step.confidence),
            requires_confirmation=plan_step.requires_confirmation,
            decision_trace=json.dumps(decision_trace, ensure_ascii=False),
        )
        self.db.add(step)
        self.db.commit()
        self.db.refresh(step)
        return step

    def _update_task_status(self, task: Task, status: str) -> None:
        task.status = status
        task.updated_at = datetime.datetime.utcnow()
        self.db.commit()

    def _record_from_step(
        self,
        task_id: int,
        idx: int,
        plan_step: PlanStep,
        input_summary: str,
        output_summary: str,
        next_decision: str,
        status: str,
        judge_result: Dict[str, Any],
        decision_trace: Dict[str, Any],
        result: Dict[str, Any] = None,
    ) -> Dict[str, Any]:
        result = result or {}
        return {
            "step_index": idx,
            "phase": plan_step.phase,
            "action": plan_step.action,
            "reason": plan_step.reason,
            "tool_name": plan_step.tool,
            "input_summary": input_summary[:500],
            "output_summary": output_summary[:1000],
            "next_decision": next_decision[:500],
            "status": status,
            "plan_source": plan_step.plan_source,
            "risk_level": judge_result.get("risk_level", plan_step.risk_level),
            "confidence": judge_result.get("confidence", plan_step.confidence),
            "requires_confirmation": plan_step.requires_confirmation,
            "tool_details": result.get("details", {}),
            "tool_evidence": result.get("evidence", []),
            "decision_trace": decision_trace,
        }

    def _dynamic_steps_from_judge(self, judge_result: Dict[str, Any], tool_names: List[str]) -> List[PlanStep]:
        if not judge_result.get("should_replan"):
            return []
        dynamic_steps: List[PlanStep] = []
        for raw in judge_result.get("suggested_next_steps", [])[:3]:
            if not isinstance(raw, dict):
                continue
            tool_name = raw.get("tool_name") or raw.get("tool")
            if not tool_name or tool_name not in tool_names or not tool_registry.get(tool_name):
                continue
            dynamic_steps.append(PlanStep(
                action=raw.get("action", f"动态执行 {tool_name}"),
                tool=tool_name,
                reason=raw.get("reason", "根据上一工具输出动态插入的安全只读步骤"),
                phase=raw.get("phase", "execution"),
                plan_source=raw.get("plan_source", "dynamic_rule"),
                confidence=float(raw.get("confidence", judge_result.get("confidence", 0.7))),
                risk_level=raw.get("risk_level", "low"),
                requires_confirmation=bool(raw.get("requires_confirmation", False)),
                expected_input=raw.get("expected_input", "上一工具输出和任务上下文"),
                expected_output=raw.get("expected_output", "结构化分析结果"),
                preconditions=raw.get("preconditions", ["工具已启用", "安全策略允许"]),
                fallback_strategy=raw.get("fallback_strategy", "动态步骤失败时记录原因并继续报告"),
            ))
        return dynamic_steps

    def execute(self, task: Task, plan: List[PlanStep]) -> List[Dict[str, Any]]:
        from app.config import settings as app_settings

        memory = Memory(task.id)
        initial_file_path = task.uploaded_file or (task.target if looks_like_uploaded_path(task.target or "") else "")
        memory.set("target", "" if initial_file_path == (task.target or "") else (task.target or ""))
        memory.set("file_path", initial_file_path)

        step_records: List[Dict[str, Any]] = []
        self._update_task_status(task, "running")

        # Update task with plan metadata
        plan_source = plan[0].plan_source if plan else "rule"
        task.plan_source = plan_source
        task.llm_enabled = app_settings.LLM_ENABLED
        task.llm_model = app_settings.LLM_MODEL if app_settings.LLM_ENABLED else ""
        self.db.commit()

        # Broadcast task started
        _broadcast_sync(task.id, {"type": "task_status", "task_id": task.id, "data": {"status": "running"}})

        idx = 0
        tool_names = tool_registry.all_names()
        while idx < len(plan):
            self.db.refresh(task)
            if task.status == "cancelled":
                _broadcast_sync(task.id, {"type": "task_status", "task_id": task.id, "data": {"status": "cancelled"}})
                return step_records
            while task.status == "paused":
                _broadcast_sync(task.id, {"type": "task_status", "task_id": task.id, "data": {"status": "paused"}})
                time.sleep(0.5)
                self.db.refresh(task)
                if task.status == "cancelled":
                    _broadcast_sync(task.id, {"type": "task_status", "task_id": task.id, "data": {"status": "cancelled"}})
                    return step_records
            plan_step = plan[idx]
            idx += 1
            if plan_step.tool == "Reporter":
                continue

            tool = tool_registry.get(plan_step.tool)
            if not tool:
                next_decision = f"工具 {plan_step.tool} 未注册，跳过此步骤"
                trace = {
                    "observation": f"工具 {plan_step.tool} 未注册或已禁用",
                    "evidence": [],
                    "hypothesis": next_decision,
                    "selected_action": "skip",
                    "rejected_actions": ["execute_unregistered_tool"],
                    "safety_check": {"decision": "deny", "reason": "工具不可用"},
                    "confidence": plan_step.confidence,
                    "reproducibility": {"tool_name": plan_step.tool, "input_summary": "", "timestamp": datetime.datetime.utcnow().isoformat() + "Z"},
                }
                self._save_step(
                    task_id=task.id,
                    step_index=idx,
                    plan_step=plan_step,
                    input_summary="",
                    output_summary=f"工具 {plan_step.tool} 未找到",
                    next_decision=next_decision,
                    status="skipped",
                    decision_trace=trace,
                )
                record = self._record_from_step(task.id, idx, plan_step, "", f"工具 {plan_step.tool} 未找到", next_decision, "skipped", {}, trace)
                step_records.append(record)
                _broadcast_sync(task.id, {"type": "step_created", "task_id": task.id, "data": record})
                continue

            ctx = self._build_context(task, memory, plan_step)
            input_summary = f"target={ctx.get('target', '')} | file={ctx.get('file_path', '')}"

            policy_result = self.policy.evaluate(plan_step, tool, ctx)
            if policy_result["decision"] == "deny":
                result = {"success": False, "summary": policy_result["reason"], "details": policy_result, "evidence": []}
                judge_result = self.judge.evaluate(plan_step.action, result, memory.summarize())
                trace = build_decision_trace(
                    plan_step=plan_step,
                    tool_name=plan_step.tool,
                    input_summary=input_summary,
                    tool_result=result,
                    judge_result=judge_result,
                    policy_result=policy_result,
                    selected_action="skip_denied_step",
                    rejected_actions=["execute_denied_step"],
                )
                self._save_step(task.id, idx, plan_step, input_summary[:500], policy_result["reason"], judge_result.get("next_decision", "安全策略拒绝"), "skipped", judge_result, trace)
                record = self._record_from_step(task.id, idx, plan_step, input_summary, policy_result["reason"], judge_result.get("next_decision", "安全策略拒绝"), "skipped", judge_result, trace, result)
                step_records.append(record)
                _broadcast_sync(task.id, {"type": "step_created", "task_id": task.id, "data": record})
                continue

            if policy_result["decision"] == "require_confirmation":
                self._update_task_status(task, "waiting_confirmation")
                result = {"success": False, "summary": policy_result["reason"], "details": policy_result, "evidence": []}
                judge_result = {"source": "policy", "risk_level": plan_step.risk_level, "summary": policy_result["reason"], "next_decision": "等待人工确认", "confidence": plan_step.confidence}
                trace = build_decision_trace(
                    plan_step=plan_step,
                    tool_name=plan_step.tool,
                    input_summary=input_summary,
                    tool_result=result,
                    judge_result=judge_result,
                    policy_result=policy_result,
                    selected_action="wait_for_confirmation",
                    rejected_actions=["execute_without_confirmation"],
                )
                self._save_step(task.id, idx, plan_step, input_summary[:500], policy_result["reason"], "等待人工确认", "waiting_confirmation", judge_result, trace)
                record = self._record_from_step(task.id, idx, plan_step, input_summary, policy_result["reason"], "等待人工确认", "waiting_confirmation", judge_result, trace, result)
                step_records.append(record)
                _broadcast_sync(task.id, {"type": "step_created", "task_id": task.id, "data": record})
                _broadcast_sync(task.id, {"type": "task_status", "task_id": task.id, "data": {"status": "waiting_confirmation"}})
                return step_records

            result = tool.safe_run(ctx)
            memory.add_step_result(idx, plan_step.tool, result)

            output_summary = result.get("summary", "")
            status = "success" if result.get("success", False) else "failed"

            # Judge evaluation (returns dict in Round 2)
            judge_result = self.judge.evaluate(plan_step.action, result, memory.summarize())
            if isinstance(judge_result, str):
                # Backward compat
                judge_result = {"source": "rule", "risk_level": "low", "summary": output_summary,
                                "next_decision": judge_result, "confidence": 1.0}
            next_decision = judge_result.get("next_decision", "继续执行")
            dynamic_steps = self._dynamic_steps_from_judge(judge_result, tool_names)
            if dynamic_steps:
                plan[idx:idx] = dynamic_steps

            trace = build_decision_trace(
                plan_step=plan_step,
                tool_name=plan_step.tool,
                input_summary=input_summary,
                tool_result=result,
                judge_result=judge_result,
                policy_result=policy_result,
                selected_action="insert_dynamic_steps" if dynamic_steps else "continue_plan",
                rejected_actions=[] if dynamic_steps else ["dynamic_replan_not_required"],
            )

            self._save_step(
                task_id=task.id,
                step_index=idx,
                plan_step=plan_step,
                input_summary=input_summary[:500],
                output_summary=output_summary[:1000],
                next_decision=next_decision[:500],
                status=status,
                judge_result=judge_result,
                decision_trace=trace,
            )
            record = self._record_from_step(task.id, idx, plan_step, input_summary, output_summary, next_decision, status, judge_result, trace, result)
            step_records.append(record)
            _broadcast_sync(task.id, {"type": "step_created", "task_id": task.id, "data": record})

        return step_records

    def save_report_step(self, task: Task, step_index: int, plan_step: PlanStep, file_path: str) -> Dict[str, Any]:
        judge_result = {
            "source": plan_step.plan_source,
            "risk_level": "low",
            "summary": "报告已保存",
            "observations": [f"报告文件: {file_path}"],
            "evidence": [file_path],
            "next_decision": "任务完成",
            "should_continue": False,
            "should_replan": False,
            "suggested_next_steps": [],
            "confidence": 1.0,
        }
        result = {"success": True, "summary": "Markdown/HTML 安全报告已保存", "details": {"file_path": file_path}, "evidence": [file_path]}
        policy_result = {"decision": "allow", "reason": "报告保存为本地任务产物", "safety_check": "passed"}
        trace = build_decision_trace(
            plan_step=plan_step,
            tool_name="Reporter",
            input_summary="所有步骤执行结果",
            tool_result=result,
            judge_result=judge_result,
            policy_result=policy_result,
            selected_action="complete_task",
            rejected_actions=[],
        )
        self._save_step(task.id, step_index, plan_step, "所有步骤执行结果", result["summary"], "任务完成", "success", judge_result, trace)
        record = self._record_from_step(task.id, step_index, plan_step, "所有步骤执行结果", result["summary"], "任务完成", "success", judge_result, trace, result)
        _broadcast_sync(task.id, {"type": "step_created", "task_id": task.id, "data": record})
        return record
