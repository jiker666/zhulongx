from __future__ import annotations

from dataclasses import dataclass, replace

from app.agent_engine.contracts.plan import Plan
from app.agent_engine.orchestration.stuck_detector import StuckReport


@dataclass(frozen=True)
class ReplanDecision:
    action: str
    reason: str
    requires_human: bool = False
    model_profile: str = ""


class Replanner:
    STAGES = (
        "local_retry",
        "switch_tool",
        "switch_hypothesis",
        "review_refute",
        "rebuild_local_plan",
        "escalate_model",
        "human_handoff",
    )

    def decide(self, report: StuckReport, *, previous_attempts: int, budget_ratio: float) -> ReplanDecision:
        if not report.stuck:
            return ReplanDecision("continue", "new evidence is still arriving")
        preferred = self.STAGES.index(report.recommended_stage) if report.recommended_stage in self.STAGES else 0
        index = min(max(preferred, previous_attempts), len(self.STAGES) - 1)
        if budget_ratio >= 0.9:
            index = max(index, self.STAGES.index("human_handoff"))
        action = self.STAGES[index]
        return ReplanDecision(
            action,
            f"stuck signals: {', '.join(report.signals)}",
            requires_human=action == "human_handoff",
            model_profile="expert" if action == "escalate_model" else "",
        )

    def revise(self, plan: Plan, decision: ReplanDecision) -> Plan:
        if decision.action in {"continue", "local_retry"}:
            return plan
        alternatives = tuple(dict.fromkeys(plan.alternatives + (decision.action,)))
        return replace(
            plan,
            version=plan.version + 1,
            alternatives=alternatives,
            revision_reason=decision.reason,
        )
