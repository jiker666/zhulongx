import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Float, Boolean, ForeignKey
from app.database import Base


class Step(Base):
    __tablename__ = "steps"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    step_index = Column(Integer, nullable=False, default=0)
    phase = Column(String(64), default="")
    action = Column(String(128), default="")
    reason = Column(Text, default="")
    tool_name = Column(String(128), default="")
    input_summary = Column(Text, default="")
    output_summary = Column(Text, default="")
    next_decision = Column(Text, default="")
    status = Column(String(32), default="success")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    # Round 2 additions
    plan_source = Column(String(32), default="rule")           # rule / llm / fallback
    risk_level = Column(String(32), default="low")             # low / medium / high
    confidence = Column(Float, default=1.0)
    requires_confirmation = Column(Boolean, default=False)
    decision_trace = Column(Text, default="")
