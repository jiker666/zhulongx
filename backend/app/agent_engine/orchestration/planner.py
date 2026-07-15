from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any, Mapping

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.agent_engine.abort import AbortToken
from app.agent_engine.contracts.plan import Plan
from app.agent_engine.contracts.task import TaskBudget, TaskNode
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.task_graph import TaskGraph
from app.agent_engine.providers.base import ModelProvider, ProviderError
from app.agent_engine.state import RunRequest


class PlanningError(RuntimeError):
    pass


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Assumption(_StrictModel):
    assumption_id: str
    statement: str
    validation_task_id: str = ""


class Unknown(_StrictModel):
    unknown_id: str
    question: str
    resolution_signal: str


class Hypothesis(_StrictModel):
    hypothesis_id: str
    statement: str
    falsification_test: str
    success_signal: str
    priority: int = 0


class AlternativeStrategy(_StrictModel):
    strategy_id: str
    trigger: str
    summary: str


class CompletionContract(_StrictModel):
    required_outputs: list[str] = Field(min_length=1)
    required_evidence_types: list[str] = Field(default_factory=list)
    minimum_verification_level: str = "independent"
    external_evaluator: bool = False
    pending_external_allowed: bool = False
    independent_reproduction: bool = True
    final_output_schema: dict[str, Any] = Field(default_factory=dict)


class Risk(_StrictModel):
    risk_id: str
    description: str
    mitigation: str
    severity: str = "medium"


class TaskBudgetProposal(_StrictModel):
    max_seconds: float = Field(default=120, gt=0, le=3600)
    max_tool_calls: int = Field(default=20, gt=0, le=1000)
    max_tokens: int = Field(default=20_000, gt=0, le=131_072)
    max_cost_usd: float = Field(default=1, ge=0, le=1000)


class PlanNodeProposal(_StrictModel):
    task_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    role: str = Field(min_length=1, max_length=100)
    objective: str = Field(min_length=1, max_length=20_000)
    dependencies: list[str] = Field(default_factory=list)
    inputs: list[str] = Field(default_factory=list)
    context_refs: list[str] = Field(default_factory=list)
    allowed_capabilities: list[str] = Field(default_factory=list, max_length=128)
    expected_outputs: list[str] = Field(min_length=1)
    success_criteria: list[str] = Field(min_length=1)
    failure_signals: list[str] = Field(default_factory=list)
    budget: TaskBudgetProposal = Field(default_factory=TaskBudgetProposal)
    priority: int = Field(default=0, ge=-100, le=100)
    parallel_group: str = ""
    workspace_policy: str = "isolated"
    verification_policy: str = "evidence_required"
    status: str = "pending"
    attempt: int = Field(default=1, ge=1, le=20)

    def to_task_node(self) -> TaskNode:
        return TaskNode(
            task_id=self.task_id,
            title=self.title,
            role=self.role,
            objective=self.objective,
            expected_output="; ".join(self.expected_outputs),
            expected_outputs=tuple(self.expected_outputs),
            success_criteria=tuple(self.success_criteria),
            dependencies=tuple(self.dependencies),
            inputs=tuple(self.inputs),
            context_refs=tuple(self.context_refs),
            allowed_tools=tuple(self.allowed_capabilities),
            failure_signals=tuple(self.failure_signals),
            budget=TaskBudget(**self.budget.model_dump()),
            priority=self.priority,
            parallel_group=self.parallel_group,
            workspace_policy=self.workspace_policy,
            verification_policy=self.verification_policy,
            attempt=self.attempt,
        )


class PlanProposal(_StrictModel):
    goal: str = Field(min_length=1)
    assumptions: list[Assumption] = Field(default_factory=list)
    unknowns: list[Unknown] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(min_length=2)
    nodes: list[PlanNodeProposal] = Field(min_length=2)
    critical_path: list[str] = Field(min_length=1)
    alternatives: list[AlternativeStrategy] = Field(default_factory=list)
    completion_contract: CompletionContract
    risk_register: list[Risk] = Field(default_factory=list)
    rationale_summary: str = Field(min_length=1)

    def to_plan(self, plan_id: str, version: int = 1, revision_reason: str = "") -> Plan:
        return Plan(
            plan_id=plan_id,
            version=version,
            goal=self.goal,
            nodes=tuple(node.to_task_node() for node in self.nodes),
            alternatives=tuple(item.summary for item in self.alternatives),
            risks=tuple(item.description for item in self.risk_register),
            assumptions=tuple(item.statement for item in self.assumptions),
            unknowns=tuple(item.question for item in self.unknowns),
            hypotheses=tuple(item.model_dump() for item in self.hypotheses),
            critical_path=tuple(self.critical_path),
            completion_contract=self.completion_contract.model_dump(),
            risk_register=tuple(item.model_dump() for item in self.risk_register),
            rationale=self.rationale_summary,
            revision_reason=revision_reason,
        )


@dataclass(frozen=True)
class PlannerResult:
    proposal: PlanProposal
    plan: Plan
    source: str
    attempts: int


class DynamicPlanner:
    def __init__(
        self,
        provider: ModelProvider,
        *,
        allowed_roles: tuple[str, ...],
        allowed_tools: tuple[str, ...],
        required_outputs: tuple[str, ...],
        max_repairs: int = 2,
    ) -> None:
        self.provider = provider
        self.allowed_roles = allowed_roles
        self.allowed_tools = allowed_tools
        self.required_outputs = required_outputs
        self.max_repairs = max(0, max_repairs)

    def propose(
        self,
        request: RunRequest,
        macro_plan: Plan,
        events: AppendOnlyEventStore,
        run_id: str,
        abort_token: AbortToken,
    ) -> PlannerResult:
        bind = getattr(self.provider, "bind_private_transcript", None)
        if callable(bind):
            bind(str(request.workspace) + "/.agent_state/private/planner_transcript.json")
        messages: list[dict[str, Any]] = [{
            "role": "system",
            "content": (
                "Return one JSON object matching the supplied PlanProposal schema. Create a bounded acyclic plan, "
                "at least two non-overlapping falsifiable hypotheses, capability-scoped nodes, an independent verifier, "
                "and an evidence-based completion contract. Do not include private reasoning."
            ),
        }, {
            "role": "user",
            "content": json.dumps({
                "objective": request.objective,
                "scenario": request.scenario,
                "inputs": [
                    {"name": item.name, "media_type": item.media_type, "readonly": item.readonly}
                    for item in request.inputs
                ],
                "authorization": {
                    key: bool(request.authorization.get(key, False))
                    for key in ("authorized", "allow_process", "allow_worker", "allow_private_network")
                },
                "allowed_roles": list(self.allowed_roles),
                "allowed_tools": list(self.allowed_tools),
                "scenario_macro": macro_plan.to_dict(),
                "schema": PlanProposal.model_json_schema(),
            }, ensure_ascii=False),
        }]
        last_error = ""
        for attempt in range(1, self.max_repairs + 2):
            requested = events.append(
                run_id,
                EventType.MODEL_REQUESTED,
                actor="dynamic_planner",
                agent_id="agent_root",
                task_id=request.task_id,
                payload={
                    "purpose": "plan_proposal",
                    "attempt": attempt,
                    "provider": request.model_config.provider,
                    "model": request.model_config.model,
                    "tool_count": 0,
                },
            )
            turn = self.provider.complete(
                messages,
                [],
                timeout_seconds=min(request.model_config.timeout_seconds, request.budgets.max_seconds, 180),
                abort_token=abort_token,
            )
            response_parent_id = requested.event_id
            negotiation = turn.provider_metadata.get("capability_negotiation")
            if isinstance(negotiation, Mapping):
                capability = events.append(
                    run_id,
                    EventType.PROVIDER_CAPABILITY_NEGOTIATED,
                    actor="provider",
                    parent_event_id=requested.event_id,
                    agent_id="agent_root",
                    task_id=request.task_id,
                    payload={"negotiation": dict(negotiation), "purpose": "plan_proposal"},
                )
                response_parent_id = capability.event_id
            responded = events.append(
                run_id,
                EventType.MODEL_RESPONDED,
                actor="dynamic_planner",
                parent_event_id=response_parent_id,
                agent_id="agent_root",
                task_id=request.task_id,
                payload={
                    "purpose": "plan_proposal",
                    "attempt": attempt,
                    "text": turn.text,
                    "usage": dict(turn.usage),
                    "finish_reason": turn.finish_reason,
                    "raw_response_ref": turn.raw_response_ref,
                    **turn.public_metadata(),
                },
            )
            if not turn.text.strip() and turn.finish_reason == "no_script_step":
                proposal = self._offline_proposal(request, macro_plan)
                plan = self._validate(proposal, request, run_id)
                events.append(
                    run_id,
                    EventType.DECISION_RECORDED,
                    actor="dynamic_planner",
                    parent_event_id=responded.event_id,
                    agent_id="agent_root",
                    task_id=request.task_id,
                    payload={"decision": {
                        "decision_id": f"offline_plan_{uuid.uuid4().hex}",
                        "decision": "use deterministic intake-derived proposal",
                        "rationale": "mock provider has no scripted planning response",
                        "evidence_ids": [],
                        "risks": ["not a live-model planning result"],
                    }},
                )
                return PlannerResult(proposal, plan, "offline_deterministic", attempt)
            try:
                proposal = PlanProposal.model_validate_json(turn.text)
                plan = self._validate(proposal, request, run_id)
                return PlannerResult(proposal, plan, "model", attempt)
            except (ValidationError, ValueError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                events.append(
                    run_id,
                    EventType.DECISION_RECORDED,
                    actor="plan_validator",
                    parent_event_id=responded.event_id,
                    agent_id="agent_root",
                    task_id=request.task_id,
                    payload={"decision": {
                        "decision_id": f"plan_repair_{attempt}",
                        "decision": "repair_invalid_plan",
                        "rationale": last_error[:4000],
                        "evidence_ids": [responded.event_id],
                        "risks": ["invalid model-generated graph"],
                    }},
                )
                messages.extend([
                    {"role": "assistant", "content": turn.text},
                    {"role": "user", "content": json.dumps({
                        "repair": "Return a corrected complete PlanProposal JSON object.",
                        "validation_error": last_error[:4000],
                    })},
                ])
        raise PlanningError(f"planner did not produce a valid graph: {last_error or 'empty response'}")

    def _validate(self, proposal: PlanProposal, request: RunRequest, run_id: str) -> Plan:
        plan = proposal.to_plan(f"plan_{run_id}")
        total_tool_calls = sum(node.budget.max_tool_calls for node in plan.nodes)
        total_tokens = sum(node.budget.max_tokens for node in plan.nodes)
        total_cost = sum(node.budget.max_cost_usd for node in plan.nodes)
        effective_tool_budget = max(request.budgets.max_tool_calls, len(plan.nodes))
        if total_tool_calls > effective_tool_budget:
            raise ValueError("plan exceeds aggregate tool budget")
        if total_tokens > request.budgets.max_tokens:
            raise ValueError("plan exceeds aggregate token budget")
        if total_cost > request.budgets.max_cost_usd:
            raise ValueError("plan exceeds aggregate cost budget")
        if not any(node.role == "verifier" for node in plan.nodes):
            raise ValueError("plan requires an independent verifier")
        statements = {item.statement.strip().casefold() for item in proposal.hypotheses}
        tests = {item.falsification_test.strip().casefold() for item in proposal.hypotheses}
        if len(statements) != len(proposal.hypotheses) or len(tests) != len(proposal.hypotheses):
            raise ValueError("plan hypotheses must be non-overlapping and independently falsifiable")
        missing_outputs = set(self.required_outputs) - set(proposal.completion_contract.required_outputs)
        if missing_outputs:
            raise ValueError(f"completion contract omits required outputs: {sorted(missing_outputs)}")
        TaskGraph(plan, allowed_roles=self.allowed_roles, available_tools=self.allowed_tools)
        return plan

    def _offline_proposal(self, request: RunRequest, macro_plan: Plan) -> PlanProposal:
        input_refs = [item.name for item in request.inputs]
        nodes = []
        node_count = max(1, len(macro_plan.nodes))
        tool_share = max(1, request.budgets.max_tool_calls // node_count)
        token_share = max(1, request.budgets.max_tokens // node_count)
        cost_share = max(0, request.budgets.max_cost_usd / node_count)
        for node in macro_plan.nodes:
            raw = node.to_dict()
            nodes.append(PlanNodeProposal(
                task_id=node.task_id,
                title=f"{node.title}: {request.title}",
                role=node.role,
                objective=f"{node.title} for the supplied {request.scenario} objective and artifact inventory.",
                dependencies=list(node.dependencies),
                inputs=input_refs,
                context_refs=["artifact_inventory", "authorization_boundary"],
                allowed_capabilities=list(node.allowed_tools),
                expected_outputs=list(node.expected_outputs or (node.expected_output,)),
                success_criteria=list(node.success_criteria),
                failure_signals=list(node.failure_signals or ("no new evidence", "repeated error")),
                budget=TaskBudgetProposal(
                    max_seconds=min(float(raw["budget"]["max_seconds"]), request.budgets.max_seconds),
                    max_tool_calls=min(int(raw["budget"]["max_tool_calls"]), tool_share),
                    max_tokens=min(int(raw["budget"]["max_tokens"]), token_share),
                    max_cost_usd=min(float(raw["budget"]["max_cost_usd"]), cost_share),
                ),
                priority=node.priority,
                parallel_group=node.parallel_group or ("intake" if not node.dependencies else ""),
                workspace_policy="isolated",
                verification_policy="independent" if node.role in {"verifier", "refuter"} else "evidence_required",
            ))
        return PlanProposal(
            goal=request.objective,
            assumptions=[Assumption(
                assumption_id="scope_inputs",
                statement="The supplied artifact inventory is the complete initial evidence set.",
                validation_task_id=nodes[0].task_id,
            )],
            unknowns=[Unknown(
                unknown_id="primary_path",
                question="Which evidence path most directly satisfies the completion contract?",
                resolution_signal="A bounded experiment produces reproducible evidence.",
            )],
            hypotheses=[
                Hypothesis(
                    hypothesis_id="hyp_primary",
                    statement="The primary artifact or target path contains a directly testable solution signal.",
                    falsification_test="Run the lowest-cost read-only triage and verify the expected signal is absent.",
                    success_signal="A tool-backed observation supports the primary path.",
                    priority=10,
                ),
                Hypothesis(
                    hypothesis_id="hyp_alternative",
                    statement="An alternate structure, encoding, dependency, or behavior explains the task evidence.",
                    falsification_test="Inspect a disjoint artifact or behavior surface and compare evidence quality.",
                    success_signal="Independent evidence supports the alternate explanation.",
                    priority=5,
                ),
            ],
            nodes=nodes,
            critical_path=list(macro_plan.critical_path),
            alternatives=[AlternativeStrategy(
                strategy_id="switch_hypothesis",
                trigger="primary path is falsified or blocked",
                summary="replace the blocked node with a disjoint hypothesis test",
            )],
            completion_contract=CompletionContract(
                required_outputs=list(self.required_outputs or ("evidence-backed result",)),
                required_evidence_types=["tool_result"],
                minimum_verification_level="independent",
                external_evaluator=request.scenario == "ctf",
                pending_external_allowed=request.scenario == "ctf",
                independent_reproduction=True,
            ),
            risk_register=[Risk(
                risk_id="insufficient_evidence",
                description="The selected path may produce a plausible but unverified conclusion.",
                mitigation="Require independent verifier evidence before completion.",
                severity="high",
            )],
            rationale_summary="Deterministic intake-derived scenario plan for offline protocol execution.",
        )
