import datetime
from pydantic import BaseModel, ConfigDict


class ReportOut(BaseModel):
    id: int
    task_id: int
    content: str
    file_path: str
    created_at: datetime.datetime

    model_config = ConfigDict(from_attributes=True)
