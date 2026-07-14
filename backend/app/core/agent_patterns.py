"""Small executable coordination pattern for one Challenge.

This is intentionally finite: each role must produce an action, evidence, or
an explicit blocked result. It is not an unrestricted swarm.
"""
from __future__ import annotations
import time
import uuid
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from app.core.competition_runtime import ActionCandidate, TaskState, ActionScorer, CompetitionProfile, ToolBroker, Hypothesis

class AgentBid(BaseModel):
    bid_id: str = Field(default_factory=lambda: f"bid_{uuid.uuid4().hex[:10]}"); agent_id: str; action_id: str; capability_match: float = 0; estimated_success_probability: float = 0; expected_information_gain: float = 0; estimated_cost: float = 0; estimated_time: float = 1; current_load: float = 0; bid_score: float = 0
class HandoffRecord(BaseModel):
    handoff_id: str = Field(default_factory=lambda: f"handoff_{uuid.uuid4().hex[:10]}"); challenge_id: str; from_agent: str; to_agent: str; reason: str; hypothesis_ids: List[str] = []; evidence_ids: List[str] = []; artifact_ids: List[str] = []; remaining_budget: Dict[str, Any] = {}; created_at: float = Field(default_factory=time.time)

class ExplorerAgent:
    agent_id = "explorer"
    def propose(self, state: TaskState) -> List[ActionCandidate]:
        return [ActionCandidate(tool_name="list_dir", purpose="inventory workspace", expected_observation="entries", estimated_information_gain=.7), ActionCandidate(tool_name="read_file", tool_arguments={"file": "README"}, purpose="inspect task clue", expected_observation="clue text", estimated_information_gain=.5)]
class ExploiterAgent:
    agent_id = "exploiter"
    def eligible(self, state: TaskState) -> bool: return bool(state.evidence and state.hypotheses)
class VerifierAgent:
    agent_id = "verifier"
    def context(self, state: TaskState) -> Dict[str, Any]: return {"objective": state.objective, "evidence": [e.model_dump() for e in state.evidence], "candidates": [c.model_dump() for c in state.candidates]}
class CoordinatorAgent:
    agent_id = "coordinator"
    def auction(self, state: TaskState, actions: List[ActionCandidate]) -> ActionCandidate:
        scorer = ActionScorer(); scored = [(scorer.score(a), a) for a in actions]; return max(scored, key=lambda pair: pair[0])[1]
    def handoff(self, state: TaskState, source: str, target: str, reason: str) -> HandoffRecord:
        return HandoffRecord(challenge_id=state.challenge_id, from_agent=source, to_agent=target, reason=reason, hypothesis_ids=[h.hypothesis_id for h in state.hypotheses], evidence_ids=[e.evidence_id for e in state.evidence], remaining_budget=state.budgets)


class AutonomousRunReport(BaseModel):
    task_id: str
    status: str
    rounds: int = 0
    executed_action_ids: List[str] = Field(default_factory=list)
    handoffs: List[HandoffRecord] = Field(default_factory=list)
    stop_reason: str = ""


class AutonomousTaskRunner:
    """Bounded autonomous loop over the same Broker used by all agents.

    It intentionally has no direct shell/tool path.  This is a small local
    execution runtime, not a scheduler or an unconstrained multi-agent swarm.
    """
    def __init__(self, broker: Optional[ToolBroker] = None, *, max_rounds: int = 4, stagnation_limit: int = 2):
        self.broker = broker or ToolBroker(); self.max_rounds = max_rounds; self.stagnation_limit = stagnation_limit
        self.coordinator = CoordinatorAgent(); self.explorer = ExplorerAgent(); self.exploiter = ExploiterAgent(); self.verifier = VerifierAgent()

    def run(self, state: TaskState, profile: CompetitionProfile) -> AutonomousRunReport:
        report = AutonomousRunReport(task_id=state.task_id, status="running")
        state.status = "running"
        if not state.hypotheses:
            state.hypotheses.append(Hypothesis(category=state.category, title="Establish observable challenge facts", description="Start with a brokered workspace inventory."))
        stale = 0
        for index in range(self.max_rounds):
            before = len(state.evidence)
            proposals = self.explorer.propose(state)
            if self.exploiter.eligible(state):
                # The handoff is explicit even when the exploiter has no safe
                # category-specific action yet; it makes blocked state visible.
                report.handoffs.append(self.coordinator.handoff(state, self.explorer.agent_id, self.exploiter.agent_id, "grounded evidence is available"))
            action = self.coordinator.auction(state, proposals)
            result = self.broker.execute(state, action, profile, specialist="general")
            state.decision_history.append(action)
            report.executed_action_ids.append(action.action_id)
            report.rounds = index + 1
            if result.success:
                state.current_phase = "evidence_collection"
            stale = stale + 1 if len(state.evidence) == before else 0
            if stale >= self.stagnation_limit:
                report.status = state.status = "blocked"; report.stop_reason = "stagnation: no new accepted evidence"; return report
            if state.final_result and state.final_result.verification_status == "verified":
                report.status = state.status = "completed"; report.stop_reason = "independent verifier accepted candidate"; return report
        report.status = state.status = "paused"; report.stop_reason = "bounded autonomous round budget exhausted"; return report
