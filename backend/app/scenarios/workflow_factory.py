from __future__ import annotations

from dataclasses import dataclass

from app.agent_engine.contracts.plan import Plan
from app.agent_engine.contracts.task import TaskBudget, TaskNode
from app.agent_engine.agents.roles import default_role_profiles
from app.agent_engine.orchestration.primitives import parallel, series, task
from app.agent_engine.orchestration.workflow import WorkflowSpec
from app.scenarios.base import ScenarioManifest


READ_TOOLS = ("list_dir", "read_file", "grep", "record_evidence", "record_fact", "record_hypothesis", "complete_task")
EXECUTE_TOOLS = READ_TOOLS + ("extract_archive", "run_shell", "run_python", "write_file")
NETWORK_TOOLS = READ_TOOLS + ("http_request",)


_MANIFESTS = {
    "ctf": ScenarioManifest(
        "ctf", "CTF", ("scout", "analyst", "planner", "executor", "verifier", "refuter", "synthesizer"),
        ("ctf",), EXECUTE_TOOLS + ("http_request", "submit_candidate"), ("run_shell", "run_python", "http_request"),
        ("candidate", "evidence_event_ids", "reproduction"), "authoritative_or_external_judge",
        (
            "intake", "classify", "parallel_reconnaissance", "hypothesis_branches", "solve",
            "candidate_extraction", "clean_verification", "external_evaluation", "synthesis",
        ),
        {
            "required_outputs": ["candidate", "evidence_event_ids", "reproduction"],
            "required_evidence_types": ["tool_result"],
            "minimum_verification_level": "independent",
            "external_evaluator": True,
            "pending_external_allowed": True,
            "independent_reproduction": True,
        },
    ),
    "pentest": ScenarioManifest(
        "pentest", "Scoped penetration test", ("scout", "planner", "executor", "verifier", "refuter", "synthesizer"),
        ("web",), NETWORK_TOOLS + ("submit_candidate",), ("http_request",),
        ("finding", "scope", "evidence", "remediation"), "scope_and_reproduction_required",
        (
            "scope_confirmation", "passive_discovery", "attack_surface", "low_risk_validation",
            "exploit_hypothesis", "controlled_proof", "impact", "remediation", "independent_review",
        ),
        {
            "required_outputs": ["finding", "scope", "evidence", "remediation"],
            "required_evidence_types": ["tool_result"],
            "minimum_verification_level": "independent",
            "pending_external_allowed": False,
            "independent_reproduction": True,
            "scope_confirmation_required": True,
        },
    ),
    "vuln_analysis": ScenarioManifest(
        "vuln_analysis", "Vulnerability analysis", ("scout", "analyst", "executor", "verifier", "refuter", "synthesizer"),
        ("web", "reverse"), EXECUTE_TOOLS + ("submit_candidate",), ("run_shell", "run_python"),
        ("finding", "impact", "evidence", "remediation"), "reachability_and_impact_verified",
        (
            "artifact_inventory", "code_dependency_mapping", "source_sink_hypotheses", "static_checks",
            "dynamic_reproduction", "root_cause", "exploitability", "patch", "regression_verification",
        ),
        {
            "required_outputs": ["finding", "impact", "evidence", "remediation"],
            "required_evidence_types": ["tool_result"],
            "minimum_verification_level": "independent",
            "pending_external_allowed": False,
            "independent_reproduction": True,
            "regression_verification_required": True,
        },
    ),
    "incident_response": ScenarioManifest(
        "incident_response", "Incident response", ("scout", "analyst", "researcher", "verifier", "refuter", "synthesizer"),
        ("forensics", "malware"), READ_TOOLS + ("run_python", "submit_candidate"), ("run_python",),
        ("timeline", "iocs", "root_cause", "actions"), "timeline_and_chain_of_custody_required",
        (
            "preservation", "timeline_ioc_parallel", "hypothesis_graph", "containment_options",
            "evidence_validation", "recovery_plan", "report", "audit_export",
        ),
        {
            "required_outputs": ["timeline", "iocs", "root_cause", "actions"],
            "required_evidence_types": ["tool_result"],
            "minimum_verification_level": "independent",
            "pending_external_allowed": False,
            "independent_reproduction": True,
            "preservation_required": True,
        },
    ),
    "reverse_forensics": ScenarioManifest(
        "reverse_forensics", "Reverse engineering and forensics", ("scout", "analyst", "executor", "verifier", "refuter", "synthesizer"),
        ("reverse", "forensics"), EXECUTE_TOOLS + ("submit_candidate",), ("run_shell", "run_python"),
        ("conclusion", "evidence", "reproduction"), "artifact_hash_and_reproduction_required",
        (
            "triage", "file_architecture", "strings_imports_metadata", "parallel_static_hypotheses",
            "targeted_dynamic_analysis", "behavior_reconstruction", "candidate_extraction", "clean_verification",
        ),
        {
            "required_outputs": ["conclusion", "evidence", "reproduction"],
            "required_evidence_types": ["tool_result"],
            "minimum_verification_level": "independent",
            "pending_external_allowed": False,
            "independent_reproduction": True,
            "artifact_hash_required": True,
        },
    ),
}


@dataclass(frozen=True)
class MacroNode:
    task_id: str
    role: str
    dependencies: tuple[str, ...]
    output: str
    parallel_group: str = ""
    workspace_policy: str = "isolated"
    verification_policy: str = "evidence_required"


_MACROS = {
    "ctf": (
        MacroNode("artifact_intake", "scout", (), "immutable artifact inventory", "intake", "shared_readonly"),
        MacroNode("format_scout", "scout", ("artifact_intake",), "format observations", "recon", "shared_readonly"),
        MacroNode("challenge_classifier", "analyst", ("artifact_intake",), "ranked challenge classes", "recon", "shared_readonly"),
        MacroNode("reconnaissance_a", "scout", ("challenge_classifier",), "primary hypothesis evidence", "hypotheses", "shared_readonly"),
        MacroNode("reconnaissance_b", "analyst", ("challenge_classifier",), "disjoint hypothesis evidence", "hypotheses", "shared_readonly"),
        MacroNode("strategy_planner", "planner", ("format_scout", "reconnaissance_a", "reconnaissance_b"), "ranked solve strategies"),
        MacroNode("strategy_executor_a", "executor", ("strategy_planner",), "reproducible primary solution", "solve"),
        MacroNode("strategy_executor_b", "executor", ("strategy_planner",), "reproducible alternate solution", "solve"),
        MacroNode("candidate_extractor", "executor", ("strategy_executor_a", "strategy_executor_b"), "candidate bound to evidence"),
        MacroNode("candidate_verifier", "verifier", ("candidate_extractor",), "clean independent verdict", verification_policy="clean_context"),
        MacroNode("answer_synthesizer", "synthesizer", ("candidate_verifier",), "structured final output"),
    ),
    "pentest": (
        MacroNode("scope_confirmation", "planner", (), "confirmed target and authorization boundary"),
        MacroNode("passive_discovery", "scout", ("scope_confirmation",), "passive asset evidence", workspace_policy="shared_readonly"),
        MacroNode("attack_surface_map", "scout", ("passive_discovery",), "bounded attack surface map", workspace_policy="shared_readonly"),
        MacroNode("low_risk_validation", "executor", ("attack_surface_map",), "low-risk validation evidence"),
        MacroNode("exploit_hypothesis", "planner", ("low_risk_validation",), "falsifiable exploit hypothesis"),
        MacroNode("controlled_proof", "executor", ("exploit_hypothesis",), "controlled proof without destructive impact"),
        MacroNode("impact_evidence", "executor", ("controlled_proof",), "impact and evidence bundle"),
        MacroNode("remediation", "synthesizer", ("impact_evidence",), "actionable remediation"),
        MacroNode("finding_verifier", "verifier", ("remediation",), "independent scoped verdict", verification_policy="clean_context"),
        MacroNode("report_synthesizer", "synthesizer", ("finding_verifier",), "structured final output"),
    ),
    "vuln_analysis": (
        MacroNode("artifact_inventory", "scout", (), "immutable code and dependency inventory", workspace_policy="shared_readonly"),
        MacroNode("code_mapping", "analyst", ("artifact_inventory",), "code structure map", "mapping", "shared_readonly"),
        MacroNode("dependency_mapping", "analyst", ("artifact_inventory",), "dependency and version map", "mapping", "shared_readonly"),
        MacroNode("source_sink_hypotheses", "analyst", ("code_mapping", "dependency_mapping"), "source and sink hypotheses"),
        MacroNode("static_checks", "analyst", ("source_sink_hypotheses",), "static reachability evidence", workspace_policy="shared_readonly"),
        MacroNode("dynamic_reproduction", "executor", ("static_checks",), "targeted dynamic reproduction"),
        MacroNode("root_cause", "analyst", ("dynamic_reproduction",), "root cause and exploitability"),
        MacroNode("patch_proposal", "executor", ("root_cause",), "minimal patch proposal"),
        MacroNode("regression_verifier", "verifier", ("patch_proposal",), "clean regression verdict", verification_policy="clean_context"),
        MacroNode("finding_synthesizer", "synthesizer", ("regression_verifier",), "structured final output"),
    ),
    "incident_response": (
        MacroNode("evidence_preservation", "scout", (), "hash-bound preserved evidence", workspace_policy="shared_readonly"),
        MacroNode("timeline_builder", "analyst", ("evidence_preservation",), "normalized timeline", "analysis", "shared_readonly"),
        MacroNode("ioc_extractor", "analyst", ("evidence_preservation",), "typed IOC inventory", "analysis", "shared_readonly"),
        MacroNode("hypothesis_graph", "analyst", ("timeline_builder", "ioc_extractor"), "incident hypothesis graph"),
        MacroNode("containment_options", "researcher", ("hypothesis_graph",), "ranked containment options"),
        MacroNode("evidence_verifier", "verifier", ("hypothesis_graph",), "independent evidence-chain verdict", verification_policy="clean_context"),
        MacroNode("recovery_plan", "synthesizer", ("containment_options", "evidence_verifier"), "recovery and monitoring plan"),
        MacroNode("response_synthesizer", "synthesizer", ("recovery_plan",), "timeline, IOC, root cause, and actions"),
    ),
    "reverse_forensics": (
        MacroNode("artifact_triage", "scout", (), "immutable artifact triage", workspace_policy="shared_readonly"),
        MacroNode("file_identifier", "scout", ("artifact_triage",), "file and architecture identification", "static", "shared_readonly"),
        MacroNode("string_import_analyst", "analyst", ("artifact_triage",), "strings and imports evidence", "static", "shared_readonly"),
        MacroNode("segment_analyst", "analyst", ("artifact_triage",), "segment and metadata evidence", "static", "shared_readonly"),
        MacroNode("static_hypotheses", "analyst", ("file_identifier", "string_import_analyst", "segment_analyst"), "parallel static hypotheses"),
        MacroNode("targeted_dynamic_analysis", "executor", ("static_hypotheses",), "targeted sandbox behavior evidence"),
        MacroNode("behavior_reconstruction", "analyst", ("targeted_dynamic_analysis",), "behavior reconstruction"),
        MacroNode("candidate_extraction", "executor", ("behavior_reconstruction",), "candidate or conclusion evidence"),
        MacroNode("reproduction_verifier", "verifier", ("candidate_extraction",), "clean independent reproduction", verification_policy="clean_context"),
        MacroNode("analysis_synthesizer", "synthesizer", ("reproduction_verifier",), "structured final output"),
    ),
}


def manifest_for(name: str) -> ScenarioManifest:
    try:
        return _MANIFESTS[name]
    except KeyError as exc:
        raise KeyError(f"unknown scenario manifest: {name}") from exc


def build_plan(manifest: ScenarioManifest, objective: str) -> Plan:
    macro = _MACROS[manifest.name]
    nodes = tuple(_node(item, manifest.allowed_tools) for item in macro)
    verifier_id = next(item.task_id for item in reversed(macro) if item.role == "verifier")
    synth_id = macro[-1].task_id
    critical_path = _longest_path(nodes, synth_id)
    return Plan(
        plan_id=f"{manifest.name}_default_v1",
        version=1,
        goal=objective,
        nodes=nodes,
        alternatives=("switch_hypothesis", "review_refute", "structured_human_handoff"),
        risks=("insufficient evidence", "budget exhaustion", "executor verifier conflict"),
        unknowns=("input-specific strategy",),
        critical_path=critical_path,
        rationale=f"{manifest.display_name} evidence-first bounded workflow",
        completion_contract=dict(manifest.completion_contract),
        risk_register=tuple({"risk_id": f"risk_{index}", "description": risk} for index, risk in enumerate((
            "insufficient evidence", "budget exhaustion", "executor verifier conflict",
        ), start=1)),
    )


def build_workflow(manifest: ScenarioManifest, plan: Plan) -> WorkflowSpec:
    remaining = {node.task_id: node for node in plan.nodes}
    completed: set[str] = set()
    levels = []
    while remaining:
        ready = [node for node in remaining.values() if set(node.dependencies) <= completed]
        if not ready:
            raise ValueError("scenario macro contains a cycle")
        ready.sort(key=lambda node: node.task_id)
        children = tuple(task(node.task_id, node_id=f"workflow_{node.task_id}") for node in ready)
        levels.append(
            parallel(children, max_concurrency=min(3, len(children)), node_id=f"level_{len(levels)}")
            if len(children) > 1 else children[0]
        )
        for node in ready:
            completed.add(node.task_id)
            remaining.pop(node.task_id)
    root = series(tuple(levels), node_id=f"{manifest.name}_workflow_root")
    return WorkflowSpec(
        workflow_id=f"{manifest.name}_workflow_v1",
        version=1,
        root=root,
        allowed_roles=manifest.roles,
        allowed_tools=manifest.allowed_tools,
        max_budget_units=sum(max(1, int(node.budget.max_tool_calls / 5)) for node in plan.nodes),
    )


def _node(macro: MacroNode, tools: tuple[str, ...]) -> TaskNode:
    role_tools = _tools_for_role(macro.role, tools)
    return TaskNode(
        task_id=macro.task_id,
        title=macro.task_id.replace("_", " ").title(),
        role=macro.role,
        objective=f"Produce {macro.output} while preserving scenario constraints.",
        expected_output=macro.output,
        expected_outputs=(macro.output,),
        success_criteria=(f"{macro.output} is evidence-backed",),
        failure_signals=("no evidence gain", "repeated error", "scope or preservation violation"),
        dependencies=macro.dependencies,
        allowed_tools=role_tools,
        budget=TaskBudget(max_seconds=120, max_tool_calls=20, max_tokens=20_000, max_cost_usd=1),
        fallback_strategies=("switch_tool", "narrow_scope"),
        trigger_conditions=("new evidence", "prior strategy blocked"),
        parallel_group=macro.parallel_group,
        workspace_policy=macro.workspace_policy,
        verification_policy=macro.verification_policy,
    )


def _longest_path(nodes: tuple[TaskNode, ...], target: str) -> tuple[str, ...]:
    by_id = {node.task_id: node for node in nodes}
    paths: dict[str, tuple[str, ...]] = {}
    for node in nodes:
        dependency_paths = [paths[item] for item in node.dependencies]
        best = max(dependency_paths, key=len) if dependency_paths else ()
        paths[node.task_id] = (*best, node.task_id)
    return paths[target]


def _tools_for_role(role: str, tools: tuple[str, ...]) -> tuple[str, ...]:
    profile = default_role_profiles().get(role)
    if profile is None:
        return ()
    return tuple(item for item in tools if item in set(profile.allowed_tools))
