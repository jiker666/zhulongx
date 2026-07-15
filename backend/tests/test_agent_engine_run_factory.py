from app.agent_engine.events import EventType
from app.agent_engine.managed_run import ManagedRun
from app.agent_engine.orchestration.coordinator import CoordinatorSession
from app.agent_engine.orchestration.llm_subagent_worker import LLMSubagentWorker
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.service import agent_run_service
from app.agent_engine.session import AgentSession
from app.agent_engine.state import RunRequest
from app.scenarios import CTFScenario


def _create(tmp_path, mode: str):
    workspace = tmp_path / mode
    workspace.mkdir()
    request = RunRequest(
        task_id=f"factory_{mode}",
        title=f"Factory {mode}",
        objective="Analyze the security fixture through the canonical execution path.",
        workspace=str(workspace),
        scenario="ctf",
        execution_mode=mode,
    )
    return agent_run_service.create_session(
        request,
        CTFScenario().validator(),
        provider=ScriptedProvider([]),
        sandbox=LocalTestSandbox(workspace),
        register=False,
    )


def test_auto_mode_constructs_coordinator_with_production_leaf_worker(tmp_path):
    session = _create(tmp_path, "auto")

    assert isinstance(session, ManagedRun)
    assert isinstance(session, CoordinatorSession)
    assert isinstance(session.manager.worker, LLMSubagentWorker)
    mode_event = next(event for event in session.event_stream() if event.type == EventType.RUN_MODE_SELECTED.value)
    assert mode_event.payload["requested_mode"] == "auto"
    assert mode_event.payload["effective_mode"] == "coordinator"
    assert mode_event.payload["reasons"]

    session.manager.shutdown(cancel=True)


def test_explicit_single_mode_constructs_leaf_agent_session(tmp_path):
    session = _create(tmp_path, "single")

    assert isinstance(session, ManagedRun)
    assert isinstance(session, AgentSession)
    mode_event = next(event for event in session.event_stream() if event.type == EventType.RUN_MODE_SELECTED.value)
    assert mode_event.payload == {
        "requested_mode": "single",
        "effective_mode": "single",
        "reasons": ["explicit request mode"],
    }

