from __future__ import annotations

import tempfile
import json
import shutil
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent_engine.budget import BudgetLimits
from app.agent_engine.manager import run_manager
from app.agent_engine.managed_run import ManagedRun
from app.agent_engine.projections import CanonicalRunProjection
from app.agent_engine.service import agent_run_service
from app.agent_engine.state import ModelConfig, NetworkPolicy, RunRequest
from app.config import settings
from app.scenarios import CTFScenario, default_scenarios


router = APIRouter(prefix="/agent/runs", tags=["Agent Engine v3"])


class AgentRunCreate(BaseModel):
    task_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    objective: str = Field(min_length=1, max_length=20_000)
    scenario: str = "ctf"
    flag_pattern: str = r"flag\{[^}]+\}"
    authorized: bool = False
    allow_process: bool = False
    allow_worker: bool = False
    allow_private_network: bool = False
    allowed_hosts: list[str] = Field(default_factory=list, max_length=100)
    allowed_ports: list[int] = Field(default_factory=list, max_length=100)
    approved_tools: list[str] = Field(default_factory=list, max_length=128)
    max_seconds: float = Field(default=600, ge=1, le=3600)
    max_model_requests: int = Field(default=50, ge=1, le=500)
    max_tool_calls: int = Field(default=100, ge=1, le=1000)
    provider: str = Field(default=settings.LLM_PROVIDER, min_length=1, max_length=100)
    model: str = Field(default=settings.LLM_MODEL, min_length=1, max_length=200)
    gateway_profile: str = Field(default="default", max_length=50)
    model_profile: str = Field(default="", max_length=50)
    base_url: str = Field(default="", max_length=2000)
    temperature: float = Field(default=settings.LLM_TEMPERATURE, ge=0, le=1)
    max_tokens: int = Field(
        default=(settings.GLM_MAX_OUTPUT_TOKENS if settings.LLM_PROVIDER == "glm" else settings.LLM_MAX_TOKENS),
        ge=1,
        le=131_072,
    )
    model_timeout_seconds: float = Field(default=settings.LLM_TIMEOUT, ge=1, le=600)
    parallel_tool_calls: bool = True
    thinking_enabled: bool = settings.GLM_THINKING_ENABLED
    clear_thinking: bool = settings.GLM_CLEAR_THINKING
    reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "max", "xhigh"] = settings.GLM_REASONING_EFFORT
    stream: bool = settings.GLM_STREAM
    tool_stream: bool = settings.GLM_TOOL_STREAM
    model_connect_timeout_seconds: float = Field(default=settings.GLM_CONNECT_TIMEOUT, gt=0, le=120)
    model_read_timeout_seconds: float = Field(default=settings.GLM_READ_TIMEOUT, gt=0, le=600)
    context_budget_tokens: int = Field(default=128_000, ge=4096, le=1_000_000)
    execution_mode: Literal["auto", "coordinator", "single"] = "auto"
    orchestration_profile: Literal["conservative", "balanced", "aggressive"] = "balanced"
    autonomy_level: Literal["low", "medium", "high"] = "high"
    max_parallel_agents: int = Field(default=4, ge=1, le=16)
    max_agent_depth: int = Field(default=1, ge=1, le=4)
    human_approval_policy: Literal["always", "risk_based", "policy_only"] = "risk_based"


class HumanAnswerRequest(BaseModel):
    public_response: dict[str, object] = Field(default_factory=dict)
    secure_input_refs: list[str] = Field(default_factory=list, max_length=50)
    resume: bool = True


class ExternalValidationRequest(BaseModel):
    accepted: bool
    reason: str = Field(min_length=1, max_length=10_000)
    resume_on_rejection: bool = True


class PauseRequest(BaseModel):
    reason: str = Field(default="paused by operator", min_length=1, max_length=10_000)


class BranchControlRequest(BaseModel):
    reason: str = Field(default="operator branch control", min_length=1, max_length=10_000)


@router.post("")
def create_agent_run(payload: AgentRunCreate):
    scenarios = default_scenarios()
    try:
        scenario = scenarios.get(payload.scenario)
    except KeyError as exc:
        raise HTTPException(400, str(exc)) from exc
    if payload.scenario == "ctf":
        scenario = CTFScenario(flag_pattern=payload.flag_pattern)
    runtime_root = Path(
        settings.WORKER_SHARED_ROOT if payload.allow_worker else settings.CTF_RUN_DIR
    ).expanduser().resolve()
    runtime_root.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="agent_v3_", dir=runtime_root))
    # Rootless container engines remap bind-mount groups differently. Landlock
    # inside worker-base enforces the per-run boundary for worker workspaces.
    workspace.chmod(0o777 if payload.allow_worker else 0o700)
    network_mode = "allowlist" if payload.authorized and payload.allowed_hosts else "deny"
    request = RunRequest(
        task_id=payload.task_id,
        title=payload.title,
        objective=payload.objective,
        workspace=str(workspace),
        scenario=payload.scenario,
        authorization={
            "authorized": payload.authorized,
            "allow_process": payload.allow_process,
            "allow_worker": payload.allow_worker,
            "allow_private_network": payload.allow_private_network,
            "approved_tools": tuple(payload.approved_tools),
        },
        network_policy=NetworkPolicy(
            mode=network_mode,
            allowed_hosts=tuple(payload.allowed_hosts),
            allowed_ports=tuple(payload.allowed_ports),
        ),
        budgets=BudgetLimits(
            max_seconds=payload.max_seconds,
            max_model_requests=payload.max_model_requests,
            max_tool_calls=payload.max_tool_calls,
        ),
        model_config=ModelConfig(
            provider=payload.provider,
            model=payload.model,
            gateway_profile=payload.model_profile or payload.gateway_profile,
            base_url=payload.base_url,
            temperature=payload.temperature,
            max_tokens=payload.max_tokens,
            timeout_seconds=payload.model_timeout_seconds,
            parallel_tool_calls=payload.parallel_tool_calls,
            thinking_enabled=payload.thinking_enabled,
            clear_thinking=payload.clear_thinking,
            reasoning_effort=payload.reasoning_effort,
            stream=payload.stream,
            tool_stream=payload.tool_stream,
            connect_timeout_seconds=payload.model_connect_timeout_seconds,
            read_timeout_seconds=payload.model_read_timeout_seconds,
            context_budget_tokens=payload.context_budget_tokens,
        ),
        execution_mode=payload.execution_mode,
        orchestration_profile=payload.orchestration_profile,
        autonomy_level=payload.autonomy_level,
        max_parallel_agents=payload.max_parallel_agents,
        max_agent_depth=payload.max_agent_depth,
        human_approval_policy=payload.human_approval_policy,
    )
    try:
        session = agent_run_service.create_session(
            request,
            scenario.validator(),
            scenario_config={"flag_pattern": payload.flag_pattern, "evaluator_ref": "none"},
        )
    except ValueError as exc:
        shutil.rmtree(workspace, ignore_errors=True)
        raise HTTPException(400, str(exc)) from exc
    return {
        "run_id": session.run_id,
        "status": session.state.status.value,
        "scenario": payload.scenario,
        "workspace": str(workspace),
        "execution_mode": next(
            (
                event.payload.get("effective_mode")
                for event in session.event_stream()
                if event.type == "run.mode_selected"
            ),
            payload.execution_mode,
        ),
        "release_ready": session.sandbox.release_capable,
        "release_blocker": (
            "container runtime or preloaded sandbox image unavailable"
            if not session.sandbox.release_capable
            else ""
        ),
        "effective_config": {
            "execution_mode": payload.execution_mode,
            "orchestration_profile": payload.orchestration_profile,
            "autonomy_level": payload.autonomy_level,
            "max_parallel_agents": payload.max_parallel_agents,
            "max_agent_depth": payload.max_agent_depth,
            "provider": payload.provider,
            "model": payload.model,
            "model_profile": payload.model_profile or payload.gateway_profile,
            "reasoning_effort": payload.reasoning_effort,
            "thinking_enabled": payload.thinking_enabled,
            "clear_thinking": payload.clear_thinking,
            "stream": payload.stream,
            "tool_stream": payload.tool_stream,
            "context_budget_tokens": payload.context_budget_tokens,
            "human_approval_policy": payload.human_approval_policy,
        },
    }


def _session_or_404(run_id: str) -> ManagedRun:
    session = run_manager.get(run_id)
    if session is None:
        raise HTTPException(404, f"run not found: {run_id}")
    return session


@router.post("/{run_id}/start")
def start_agent_run(run_id: str):
    _session_or_404(run_id)
    started = run_manager.start(run_id)
    return {"run_id": run_id, "started": started, "status": run_manager.state(run_id).status.value}


@router.post("/{run_id}/stop")
def stop_agent_run(run_id: str):
    _session_or_404(run_id)
    changed = run_manager.abort(run_id)
    return {"run_id": run_id, "abort_requested": changed}


@router.post("/{run_id}/pause")
def pause_agent_run(run_id: str, payload: PauseRequest | None = None):
    session = _session_or_404(run_id)
    try:
        state = session.pause_for_human((payload or PauseRequest()).reason)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"run_id": run_id, "status": state.status.value, "paused": True}


@router.post("/{run_id}/resume")
def resume_agent_run(run_id: str):
    session = _session_or_404(run_id)
    try:
        if session.state.status.value == "human_required":
            session.answer_human({"action": "resume"})
        elif session.state.status.value != "running":
            raise ValueError("run is not resumable")
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    started = run_manager.start(run_id)
    return {"run_id": run_id, "status": session.state.status.value, "resumed": started}


@router.post("/{run_id}/branches/{task_id}/cancel")
def cancel_agent_branch(run_id: str, task_id: str, payload: BranchControlRequest | None = None):
    session = _session_or_404(run_id)
    control = getattr(session, "cancel_branch", None)
    if not callable(control):
        raise HTTPException(409, "branch control requires coordinator mode")
    try:
        result = control(task_id, (payload or BranchControlRequest()).reason)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"run_id": run_id, **result}


@router.post("/{run_id}/branches/{task_id}/retry")
def retry_agent_branch(run_id: str, task_id: str, payload: BranchControlRequest | None = None):
    session = _session_or_404(run_id)
    control = getattr(session, "retry_branch", None)
    if not callable(control):
        raise HTTPException(409, "branch control requires coordinator mode")
    try:
        result = control(task_id, (payload or BranchControlRequest()).reason)
        if session.state.status.value == "human_required":
            session.answer_human({"action": "retry_branch", "task_id": task_id})
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    started = run_manager.start(run_id)
    return {"run_id": run_id, **result, "resumed": started}


@router.post("/{run_id}/human-answer")
def answer_agent_run(run_id: str, payload: HumanAnswerRequest):
    session = _session_or_404(run_id)
    try:
        state = session.answer_human(
            payload.public_response,
            secure_input_refs=tuple(payload.secure_input_refs),
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    started = run_manager.start(run_id) if payload.resume else False
    return {"run_id": run_id, "status": state.status.value, "resumed": started}


@router.post("/{run_id}/external-validation")
def validate_agent_run(run_id: str, payload: ExternalValidationRequest):
    session = _session_or_404(run_id)
    try:
        state = session.submit_external_validation(accepted=payload.accepted, reason=payload.reason)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    started = False
    if not payload.accepted and payload.resume_on_rejection:
        started = run_manager.start(run_id)
    return {"run_id": run_id, "status": state.status.value, "resumed": started}


@router.get("/{run_id}")
def get_agent_run(run_id: str):
    session = _session_or_404(run_id)
    return {**session.state.to_dict(), "is_running": run_manager.is_running(run_id)}


@router.get("/{run_id}/events")
def get_agent_events(run_id: str, after_sequence: int = Query(default=0, ge=0)):
    session = _session_or_404(run_id)
    events = session.event_stream(after_sequence=after_sequence)
    return {
        "run_id": run_id,
        "after_sequence": after_sequence,
        "last_sequence": events[-1].sequence if events else after_sequence,
        "events": [event.to_dict() for event in events],
    }


@router.get("/{run_id}/events/stream")
def stream_agent_events(run_id: str, after_sequence: int = Query(default=0, ge=0)):
    session = _session_or_404(run_id)

    def generate():
        cursor = after_sequence
        while True:
            events = session.event_stream(after_sequence=cursor)
            for event in events:
                cursor = event.sequence
                yield f"id: {event.sequence}\nevent: {event.type}\ndata: {json.dumps(event.to_dict(), ensure_ascii=False)}\n\n"
            if not run_manager.is_running(run_id) and cursor >= session.state.last_event_sequence:
                yield f"event: stream.closed\ndata: {json.dumps({'run_id': run_id, 'last_sequence': cursor})}\n\n"
                break
            time.sleep(0.5)

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/{run_id}/projection")
def get_agent_projection(run_id: str):
    session = _session_or_404(run_id)
    projection = CanonicalRunProjection(run_id, session.request.objective)
    projection.consume(session.event_stream())
    return projection.to_dict()


@router.get("/{run_id}/workflow")
def get_agent_workflow(run_id: str):
    session = _session_or_404(run_id)
    scenario = default_scenarios().get(session.request.scenario)
    return {
        "run_id": run_id,
        "scenario": scenario.manifest().to_dict(),
        "plan": scenario.build_plan(session.request.objective).to_dict(),
        "workflow": scenario.workflow(session.request.objective).to_dict(),
    }


@router.get("/{run_id}/audit")
def get_agent_audit(run_id: str):
    session = _session_or_404(run_id)
    projection = CanonicalRunProjection(run_id, session.request.objective)
    projection.consume(session.event_stream())
    return {
        "schema_version": 1,
        "run": projection.to_dict(),
        "events": [event.to_dict() for event in session.event_stream()],
    }
