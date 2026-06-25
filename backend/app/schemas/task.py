import datetime
from typing import Optional
from pydantic import BaseModel, ConfigDict


class TaskCreate(BaseModel):
    title: str
    description: str = ""
    task_type: str = "auto"
    target: str = ""
    uploaded_file: str = ""
    challenge_id: Optional[int] = None


class TaskOut(BaseModel):
    id: int
    title: str
    description: str
    task_type: str
    target: str
    status: str
    uploaded_file: str
    challenge_id: Optional[int] = None
    intent_result: Optional[str] = ""
    report_status: Optional[str] = "missing"
    created_at: datetime.datetime
    updated_at: datetime.datetime
    # Round 2
    plan_source: Optional[str] = "rule"
    llm_enabled: Optional[bool] = False
    llm_model: Optional[str] = ""

    model_config = ConfigDict(from_attributes=True)
