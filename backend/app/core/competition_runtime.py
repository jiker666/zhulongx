"""Opt-in, evidence-grounded competition runtime.

This module deliberately coexists with the legacy CTF orchestrator.  It holds
typed decision records and delegates all registered tools through ToolBroker;
it never imports or alters the Writeup path.
"""
from __future__ import annotations

import hashlib
import http.cookiejar
import json
import os
import shutil
import socket
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import requests

from pydantic import BaseModel, Field

from app.config import settings
from app.core.flag_verifier import FlagVerifier
from app.core.scope_guard import scope_guard
from app.core.tool_registry import tool_registry


class RuntimeProfile(str, Enum):
    CTF_COMPETITION = "ctf_competition"
    PENTEST_CONTROLLED = "pentest_controlled"
    TRAINING = "training"
    BLIND_EVAL = "blind_eval"


class CompetitionProfile(BaseModel):
    profile_name: RuntimeProfile = RuntimeProfile.CTF_COMPETITION
    authorization_mode: str = "explicit_scope"
    allow_shell: bool = True
    allow_python: bool = True
    allow_network: bool = False
    allow_interactive_terminal: bool = True
    allow_tcp_session: bool = True
    allow_debugger: bool = False
    allow_browser: bool = False
    allow_auto_submission: bool = False
    max_parallel_challenges: int = Field(default_factory=lambda: settings.COMPETITION_MAX_PARALLEL_CHALLENGES, ge=1)
    max_parallel_workers_per_challenge: int = Field(default_factory=lambda: settings.COMPETITION_MAX_PARALLEL_WORKERS_PER_CHALLENGE, ge=1)
    max_model_cost: float = 0.05
    max_tool_runtime: int = Field(default_factory=lambda: settings.COMPETITION_MAX_TOOL_RUNTIME, ge=1)
    external_search_policy: str = "disabled"
    workspace_isolation: bool = True
    evidence_required: bool = True
    verifier_required: bool = True


class HypothesisStatus(str, Enum):
    PROPOSED = "proposed"; TESTING = "testing"; SUPPORTED = "supported"; WEAKENED = "weakened"; REJECTED = "rejected"; VERIFIED = "verified"; BLOCKED = "blocked"


class Hypothesis(BaseModel):
    hypothesis_id: str = Field(default_factory=lambda: f"hyp_{uuid.uuid4().hex[:12]}")
    category: str = "unknown"; title: str; description: str = ""
    status: HypothesisStatus = HypothesisStatus.PROPOSED
    confidence: float = Field(0.5, ge=0, le=1); prior_confidence: float = Field(0.5, ge=0, le=1)
    supporting_evidence_ids: List[str] = Field(default_factory=list); contradicting_evidence_ids: List[str] = Field(default_factory=list)
    required_capabilities: List[str] = Field(default_factory=list); next_experiments: List[str] = Field(default_factory=list)
    expected_observations: List[str] = Field(default_factory=list)
    estimated_cost: float = 0; estimated_time: float = 0; estimated_information_gain: float = Field(0.5, ge=0, le=1)
    failure_count: int = 0; created_by: str = "specialist"; created_at: float = Field(default_factory=time.time); updated_at: float = Field(default_factory=time.time)

    def update_evidence(self, evidence_id: str, supports: bool, confidence_delta: float, reason: str) -> None:
        self.prior_confidence = self.confidence
        bucket = self.supporting_evidence_ids if supports else self.contradicting_evidence_ids
        if evidence_id not in bucket: bucket.append(evidence_id)
        self.confidence = max(0.0, min(1.0, self.confidence + confidence_delta))
        self.status = HypothesisStatus.SUPPORTED if supports and self.confidence >= .6 else HypothesisStatus.WEAKENED if not supports else self.status
        self.updated_at = time.time()
        self.next_experiments = [reason] if reason else self.next_experiments


class ActionCandidate(BaseModel):
    action_id: str = Field(default_factory=lambda: f"act_{uuid.uuid4().hex[:12]}")
    hypothesis_id: Optional[str] = None; tool_name: str; tool_arguments: Dict[str, Any] = Field(default_factory=dict)
    purpose: str; expected_observation: str = ""
    estimated_success_probability: float = Field(.5, ge=0, le=1); estimated_information_gain: float = Field(.5, ge=0, le=1)
    estimated_time_cost: float = 1; estimated_token_cost: float = 0; estimated_tool_cost: float = 0
    risk_level: str = "low"; required_permissions: List[str] = Field(default_factory=list); prerequisites: List[str] = Field(default_factory=list)
    fallback_action: Optional[str] = None; score: float = 0; decision_reason: str = ""


class EvidenceRecord(BaseModel):
    evidence_id: str = Field(default_factory=lambda: f"ev_{uuid.uuid4().hex[:12]}")
    task_id: str; source_type: str; source_id: str = ""; tool_call_id: str = ""; artifact_id: str = ""
    content_summary: str; raw_content_hash: str; trust_level: str = "untrusted_tool_output"; created_at: float = Field(default_factory=time.time)
    supports_hypotheses: List[str] = Field(default_factory=list); contradicts_hypotheses: List[str] = Field(default_factory=list); reproducible: bool = True; metadata: Dict[str, Any] = Field(default_factory=dict)


class CandidateResult(BaseModel):
    candidate_id: str = Field(default_factory=lambda: f"cand_{uuid.uuid4().hex[:12]}")
    task_id: str; candidate_type: str = "flag"; candidate_value: str
    source_evidence_ids: List[str] = Field(default_factory=list); source_tool_call_ids: List[str] = Field(default_factory=list); reproduction_steps: List[str] = Field(default_factory=list)
    confidence: float = .5; verification_status: str = "pending"; verifier_reason: str = ""; platform_submission_status: str = "not_submitted"


class ToolResult(BaseModel):
    tool_call_id: str; tool_name: str; success: bool; status: str
    structured_output: Dict[str, Any] = Field(default_factory=dict); stdout: str = ""; stderr: str = ""; artifacts: List[str] = Field(default_factory=list); evidence_ids: List[str] = Field(default_factory=list)
    duration_ms: int = 0; exit_code: Optional[int] = None; truncated: bool = False; error_type: str = ""; error_message: str = ""; retryable: bool = False


class TaskState(BaseModel):
    task_id: str; challenge_id: str; competition_id: str; status: str = "created"; category: str = "unknown"; category_confidence: float = 0
    objective: str; scope: List[str] = Field(default_factory=list); constraints: Dict[str, Any] = Field(default_factory=dict); workspace: str = ""
    artifacts: List[str] = Field(default_factory=list); current_phase: str = "intake_task"; hypotheses: List[Hypothesis] = Field(default_factory=list)
    evidence: List[EvidenceRecord] = Field(default_factory=list); observations: List[Dict[str, Any]] = Field(default_factory=list); sessions: List[str] = Field(default_factory=list)
    candidates: List[CandidateResult] = Field(default_factory=list); budgets: Dict[str, Any] = Field(default_factory=dict); tool_capabilities: Dict[str, Any] = Field(default_factory=dict)
    failure_history: List[Dict[str, Any]] = Field(default_factory=list); decision_history: List[ActionCandidate] = Field(default_factory=list); final_result: Optional[CandidateResult] = None


class ActionScorer:
    def score(self, action: ActionCandidate, *, objective_relevance: float = 1, evidence_quality: float = 1, repetition_count: int = 0) -> float:
        risk = {"low": 1, "medium": 1.5, "high": 3}.get(action.risk_level, 3)
        score = action.estimated_information_gain * action.estimated_success_probability * objective_relevance * evidence_quality
        score /= max(.1, action.estimated_time_cost) * max(.1, 1 + action.estimated_tool_cost) * risk * (1 + repetition_count)
        action.score = round(score, 6); action.decision_reason = f"information_gain={action.estimated_information_gain}, repetition={repetition_count}, risk={action.risk_level}"
        return action.score


class BaseSpecialist:
    """Deterministic category adapter, not a prompt alias.

    Specialists propose only registered, low-risk inspection actions. The
    manager still scores and authorizes them through the broker.
    """
    category = "unknown"
    tool_whitelist = ("list_dir", "read_file")
    minimum_evidence = 1
    default_budget = {"tool_calls": 12, "seconds": 120}

    def can_handle(self, state: TaskState) -> bool: return state.category in ("auto", "unknown", self.category)
    def classify(self, state: TaskState) -> float: return 1.0 if state.category == self.category else 0.0
    def propose_hypotheses(self, state: TaskState) -> List[Hypothesis]:
        return [Hypothesis(category=self.category, title=f"Inspect {self.category} artifacts", description="Start with deterministic workspace inspection.", required_capabilities=["file"], next_experiments=["list workspace"])]
    def propose_actions(self, state: TaskState) -> List[ActionCandidate]:
        return [ActionCandidate(tool_name="list_dir", purpose=f"inventory {self.category} workspace", expected_observation="artifact inventory", estimated_information_gain=.7)]
    def normalize_observation(self, raw_result: ToolResult) -> Dict[str, Any]:
        return {"source": raw_result.tool_name, "success": raw_result.success, "summary": raw_result.structured_output or raw_result.error_message, "evidence_ids": raw_result.evidence_ids}
    def verify_progress(self, state: TaskState) -> bool: return len(state.evidence) >= self.minimum_evidence
    def detect_success(self, state: TaskState) -> bool: return bool(state.final_result and state.final_result.verification_status == "verified")
    def summarize_for_manager(self, state: TaskState) -> Dict[str, Any]: return {"category": self.category, "evidence_count": len(state.evidence), "candidate_count": len(state.candidates), "minimum_evidence": self.minimum_evidence}


class WebSpecialist(BaseSpecialist):
    category = "web"; tool_whitelist = ("http_fingerprint", "http_replay", "js_interface_extractor", "list_dir")
class PwnSpecialist(BaseSpecialist):
    category = "pwn"; tool_whitelist = ("list_dir", "read_file", "run_shell")
class ReverseSpecialist(BaseSpecialist):
    category = "reverse"; tool_whitelist = ("list_dir", "read_file", "run_shell")
class CryptoSpecialist(BaseSpecialist):
    category = "crypto"; tool_whitelist = ("list_dir", "read_file", "run_python")
class MiscSpecialist(BaseSpecialist):
    category = "misc"; tool_whitelist = ("list_dir", "read_file", "extract_archive")
class ForensicsSpecialist(BaseSpecialist):
    category = "forensics"; tool_whitelist = ("list_dir", "read_file", "log_analyzer", "artifact_triage")


SPECIALISTS: Dict[str, BaseSpecialist] = {s.category: s for s in (WebSpecialist(), PwnSpecialist(), ReverseSpecialist(), CryptoSpecialist(), MiscSpecialist(), ForensicsSpecialist())}


class ToolCapabilityRegistry:
    commands = ("file", "strings", "readelf", "objdump", "tshark", "binwalk", "gdb")
    def snapshot(self) -> Dict[str, Dict[str, Any]]:
        return {name: {"tool_name": name, "available": bool(shutil.which(name)), "executable_path": shutil.which(name) or "", "worker_type": "base-worker", "health_status": "available" if shutil.which(name) else "missing", "last_checked_at": time.time()} for name in self.commands}


class ToolBroker:
    """Only competition workflow tool dispatch point; returns auditable output."""
    def __init__(self, capabilities: Optional[ToolCapabilityRegistry] = None) -> None: self.capabilities = capabilities or ToolCapabilityRegistry()
    @staticmethod
    def _valid(schema: Dict[str, Any], args: Dict[str, Any]) -> bool:
        return all(key in args for key in schema.get("required", [])) and isinstance(args, dict)
    def execute(self, state: TaskState, action: ActionCandidate, profile: CompetitionProfile, specialist: str = "general") -> ToolResult:
        call_id = f"tc_{uuid.uuid4().hex[:12]}"; started = time.monotonic(); tool = tool_registry.get(action.tool_name)
        if any(previous.tool_name == action.tool_name and previous.tool_arguments == action.tool_arguments for previous in state.decision_history):
            return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=False, status="denied", error_type="REPEATED_ACTION", error_message="identical action already executed; choose a different experiment")
        selected = SPECIALISTS.get(specialist)
        if selected and action.tool_name not in selected.tool_whitelist:
            return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=False, status="denied", error_type="SPECIALIST_DENIED", error_message="tool is not in specialist allowlist")
        if not tool: return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=False, status="denied", error_type="TOOL_NOT_AVAILABLE", error_message="tool unavailable")
        if not self._valid(getattr(tool, "input_schema", {}), action.tool_arguments): return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=False, status="denied", error_type="INVALID_TOOL_ARGUMENT", error_message="required schema field missing")
        if action.tool_name == "run_shell" and not profile.allow_shell: return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=False, status="denied", error_type="PROFILE_DENIED", error_message="shell disabled by profile")
        if action.tool_name == "run_python" and not profile.allow_python: return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=False, status="denied", error_type="PROFILE_DENIED", error_message="python disabled by profile")
        if action.tool_name.startswith("terminal.") and not profile.allow_interactive_terminal: return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=False, status="denied", error_type="PROFILE_DENIED", error_message="interactive terminal disabled by profile")
        if any(k in action.tool_arguments for k in ("url", "target")):
            raw = str(action.tool_arguments.get("url") or action.tool_arguments.get("target")); decision = scope_guard.validate_url(raw)
            if not profile.allow_network or not decision.allowed: return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=False, status="denied", error_type="SCOPE_DENIED", error_message=decision.reason)
        context = {**action.tool_arguments, "workspace": state.workspace, "authorized": True, "allow_network": profile.allow_network, "task_id": state.task_id, "challenge_id": state.challenge_id, "competition_id": state.competition_id}
        raw = tool.safe_run(context); details = raw.get("details") or {}; stdout = str(details.get("stdout", details.get("content", ""))); stderr = str(details.get("stderr", ""))
        summary = raw.get("summary", ""); body = json.dumps({"summary": summary, "details": details}, ensure_ascii=False, default=str)
        from app.core.observation_authority import observation_authority
        # Broker is the authoritative producer for this compatibility path;
        # transport-specific sources are emitted by their dedicated adapters.
        source_type = "TOOL_RESULT"
        envelope = observation_authority.from_tool_result(competition_id=state.competition_id, task_id=state.task_id, challenge_id=state.challenge_id, action_id=action.action_id, tool_call_id=call_id, output=body, source_type=source_type, facts=[{"summary": summary[:2000]}], session_id=str(details.get("session_id", "")), command_id=str(details.get("command_id", "")), resource_id=str(details.get("session_id") or details.get("command_id") or ""), environment_event_id=f"{call_id}:{hashlib.sha256(body.encode()).hexdigest()[:12]}")
        evidence = EvidenceRecord(task_id=state.task_id, source_type="tool", source_id=action.tool_name, tool_call_id=call_id, content_summary=summary[:2000], raw_content_hash=envelope.output_hash, trust_level="VERIFIED_TOOL_OUTPUT" if raw.get("success") else "UNVERIFIED_TOOL_OUTPUT", metadata={"specialist": specialist})
        accepted = raw.get("success") and observation_authority.accept(envelope, expected_task_id=state.task_id, expected_challenge_id=state.challenge_id, expected_competition_id=state.competition_id)
        state.observations.append(envelope.model_dump())
        if accepted:
            state.evidence.append(evidence)
        # Worker resource identifiers are persisted in the task snapshot, so a
        # later cancellation/reconciliation has concrete ownership to inspect.
        session_id = details.get("session_id") if isinstance(details, dict) else None
        if raw.get("success") and action.tool_name == "terminal.create" and session_id and session_id not in state.sessions:
            state.sessions.append(session_id)
            from app.core.cancellation import cancellation_registry
            cancellation_registry.register(state.task_id, "worker_pty", session_id)
        if raw.get("success") and action.tool_name == "terminal.close" and session_id in state.sessions:
            state.sessions.remove(session_id)
            from app.core.cancellation import cancellation_registry
            cancellation_registry.release(state.task_id, "worker_pty", session_id)
        command_id = details.get("command_id") if isinstance(details, dict) else None
        if raw.get("success") and action.tool_name == "worker.command.run" and command_id:
            from app.core.cancellation import cancellation_registry
            cancellation_registry.register(state.task_id, "worker_command", command_id)
        if raw.get("success") and (session_id or command_id):
            try:
                from app.database import SessionLocal
                from app.core.resource_service import resource_service
                from app.models.competition_runtime import ExecutionResourceRecord
                db = SessionLocal(); external_id = str(session_id or command_id)
                existing = db.query(ExecutionResourceRecord).filter_by(task_id=state.task_id, external_id=external_id).one_or_none()
                if existing is None and action.tool_name in {"terminal.create", "worker.command.run"}:
                    resource_service.create(db, competition_id=state.competition_id, challenge_id=state.challenge_id, task_id=state.task_id, resource_type="PTY_SESSION" if session_id else "WORKER_COMMAND", external_id=external_id, status="ACTIVE" if session_id else "RUNNING", command_summary=str(action.tool_arguments.get("command", "")), cwd=str(action.tool_arguments.get("cwd", state.workspace)), metadata={"tool_call_id": call_id})
                elif existing and action.tool_name == "terminal.close":
                    resource_service.transition(db, existing.id, task_id=state.task_id, status="CLOSED")
                elif existing and action.tool_name == "worker.command.status" and str(details.get("status", "")) in {"COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"}:
                    resource_service.transition(db, existing.id, task_id=state.task_id, status=str(details["status"]), exit_code=details.get("exit_code"))
                db.close()
            except Exception as exc:
                state.failure_history.append({"kind": "resource_persistence_failed", "message": str(exc), "at": time.time()})
        return ToolResult(tool_call_id=call_id, tool_name=action.tool_name, success=bool(raw.get("success")), status="completed", structured_output=details, stdout=stdout[:20000], stderr=stderr[:5000], evidence_ids=[evidence.evidence_id], duration_ms=int((time.monotonic()-started)*1000), exit_code=details.get("exit_code"), error_message="" if raw.get("success") else summary, retryable=not raw.get("success"))


class IndependentVerifier:
    def verify(self, state: TaskState, candidate: CandidateResult, flag_format: Optional[str] = None) -> CandidateResult:
        if not candidate.source_evidence_ids: candidate.verification_status = "rejected"; candidate.verifier_reason = "evidence is required"; return candidate
        verifier = FlagVerifier(custom_patterns=[flag_format] if flag_format else None)
        valid_format = any(item.flag == candidate.candidate_value for item in verifier.extract_from_text(candidate.candidate_value, "candidate"))
        if not valid_format: candidate.verification_status = "rejected"; candidate.verifier_reason = "candidate does not match flag format"; return candidate
        if not candidate.reproduction_steps: candidate.verification_status = "needs_reproduction"; candidate.verifier_reason = "reproduction steps are required"; return candidate
        candidate.verification_status = "verified"; candidate.verifier_reason = "format, evidence reference, and reproduction metadata passed"; return candidate


@dataclass
class _HttpSession:
    task_id: str
    client: requests.Session = field(default_factory=requests.Session)

class InteractiveSessionManager:
    def __init__(self) -> None: self._tcp: Dict[str, tuple[str, socket.socket]] = {}; self._http: Dict[str, _HttpSession] = {}
    def http_create(self, task_id: str) -> str:
        sid = f"http_{uuid.uuid4().hex[:12]}"; self._http[sid] = _HttpSession(task_id); return sid
    def http_export(self, task_id: str, session_id: str) -> Dict[str, str]:
        session = self._http.get(session_id)
        if not session or session.task_id != task_id: raise PermissionError("session not found for task")
        return session.client.cookies.get_dict()
    def http_request(self, task_id: str, session_id: str, method: str, url: str, *, headers: Optional[Dict[str, str]] = None, body: Optional[str] = None, timeout: float = 10) -> Dict[str, Any]:
        session = self._http.get(session_id)
        if not session or session.task_id != task_id: raise PermissionError("session not found for task")
        decision = scope_guard.validate_url(url)
        if not decision.allowed: raise PermissionError(decision.reason)
        response = session.client.request(method=method.upper(), url=decision.normalized_url, headers=headers or {}, data=body, timeout=timeout, allow_redirects=False)
        return {"status_code": response.status_code, "headers": dict(response.headers), "body": response.text[:20000], "cookies": session.client.cookies.get_dict()}
    def tcp_connect(self, task_id: str, host: str, port: int, timeout: float = 5) -> str:
        decision = scope_guard.validate_url(f"http://{host}:{port}")
        if not decision.allowed: raise PermissionError(decision.reason)
        sock = socket.create_connection((host, port), timeout=timeout); sid = f"tcp_{uuid.uuid4().hex[:12]}"; self._tcp[sid] = (task_id, sock); return sid
    def tcp_send(self, task_id: str, session_id: str, data: str) -> None:
        owned = self._tcp.get(session_id)
        if not owned or owned[0] != task_id: raise PermissionError("session not found for task")
        owned[1].sendall(data.encode())
    def tcp_receive(self, task_id: str, session_id: str, limit: int = 8192) -> str:
        owned = self._tcp.get(session_id)
        if not owned or owned[0] != task_id: raise PermissionError("session not found for task")
        return owned[1].recv(limit).decode(errors="replace")
    def close(self, task_id: str, session_id: str) -> None:
        owned = self._tcp.pop(session_id, None)
        if owned:
            if owned[0] != task_id: self._tcp[session_id] = owned; raise PermissionError("session not found for task")
            owned[1].close()
        session = self._http.pop(session_id, None)
        if session:
            if session.task_id != task_id: self._http[session_id] = session; raise PermissionError("session not found for task")
            session.client.close()
    def close_task(self, task_id: str) -> None:
        for sid, owned in list(self._tcp.items()):
            if owned[0] == task_id: self.close(task_id, sid)
        for sid, session in list(self._http.items()):
            if session.task_id == task_id: self.close(task_id, sid)


class CompetitionController:
    def __init__(self) -> None: self.states: Dict[str, TaskState] = {}; self.profile = CompetitionProfile(); self.broker = ToolBroker(); self.scorer = ActionScorer(); self.verifier = IndependentVerifier()
    @staticmethod
    def _persist(state: TaskState) -> None:
        try:
            from app.database import SessionLocal
            from app.core.competition_repository import CompetitionRepository
            db = SessionLocal(); CompetitionRepository().save(db, state); db.close()
        except Exception:
            # Runtime remains usable when DB is unavailable; API reports state
            # but does not claim restart durability.
            return
    @staticmethod
    def _trace(state: TaskState, event_type: str, delta: Dict[str, Any]) -> None:
        try:
            from app.database import SessionLocal
            from app.core.runtime_repository import RuntimeRepository
            db = SessionLocal(); RuntimeRepository().append_trace(db, competition_id=state.competition_id, challenge_id=state.challenge_id, task_id=state.task_id, event_type=event_type, state_delta=delta); db.close()
        except Exception:
            return
    def reload(self) -> None:
        try:
            from app.database import SessionLocal
            from app.core.competition_repository import CompetitionRepository
            db = SessionLocal(); self.states = {state.task_id: state for state in CompetitionRepository().list(db)}; db.close()
        except Exception:
            return
    def create_challenge(self, competition_id: str, challenge_id: str, objective: str, *, scope: Optional[List[str]] = None, category: str = "unknown") -> TaskState:
        task_id = f"cmp_{uuid.uuid4().hex[:12]}"; workspace = Path(settings.COMPETITION_WORKSPACE_ROOT) / task_id; workspace.mkdir(parents=True, exist_ok=True)
        state = TaskState(task_id=task_id, challenge_id=challenge_id, competition_id=competition_id, objective=objective, category=category, scope=scope or [], workspace=str(workspace), tool_capabilities=self.broker.capabilities.snapshot(), budgets={"max_model_cost": self.profile.max_model_cost, "max_tool_runtime": self.profile.max_tool_runtime})
        self.states[task_id] = state; self._persist(state); self._trace(state, "task_created", {"status": state.status, "workspace": state.workspace}); return state
    def rank(self) -> List[TaskState]: return sorted(self.states.values(), key=lambda s: (s.category_confidence, -len(s.failure_history)), reverse=True)
    def pause(self, task_id: str) -> TaskState:
        state = self.states[task_id]
        if state.status not in {"cancelled", "completed"}: state.status = "paused"
        self._persist(state); self._trace(state, "task_paused", {"status": state.status}); return state
    def resume(self, task_id: str) -> TaskState:
        state = self.states[task_id]
        if state.status == "paused": state.status = "running"
        self._persist(state); self._trace(state, "task_resumed", {"status": state.status}); return state
    def cancel(self, task_id: str) -> TaskState:
        state = self.states[task_id]
        session_manager.close_task(task_id)
        # Local TCP/HTTP resources and Worker PTY/commands have independent
        # lifecycles.  Worker cancellation is task-scoped and idempotent.
        try:
            from app.core.worker_client import WorkerClient
            from app.core.cancellation import cancellation_registry
            cancellation_registry.request(task_id)
            client = WorkerClient()
            client.sync(client.cancel_task(task_id))
            state.sessions.clear()
        except Exception as exc:
            state.failure_history.append({"kind": "worker_cleanup_pending", "message": str(exc), "at": time.time()})
        state.status = "cancelled"; self._persist(state); self._trace(state, "task_cancelled", {"status": state.status, "resources": []}); return state
    def add_human_evidence(self, task_id: str, content: str) -> EvidenceRecord:
        state = self.states[task_id]; digest = hashlib.sha256(content.encode()).hexdigest()
        evidence = EvidenceRecord(task_id=task_id, source_type="human", source_id="human_intervention", content_summary=content[:2000], raw_content_hash=digest, trust_level="user_intent")
        state.evidence.append(evidence)
        for hypothesis in state.hypotheses:
            if hypothesis.status in {HypothesisStatus.PROPOSED, HypothesisStatus.TESTING}: hypothesis.update_evidence(evidence.evidence_id, True, .05, "re-evaluate after human evidence")
        self._persist(state); self._trace(state, "human_intervention", {"evidence_id": evidence.evidence_id}); return evidence

    def legacy_state(self, task_id: str, workspace: str, *, objective: str = "legacy agent tool call") -> TaskState:
        """Compatibility adapter: legacy callers still use the single Broker."""
        state = self.states.get(task_id)
        if state is None:
            state = TaskState(task_id=task_id, challenge_id=task_id, competition_id="legacy", objective=objective, workspace=workspace)
            self.states[task_id] = state
        state.workspace = workspace
        return state

    def execute_legacy_tool(self, task_id: str, workspace: str, tool_name: str, arguments: Dict[str, Any], *, allow_network: bool = False) -> ToolResult:
        state = self.legacy_state(task_id, workspace)
        profile = self.profile.model_copy(update={"allow_network": allow_network})
        action = ActionCandidate(tool_name=tool_name, tool_arguments=arguments, purpose="legacy runtime compatibility")
        result = self.broker.execute(state, action, profile)
        if result.status == "completed": state.decision_history.append(action)
        state.observations.append(result.model_dump())
        self._trace(state, "action_completed" if result.success else "action_failed", {"action": action.model_dump(), "tool_result": result.model_dump(exclude={"stdout", "stderr"})})
        return result


competition_controller = CompetitionController()
session_manager = InteractiveSessionManager()
