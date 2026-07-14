"""Compatibility facade for competition clients backed only by Agent Engine v3."""
from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.agent_engine.budget import BudgetLimits
from app.agent_engine.manager import run_manager
from app.agent_engine.projections import CanonicalRunProjection
from app.agent_engine.service import agent_run_service
from app.agent_engine.session import AgentSession
from app.agent_engine.state import ModelConfig, NetworkPolicy, RunRequest, RunStatus
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.tools.types import ToolCall
from app.config import settings
from app.scenarios import CTFScenario


router = APIRouter(prefix="/competition", tags=["Agent Engine v3 competition facade"])


class CreateChallenge(BaseModel):
    competition_id: str = Field(min_length=1, max_length=128)
    challenge_id: str = Field(min_length=1, max_length=128)
    objective: str = Field(min_length=1, max_length=20_000)
    scope: list[str] = Field(default_factory=list, max_length=100)
    category: str = Field(default="unknown", max_length=100)
    flag_format: str = r"flag\{[^}]+\}"
    authorized: bool = False
    allow_process: bool = False
    allow_worker: bool = False
    allow_private_network: bool = False
    allowed_hosts: list[str] = Field(default_factory=list, max_length=100)
    allowed_ports: list[int] = Field(default_factory=list, max_length=100)
    max_seconds: float = Field(default=600, ge=1, le=3600)
    max_model_requests: int = Field(default=50, ge=1, le=500)
    max_tool_calls: int = Field(default=100, ge=1, le=1000)
    provider: str = Field(default=settings.LLM_PROVIDER, min_length=1, max_length=100)
    model: str = Field(default=settings.LLM_MODEL, min_length=1, max_length=200)


class HypothesisIn(BaseModel):
    hypothesis_id: str = Field(default="", max_length=200)
    statement: str = Field(min_length=1, max_length=20_000)
    test_strategy: str = Field(default="operator supplied", max_length=20_000)
    success_signal: str = Field(default="evidence confirms the hypothesis", max_length=10_000)
    priority: int = 0


class ActionCandidate(BaseModel):
    tool_call_id: str = Field(default="", max_length=200)
    tool_name: str = Field(min_length=1, max_length=200)
    tool_arguments: dict[str, Any] = Field(default_factory=dict)
    purpose: str = Field(default="operator requested action", max_length=10_000)


class ExecuteAction(BaseModel):
    action: ActionCandidate
    specialist: str = Field(default="agent_engine_v3", max_length=100)


class CandidateIn(BaseModel):
    accepted: bool
    reason: str = Field(min_length=1, max_length=10_000)
    resume_on_rejection: bool = True


class HumanEvidenceIn(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)
    resume: bool = False


class PauseIn(BaseModel):
    reason: str = Field(default="paused by competition operator", min_length=1, max_length=10_000)


def _session_or_404(run_id: str) -> AgentSession:
    session = run_manager.get(run_id)
    if session is None or not session.request.authorization.get("competition_id"):
        raise HTTPException(404, "competition run not found")
    return session


def _project(session: AgentSession) -> dict[str, Any]:
    projection = CanonicalRunProjection(session.run_id, session.request.objective)
    projection.consume(session.event_stream())
    data = projection.to_dict()
    return {
        **data,
        "task_id": session.request.task_id,
        "competition_id": session.request.authorization.get("competition_id", ""),
        "challenge_id": session.request.authorization.get("challenge_id", ""),
        "category": session.request.authorization.get("category", "unknown"),
        "scope": list(session.request.authorization.get("scope", [])),
        "workspace": str(session.workspace),
        "is_running": run_manager.is_running(session.run_id),
    }


@router.get("/profiles")
def profiles():
    return ["agent-engine-v3"]


@router.get("/profile")
def profile():
    return {
        "name": "agent-engine-v3",
        "lifecycle_authority": "AgentSession",
        "construction_path": "AgentRunService",
        "state_source": "AppendOnlyEventStore",
        "policy": "default-deny per run",
    }


@router.post("/challenges")
def create_challenge(payload: CreateChallenge):
    task_id = f"cmp_{uuid.uuid4().hex[:12]}"
    runtime_root = Path(
        settings.WORKER_SHARED_ROOT if payload.allow_worker else settings.CTF_RUN_DIR
    ).expanduser().resolve()
    runtime_root.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix=f"{task_id}_", dir=runtime_root))
    workspace.chmod(0o777 if payload.allow_worker else 0o700)
    network_enabled = payload.authorized and bool(payload.allowed_hosts)
    request = RunRequest(
        task_id=task_id,
        title=f"{payload.competition_id}/{payload.challenge_id}",
        objective=payload.objective,
        workspace=str(workspace),
        scenario="ctf",
        authorization={
            "authorized": payload.authorized,
            "allow_process": payload.allow_process,
            "allow_worker": payload.allow_worker,
            "allow_private_network": payload.allow_private_network,
            "competition_id": payload.competition_id,
            "challenge_id": payload.challenge_id,
            "category": payload.category,
            "scope": list(payload.scope),
        },
        network_policy=NetworkPolicy(
            mode="allowlist" if network_enabled else "deny",
            allowed_hosts=tuple(payload.allowed_hosts) if network_enabled else (),
            allowed_ports=tuple(payload.allowed_ports) if network_enabled else (),
        ),
        budgets=BudgetLimits(
            max_seconds=payload.max_seconds,
            max_model_requests=payload.max_model_requests,
            max_tool_calls=payload.max_tool_calls,
        ),
        model_config=ModelConfig(provider=payload.provider, model=payload.model),
    )
    try:
        session = agent_run_service.create_session(
            request,
            CTFScenario(flag_pattern=payload.flag_format).validator(),
            scenario_config={
                "flag_pattern": payload.flag_format,
                "evaluator_ref": "external",
                "competition_id": payload.competition_id,
                "challenge_id": payload.challenge_id,
            },
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _project(session)


@router.get("/challenges")
def list_challenges():
    return [
        _project(session)
        for session in run_manager.sessions()
        if session.request.authorization.get("competition_id")
    ]


@router.get("/challenges/{run_id}")
def get_challenge(run_id: str):
    return _project(_session_or_404(run_id))


@router.post("/challenges/{run_id}/start")
def start(run_id: str):
    session = _session_or_404(run_id)
    if session.state.status == RunStatus.HUMAN_REQUIRED:
        session.answer_human({"action": "resume"})
    if session.state.status == RunStatus.PENDING_EXTERNAL:
        raise HTTPException(409, "run is waiting for external validation")
    started = run_manager.start(run_id)
    return {"run_id": run_id, "started": started, "state": session.state.status.value}


@router.post("/challenges/{run_id}/hypotheses")
def add_hypothesis(run_id: str, payload: HypothesisIn):
    session = _session_or_404(run_id)
    try:
        return session.record_hypothesis({
            "hypothesis_id": payload.hypothesis_id or f"hyp_{uuid.uuid4().hex}",
            "statement": payload.statement,
            "test_strategy": payload.test_strategy,
            "success_signal": payload.success_signal,
            "priority": payload.priority,
            "status": "open",
        })
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/challenges/{run_id}/actions/score")
def score_action(run_id: str, action: ActionCandidate):
    session = _session_or_404(run_id)
    definition = session.registry.get(action.tool_name)
    if definition is None:
        raise HTTPException(404, f"tool is not registered: {action.tool_name}")
    return {
        **action.model_dump(),
        "risk_level": definition.risk_level,
        "permissions": list(definition.permissions),
        "requires_approval": definition.requires_approval,
        "source": "Agent Engine v3 ToolRegistry",
    }


@router.post("/challenges/{run_id}/actions/execute")
def execute_action(run_id: str, payload: ExecuteAction):
    session = _session_or_404(run_id)
    if run_manager.is_running(run_id):
        raise HTTPException(409, "run is active; tools are controlled by its AgentSession")
    call = ToolCall(
        payload.action.tool_call_id or f"operator_{uuid.uuid4().hex}",
        payload.action.tool_name,
        payload.action.tool_arguments,
    )
    try:
        execution = session.execute_tool(call)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {
        "run_id": run_id,
        "tool_call_id": call.id,
        "success": execution.result.success,
        "summary": execution.result.summary,
        "output": execution.result.output,
        "error": execution.result.error,
        "metadata": dict(execution.result.metadata),
        "event": execution.result_event.to_dict(),
        "replayed": execution.replayed,
    }


@router.post("/challenges/{run_id}/candidates/verify")
def verify_candidate(run_id: str, payload: CandidateIn):
    session = _session_or_404(run_id)
    try:
        state = session.submit_external_validation(accepted=payload.accepted, reason=payload.reason)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    resumed = False
    if not payload.accepted and payload.resume_on_rejection:
        resumed = run_manager.start(run_id)
    return {"run_id": run_id, "state": state.status.value, "resumed": resumed}


@router.get("/capabilities")
def capabilities():
    return [
        {
            "name": item.name,
            "risk_level": item.risk_level,
            "permissions": list(item.permissions),
            "side_effect_level": item.side_effect_level,
        }
        for item in build_builtin_registry().definitions()
    ]


@router.post("/challenges/{run_id}/pause")
def pause(run_id: str, payload: PauseIn | None = None):
    session = _session_or_404(run_id)
    if run_manager.is_running(run_id):
        raise HTTPException(409, "wait for the active tool/model turn before pausing")
    try:
        state = session.pause_for_human((payload or PauseIn()).reason)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"run_id": run_id, "state": state.status.value}


@router.post("/challenges/{run_id}/resume")
def resume(run_id: str):
    return start(run_id)


@router.post("/challenges/{run_id}/cancel")
def cancel(run_id: str):
    session = _session_or_404(run_id)
    changed = run_manager.abort(run_id, "cancelled by competition operator")
    return {"run_id": run_id, "abort_requested": changed, "state": session.state.status.value}


@router.post("/challenges/{run_id}/evidence/human")
def human_evidence(run_id: str, payload: HumanEvidenceIn):
    session = _session_or_404(run_id)
    try:
        evidence = session.record_human_evidence(payload.content)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    resumed = False
    if payload.resume and session.state.status == RunStatus.HUMAN_REQUIRED:
        session.answer_human({"evidence_id": evidence["evidence_id"]})
        resumed = run_manager.start(run_id)
    return {"run_id": run_id, "evidence": evidence, "resumed": resumed}
