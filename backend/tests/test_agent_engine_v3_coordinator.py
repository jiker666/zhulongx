from app.agent_engine.agents.base import AgentSummary
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.coordinator import CoordinatorSession
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.state import RunRequest, RunStatus
from app.scenarios import CTFScenario


class _EvidenceWorker:
    def __call__(self, record, mailbox):
        evidence_id = f"evidence_{record.task.task_id}"
        return AgentSummary(
            agent_id=record.agent_id,
            role=record.role,
            task_id=record.task.task_id,
            status="completed",
            summary=f"completed {record.task.title}",
            evidence=({
                "evidence_id": evidence_id,
                "summary": f"offline evidence for {record.task.task_id}",
                "source_event_ids": [f"fixture_{record.task.task_id}"],
            },),
            recommendations=("continue bounded workflow",),
        )


def test_coordinator_runs_scenario_dag_through_real_subagents(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    request = RunRequest("coordinator_task", "Coordinator", "solve fixture", str(workspace), scenario="ctf")
    scenario = CTFScenario()
    plan = scenario.build_plan(request.objective)
    workflow = scenario.workflow(request.objective)
    events = AppendOnlyEventStore(workspace / "events.jsonl")
    manager = SubagentManager("run_coordinator", workspace, events, _EvidenceWorker(), max_concurrency=3)
    session = CoordinatorSession(
        request,
        plan,
        workflow,
        manager,
        events=events,
        run_id="run_coordinator",
    )

    state = session.run()

    assert state.status == RunStatus.SUCCEEDED
    assert state.current_plan["plan_id"] == "ctf_default_v1"
    assert len(state.agents) == len(plan.nodes)
    types = [event.type for event in session.event_stream()]
    assert EventType.PLAN_PROPOSED.value in types
    assert EventType.AGENT_SPAWNED.value in types
    assert EventType.RUN_SUCCEEDED.value == types[-1] or EventType.CHECKPOINT_SAVED.value == types[-1]
    manager.shutdown()
