import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict


class ChallengeCreate(BaseModel):
    name: str
    challenge_type: str = "unknown"
    description: str = ""
    target: str = ""
    uploaded_file: str = ""
    tags: List[str] = []
    priority: str = "medium"
    assignee: str = ""
    reviewer: str = ""
    submitter: str = ""
    status: str = "new"


class ChallengePatch(BaseModel):
    name: Optional[str] = None
    challenge_type: Optional[str] = None
    description: Optional[str] = None
    target: Optional[str] = None
    uploaded_file: Optional[str] = None
    tags: Optional[List[str]] = None
    priority: Optional[str] = None
    assignee: Optional[str] = None
    reviewer: Optional[str] = None
    submitter: Optional[str] = None
    status: Optional[str] = None
    submit_status: Optional[str] = None
    submitted_answer: Optional[str] = None
    submission_note: Optional[str] = None
    notes: Optional[str] = None


class SubmissionCreate(BaseModel):
    answer: str
    submitter: str
    submission_note: str = ""
    candidate_id: Optional[int] = None
    submit_status: str = "submitted"


class EvidenceOut(BaseModel):
    id: int
    evidence_uid: str
    source_tool: str
    task_id: Optional[int] = None
    challenge_id: Optional[int] = None
    input_summary: str
    output_excerpt: str
    content_hash: str
    reproduction_hint: str
    created_at: datetime.datetime

    model_config = ConfigDict(from_attributes=True)


class AnswerCandidateCreate(BaseModel):
    candidate: str
    source: str = "manual"
    evidence: str = ""
    evidence_id: str = ""
    confidence: float = 0.75
    why_selected: str = "人工录入"
    validation_status: str = "unverified"
    note: str = ""


class AnswerCandidatePatch(BaseModel):
    validation_status: Optional[str] = None
    note: Optional[str] = None
    confidence: Optional[float] = None


class AnswerCandidateOut(BaseModel):
    id: int
    challenge_id: Optional[int] = None
    task_id: Optional[int] = None
    candidate: str
    source: str
    evidence: str
    evidence_id: str
    confidence: float
    why_selected: str
    validation_status: str
    note: str
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = ConfigDict(from_attributes=True)


class ChallengeNoteCreate(BaseModel):
    author: str = ""
    note: str
    note_type: str = "manual"


class ManualResultCreate(BaseModel):
    author: str = ""
    result: str
    validation_status: str = ""
    candidate: str = ""


class ChallengeImport(BaseModel):
    format: str = "json"
    content: str = ""
    default_assignee: str = ""


class ScopeCheckRequest(BaseModel):
    url: str


class FinalOpsImportPayload(BaseModel):
    data: Dict[str, Any]


class ChallengeOut(BaseModel):
    id: int
    name: str
    challenge_type: str
    description: str
    target: str
    uploaded_file: str
    tags: List[str] = []
    priority: str
    status: str
    assignee: str
    reviewer: str
    submitter: str
    submit_status: str = "not_submitted"
    submitted_answer: str = ""
    submitted_at: Optional[datetime.datetime] = None
    submission_note: str = ""
    notes: str
    latest_summary: str
    next_suggestion: str
    confidence: str
    runbook: Dict[str, Any] = {}
    task_ids: List[int] = []
    evidence: List[EvidenceOut] = []
    answer_candidates: List[AnswerCandidateOut] = []
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = ConfigDict(from_attributes=True)
