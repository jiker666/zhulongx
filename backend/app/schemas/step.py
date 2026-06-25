import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict


class StepOut(BaseModel):
    id: int
    task_id: int
    step_index: int
    phase: str
    action: str
    reason: str
    tool_name: str
    input_summary: str
    output_summary: str
    next_decision: str
    status: str
    created_at: datetime.datetime
    # Round 2
    plan_source: Optional[str] = "rule"
    risk_level: Optional[str] = "low"
    confidence: Optional[float] = 1.0
    requires_confirmation: Optional[bool] = False
    decision_trace: Optional[str] = ""

    model_config = ConfigDict(from_attributes=True)
