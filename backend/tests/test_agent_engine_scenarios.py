from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.state import SessionState
from app.agent_engine.validation.base import CandidateSubmission
from app.agent_engine.validation.structured import StructuredOutputValidator
from app.agent_engine.orchestration.scheduler import WorkflowResult, WorkflowScheduler
from app.agent_engine.orchestration.task_graph import TaskGraph
from app.agent_engine.orchestration.workflow import WorkflowValidator
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


def test_five_scenario_workflows_are_executable_offline():
    class FixtureDispatcher:
        def dispatch(self, task_id, context):
            return WorkflowResult(
                True,
                "completed",
                value={"task_id": task_id, "fixture": "offline"},
                evidence_ids=(f"evidence_{task_id}",),
                metadata={"verified": "verifier" in task_id},
            )

    registry = default_scenarios()
    for name in registry.names():
        scenario = registry.get(name)
        plan = scenario.build_plan(f"offline {name} fixture")
        workflow = scenario.workflow(f"offline {name} fixture")
        graph = TaskGraph(plan, allowed_roles=workflow.allowed_roles, available_tools=workflow.allowed_tools)
        WorkflowValidator().validate(
            workflow,
            task_ids=set(graph.nodes),
            task_roles={task_id: node.role for task_id, node in graph.nodes.items()},
        )
        result = WorkflowScheduler(FixtureDispatcher()).execute(workflow)
        assert result.success is True, name
        assert result.children, name


def test_scenario_macros_publish_enforced_completion_contracts():
    registry = default_scenarios()
    expected_stages = {
        "ctf": {"intake", "candidate_extraction", "clean_verification", "external_evaluation"},
        "pentest": {"scope_confirmation", "passive_discovery", "controlled_proof", "independent_review"},
        "vuln_analysis": {"artifact_inventory", "source_sink_hypotheses", "patch", "regression_verification"},
        "incident_response": {"preservation", "timeline_ioc_parallel", "recovery_plan", "audit_export"},
        "reverse_forensics": {"triage", "parallel_static_hypotheses", "targeted_dynamic_analysis", "clean_verification"},
    }
    for name in registry.names():
        scenario = registry.get(name)
        manifest = scenario.manifest()
        plan = scenario.build_plan(f"contract {name}")
        contract = plan.completion_contract

        assert expected_stages[name] <= set(manifest.macro_stages)
        assert set(manifest.required_outputs) <= set(contract["required_outputs"])
        assert contract["minimum_verification_level"] == "independent"
        assert contract["independent_reproduction"] is True
        verifier = [node for node in plan.nodes if node.role == "verifier"]
        assert verifier and all(node.verification_policy == "clean_context" for node in verifier)
        assert plan.critical_path[-1] == plan.nodes[-1].task_id

    assert registry.get("ctf").build_plan("ctf").completion_contract["pending_external_allowed"] is True
    assert registry.get("pentest").build_plan("pentest").nodes[0].task_id == "scope_confirmation"
    assert registry.get("incident_response").build_plan("ir").nodes[0].task_id == "evidence_preservation"


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
