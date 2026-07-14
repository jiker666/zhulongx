from __future__ import annotations

from app.agent_engine.contracts.plan import Plan
from app.agent_engine.contracts.task import TaskBudget, TaskNode
from app.agent_engine.agents.roles import default_role_profiles
from app.agent_engine.orchestration.primitives import parallel, review, series, synthesize, task
from app.agent_engine.orchestration.workflow import WorkflowSpec
from app.scenarios.base import ScenarioManifest


READ_TOOLS = ("list_dir", "read_file", "grep", "record_evidence", "record_fact", "record_hypothesis")
EXECUTE_TOOLS = READ_TOOLS + ("extract_archive", "run_shell", "run_python", "write_file")
NETWORK_TOOLS = READ_TOOLS + ("http_request",)


_MANIFESTS = {
    "ctf": ScenarioManifest(
        "ctf", "CTF", ("scout", "analyst", "planner", "executor", "verifier", "synthesizer"),
        ("ctf",), EXECUTE_TOOLS + ("http_request", "submit_candidate"), ("run_shell", "run_python", "http_request"),
        ("candidate", "evidence_event_ids", "reproduction"), "authoritative_or_external_judge",
    ),
    "pentest": ScenarioManifest(
        "pentest", "Scoped penetration test", ("scout", "planner", "executor", "verifier", "refuter", "synthesizer"),
        ("web",), NETWORK_TOOLS + ("submit_candidate",), ("http_request",),
        ("finding", "scope", "evidence", "remediation"), "scope_and_reproduction_required",
    ),
    "vuln_analysis": ScenarioManifest(
        "vuln_analysis", "Vulnerability analysis", ("scout", "analyst", "executor", "verifier", "refuter", "synthesizer"),
        ("web", "reverse"), EXECUTE_TOOLS + ("submit_candidate",), ("run_shell", "run_python"),
        ("finding", "impact", "evidence", "remediation"), "reachability_and_impact_verified",
    ),
    "incident_response": ScenarioManifest(
        "incident_response", "Incident response", ("scout", "analyst", "researcher", "verifier", "synthesizer"),
        ("forensics", "malware"), READ_TOOLS + ("run_python", "submit_candidate"), ("run_python",),
        ("timeline", "iocs", "root_cause", "actions"), "timeline_and_chain_of_custody_required",
    ),
    "reverse_forensics": ScenarioManifest(
        "reverse_forensics", "Reverse engineering and forensics", ("scout", "analyst", "executor", "verifier", "synthesizer"),
        ("reverse", "forensics"), EXECUTE_TOOLS + ("submit_candidate",), ("run_shell", "run_python"),
        ("conclusion", "evidence", "reproduction"), "artifact_hash_and_reproduction_required",
    ),
}


_TOPOLOGIES = {
    "ctf": (
        (("format_scout", "scout"), ("challenge_classifier", "analyst"), ("fast_solver", "executor")),
        ("strategy_planner", "planner"),
        (("strategy_executor_a", "executor"), ("strategy_executor_b", "executor")),
        ("candidate_verifier", "verifier"),
        ("answer_synthesizer", "synthesizer"),
    ),
    "pentest": (
        (("scope_scout", "scout"),),
        ("test_planner", "planner"),
        (("enumeration_executor", "executor"), ("evidence_executor", "executor")),
        ("finding_verifier", "verifier"),
        ("report_synthesizer", "synthesizer"),
    ),
    "vuln_analysis": (
        (("structure_scan", "scout"), ("dataflow_analysis", "analyst"), ("dependency_check", "analyst")),
        ("test_constructor", "executor"),
        (("reachability_executor", "executor"),),
        ("impact_verifier", "verifier"),
        ("finding_synthesizer", "synthesizer"),
    ),
    "incident_response": (
        (("log_normalizer", "scout"), ("ioc_extractor", "analyst"), ("timeline_builder", "analyst")),
        ("incident_correlator", "analyst"),
        (("root_cause_analyst", "analyst"),),
        ("chain_verifier", "verifier"),
        ("response_synthesizer", "synthesizer"),
    ),
    "reverse_forensics": (
        (("file_identifier", "scout"), ("string_import_analyst", "analyst"), ("segment_analyst", "analyst")),
        ("behavior_planner", "analyst"),
        (("sandbox_executor", "executor"),),
        ("reproduction_verifier", "verifier"),
        ("analysis_synthesizer", "synthesizer"),
    ),
}


def manifest_for(name: str) -> ScenarioManifest:
    try:
        return _MANIFESTS[name]
    except KeyError as exc:
        raise KeyError(f"unknown scenario manifest: {name}") from exc


def build_plan(manifest: ScenarioManifest, objective: str) -> Plan:
    exploration, planning, execution, verification, synthesis = _TOPOLOGIES[manifest.name]
    nodes: list[TaskNode] = []
    exploration_ids: list[str] = []
    for task_id, role in exploration:
        exploration_ids.append(task_id)
        nodes.append(_node(task_id, role, (), manifest.allowed_tools, "evidence inventory"))
    planner_id, planner_role = planning
    nodes.append(_node(planner_id, planner_role, tuple(exploration_ids), manifest.allowed_tools, "ranked strategies"))
    execution_ids: list[str] = []
    for task_id, role in execution:
        execution_ids.append(task_id)
        nodes.append(_node(task_id, role, (planner_id,), manifest.allowed_tools, "reproducible evidence"))
    verifier_id, verifier_role = verification
    nodes.append(_node(verifier_id, verifier_role, tuple(execution_ids), manifest.allowed_tools, "independent verdict"))
    synth_id, synth_role = synthesis
    nodes.append(_node(synth_id, synth_role, (verifier_id,), manifest.allowed_tools, "structured final output"))
    return Plan(
        plan_id=f"{manifest.name}_default_v1",
        version=1,
        goal=objective,
        nodes=tuple(nodes),
        alternatives=("switch_hypothesis", "review_refute", "structured_human_handoff"),
        risks=("insufficient evidence", "budget exhaustion", "executor verifier conflict"),
        unknowns=("input-specific strategy",),
        critical_path=(planner_id, execution_ids[0], verifier_id, synth_id),
        rationale=f"{manifest.display_name} evidence-first bounded workflow",
    )


def build_workflow(manifest: ScenarioManifest, plan: Plan) -> WorkflowSpec:
    exploration, planning, execution, verification, synthesis_node = _TOPOLOGIES[manifest.name]
    exploration_node = parallel(
        tuple(task(task_id, node_id=f"workflow_{task_id}") for task_id, _ in exploration),
        max_concurrency=min(3, len(exploration)),
        node_id="exploration_parallel",
    ) if len(exploration) > 1 else task(exploration[0][0], node_id=f"workflow_{exploration[0][0]}")
    executor_node = parallel(
        tuple(task(task_id, node_id=f"workflow_{task_id}") for task_id, _ in execution),
        max_concurrency=min(2, len(execution)),
        node_id="execution_parallel",
    ) if len(execution) > 1 else task(execution[0][0], node_id=f"workflow_{execution[0][0]}")
    verified = review(
        executor_node,
        task(verification[0], node_id=f"workflow_{verification[0]}"),
        node_id="independent_review",
    )
    root = series((
        exploration_node,
        task(planning[0], node_id=f"workflow_{planning[0]}"),
        synthesize((verified,), task(synthesis_node[0], node_id=f"workflow_{synthesis_node[0]}"), node_id="synthesis"),
    ), node_id=f"{manifest.name}_workflow_root")
    return WorkflowSpec(
        workflow_id=f"{manifest.name}_workflow_v1",
        version=1,
        root=root,
        allowed_roles=manifest.roles,
        allowed_tools=manifest.allowed_tools,
        max_budget_units=sum(max(1, int(node.budget.max_tool_calls / 5)) for node in plan.nodes),
    )


def _node(task_id: str, role: str, dependencies: tuple[str, ...], tools: tuple[str, ...], output: str) -> TaskNode:
    role_tools = _tools_for_role(role, tools)
    return TaskNode(
        task_id=task_id,
        title=task_id.replace("_", " ").title(),
        role=role,
        expected_output=output,
        success_criteria=(f"{output} is evidence-backed",),
        dependencies=dependencies,
        allowed_tools=role_tools,
        budget=TaskBudget(max_seconds=120, max_tool_calls=20, max_tokens=20_000, max_cost_usd=1),
        fallback_strategies=("switch_tool", "narrow_scope"),
        trigger_conditions=("new evidence", "prior strategy blocked"),
    )


def _tools_for_role(role: str, tools: tuple[str, ...]) -> tuple[str, ...]:
    profile = default_role_profiles().get(role)
    if profile is None:
        return ()
    return tuple(item for item in tools if item in set(profile.allowed_tools))
