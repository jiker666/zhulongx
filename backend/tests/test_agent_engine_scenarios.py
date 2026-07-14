from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.state import SessionState
from app.agent_engine.validation.base import CandidateSubmission
from app.agent_engine.validation.structured import StructuredOutputValidator
from app.scenarios import default_scenarios


def test_five_general_security_scenarios_are_registered():
    registry = default_scenarios()
    assert registry.names() == (
        "ctf",
        "incident_response",
        "pentest",
        "reverse_forensics",
        "vuln_analysis",
    )
    for name in registry.names():
        scenario = registry.get(name)
        assert scenario.recommended_skills()
        assert scenario.completion_schema()["required"]
        assert scenario.validator() is not None


def test_structured_validator_can_require_hidden_authoritative_evaluator(tmp_path):
    store = AppendOnlyEventStore()
    state = SessionState(run_id="run_structured", objective="validate finding")
    evidence = store.append("run_structured", EventType.TOOL_FINISHED, actor="tool", payload={"success": True})
    validator = StructuredOutputValidator(
        required_fields=("finding", "evidence"),
        result_type="finding",
        evaluator=lambda document: document["finding"] == "confirmed",
    )

    rejected = validator.validate(
        CandidateSubmission('{"finding":"decoy","evidence":"tool"}', (evidence.event_id,)),
        state=state,
        events=store,
        workspace=tmp_path,
    )
    accepted = validator.validate(
        CandidateSubmission('{"finding":"confirmed","evidence":"tool"}', (evidence.event_id,)),
        state=state,
        events=store,
        workspace=tmp_path,
    )

    assert rejected.accepted is False
    assert rejected.level == "authoritative"
    assert accepted.accepted is True
    assert accepted.authoritative is True
