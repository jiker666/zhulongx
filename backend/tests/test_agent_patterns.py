from app.core.agent_patterns import AutonomousTaskRunner, CoordinatorAgent, ExplorerAgent, ExploiterAgent, VerifierAgent
from app.core.competition_runtime import CompetitionController, CompetitionProfile

def test_coordinator_auction_and_handoff():
    state = CompetitionController().create_challenge("comp", "challenge", "inspect")
    actions = ExplorerAgent().propose(state)
    selected = CoordinatorAgent().auction(state, actions)
    assert selected.action_id in {a.action_id for a in actions}
    record = CoordinatorAgent().handoff(state, "explorer", "exploiter", "evidence available")
    assert record.challenge_id == state.challenge_id

def test_exploiter_requires_evidence():
    state = CompetitionController().create_challenge("comp", "challenge", "inspect")
    assert not ExploiterAgent().eligible(state)
    assert VerifierAgent().context(state)["objective"] == "inspect"

def test_autonomous_runner_executes_only_through_broker(tmp_path):
    state = CompetitionController().create_challenge("comp", "local", "inventory local task")
    state.workspace = str(tmp_path)
    (tmp_path / "clue.txt").write_text("grounded", encoding="utf-8")
    report = AutonomousTaskRunner(max_rounds=3, stagnation_limit=2).run(state, CompetitionProfile())
    assert report.executed_action_ids
    assert state.evidence and state.evidence[0].tool_call_id
    assert report.status in {"paused", "blocked"}
