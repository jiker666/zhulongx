from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.core.competition_runtime import ActionCandidate, CandidateResult, CompetitionProfile, Hypothesis, competition_controller, session_manager

router = APIRouter(prefix="/competition", tags=["competition"])
class CreateChallenge(BaseModel): competition_id: str; challenge_id: str; objective: str; scope: List[str] = []; category: str = "unknown"
class ExecuteAction(BaseModel): action: ActionCandidate; specialist: str = "general"
class CandidateIn(BaseModel): candidate: CandidateResult; flag_format: Optional[str] = None
class HttpRequestIn(BaseModel): method: str = "GET"; url: str; headers: Dict[str, str] = {}; body: Optional[str] = None
class HumanEvidenceIn(BaseModel): content: str

def _state(task_id: str):
    competition_controller.reload()
    state = competition_controller.states.get(task_id)
    if not state: raise HTTPException(404, "competition task not found")
    return state
@router.get("/profiles")
def profiles(): return [p.value for p in competition_controller.profile.profile_name.__class__]
@router.get("/profile")
def profile(): return competition_controller.profile
@router.put("/profile")
def update_profile(profile: CompetitionProfile): competition_controller.profile = profile; return profile
@router.post("/challenges")
def create_challenge(payload: CreateChallenge): return competition_controller.create_challenge(**payload.model_dump())
@router.get("/challenges")
def list_challenges(): return competition_controller.rank()
@router.get("/challenges/{task_id}")
def get_challenge(task_id: str): return _state(task_id)
@router.post("/challenges/{task_id}/hypotheses")
def add_hypothesis(task_id: str, hypothesis: Hypothesis):
    state = _state(task_id); state.hypotheses.append(hypothesis); competition_controller._persist(state); return hypothesis
@router.post("/challenges/{task_id}/actions/score")
def score_action(task_id: str, action: ActionCandidate):
    state = _state(task_id); repetitions = sum(1 for prior in state.decision_history if prior.tool_name == action.tool_name and prior.tool_arguments == action.tool_arguments); competition_controller.scorer.score(action, repetition_count=repetitions); return action
@router.post("/challenges/{task_id}/actions/execute")
def execute_action(task_id: str, payload: ExecuteAction):
    state = _state(task_id); result = competition_controller.broker.execute(state, payload.action, competition_controller.profile, payload.specialist)
    if result.status == "completed": state.decision_history.append(payload.action)
    state.observations.append(result.model_dump()); competition_controller._persist(state); return result
@router.post("/challenges/{task_id}/candidates/verify")
def verify_candidate(task_id: str, payload: CandidateIn):
    state = _state(task_id); checked = competition_controller.verifier.verify(state, payload.candidate, payload.flag_format); state.candidates.append(checked); state.final_result = checked if checked.verification_status == "verified" else state.final_result; competition_controller._persist(state); return checked
@router.get("/capabilities")
def capabilities(): return competition_controller.broker.capabilities.snapshot()
@router.post("/challenges/{task_id}/sessions/http")
def http_session(task_id: str): _state(task_id); return {"session_id": session_manager.http_create(task_id)}
@router.post("/challenges/{task_id}/sessions/{session_id}/http-request")
def http_request(task_id: str, session_id: str, payload: HttpRequestIn): return session_manager.http_request(task_id, session_id, payload.method, payload.url, headers=payload.headers, body=payload.body)
@router.get("/challenges/{task_id}/sessions/{session_id}/http-export")
def http_export(task_id: str, session_id: str): return {"cookies": session_manager.http_export(task_id, session_id)}
@router.post("/challenges/{task_id}/pause")
def pause(task_id: str): return competition_controller.pause(task_id)
@router.post("/challenges/{task_id}/resume")
def resume(task_id: str): return competition_controller.resume(task_id)
@router.post("/challenges/{task_id}/cancel")
def cancel(task_id: str): return competition_controller.cancel(task_id)
@router.post("/challenges/{task_id}/evidence/human")
def human_evidence(task_id: str, payload: HumanEvidenceIn): return competition_controller.add_human_evidence(task_id, payload.content)
