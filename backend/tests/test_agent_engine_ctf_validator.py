from pathlib import Path

from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.state import SessionState
from app.agent_engine.validation.base import CandidateSubmission
from app.agent_engine.validation.ctf import CTFValidator


def _state_and_evidence():
    events = AppendOnlyEventStore()
    state = SessionState(run_id="run_validator", objective="validate a CTF answer")
    evidence = events.append(
        state.run_id,
        EventType.TOOL_FINISHED,
        actor="tool_executor",
        payload={"tool_call_id": "call_1", "name": "read_file", "success": True},
    )
    return state, events, evidence


def test_ctf_validator_rejects_decoy_with_authoritative_evaluator(tmp_path):
    state, events, evidence = _state_and_evidence()
    validator = CTFValidator(
        flag_pattern=r"flag\{[^}]+\}",
        evaluator=lambda value: value == "flag{real}",
    )

    result = validator.validate(
        CandidateSubmission("flag{decoy}", (evidence.event_id,)),
        state=state,
        events=events,
        workspace=tmp_path,
    )

    assert result.accepted is False
    assert result.level == "authoritative"


def test_ctf_validator_cannot_accept_without_evaluator(tmp_path):
    state, events, evidence = _state_and_evidence()
    validator = CTFValidator(flag_pattern=r"flag\{[^}]+\}")

    result = validator.validate(
        CandidateSubmission("flag{looks_valid}", (evidence.event_id,)),
        state=state,
        events=events,
        workspace=tmp_path,
    )

    assert result.accepted is False
    assert result.level == "authoritative"


def test_ctf_validator_requires_successful_evidence(tmp_path):
    state = SessionState(run_id="run_missing_evidence", objective="validate")
    events = AppendOnlyEventStore()
    validator = CTFValidator(flag_pattern=r"flag\{[^}]+\}", evaluator=lambda value: True)

    result = validator.validate(
        CandidateSubmission("flag{candidate}", ("evt_missing",)),
        state=state,
        events=events,
        workspace=tmp_path,
    )

    assert result.accepted is False
    assert result.level == "evidence_binding"


def test_ctf_validator_runs_reproducer_before_evaluator(tmp_path):
    state, events, evidence = _state_and_evidence()
    calls = []
    validator = CTFValidator(
        flag_pattern=r"flag\{[^}]+\}",
        reproducer=lambda candidate, workspace: calls.append((candidate.value, workspace)) or True,
        evaluator=lambda value: value == "flag{real}",
    )

    result = validator.validate(
        CandidateSubmission("flag{real}", (evidence.event_id,), "python reproduce.py"),
        state=state,
        events=events,
        workspace=tmp_path,
    )

    assert result.accepted is True
    assert result.authoritative is True
    assert calls == [("flag{real}", tmp_path)]
