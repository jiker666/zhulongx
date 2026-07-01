"""
Blackboard schemas (v6) — Fact / Intent / Hint 的 Pydantic 模型。
"""
from typing import List, Optional

from pydantic import BaseModel, Field


class FactOut(BaseModel):
    fact_id: str
    task_id: str
    kind: str
    content: str
    confidence: float = 0.5
    source_step: str = ""
    evidence_ref: Optional[str] = None
    created_at: float = 0.0


class IntentOut(BaseModel):
    intent_id: str
    task_id: str
    title: str
    rationale: str = ""
    status: str = "pending"
    priority: int = 5
    depends_on: List[str] = Field(default_factory=list)
    result_fact_ids: List[str] = Field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0


class HintOut(BaseModel):
    hint_id: str
    task_id: str
    content: str
    source: str = "system"
    consumed: bool = False
    created_at: float = 0.0


class HintIn(BaseModel):
    content: str = Field(..., description="提示内容")
    source: str = Field("human", description="human|observer|system")


class IntentUpdateIn(BaseModel):
    status: Optional[str] = Field(None, description="pending|in_progress|completed|failed|deprecated")
    title: Optional[str] = None
    rationale: Optional[str] = None
    priority: Optional[int] = None
    result_fact_ids: Optional[List[str]] = None


class BlackboardSnapshot(BaseModel):
    task_id: str
    facts: List[FactOut] = Field(default_factory=list)
    intents: List[IntentOut] = Field(default_factory=list)
    hints: List[HintOut] = Field(default_factory=list)
    fact_count: int = 0
    candidate_count: int = 0
