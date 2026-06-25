import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, ForeignKey
from app.database import Base


class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    title = Column(String(256), nullable=False)
    description = Column(Text, default="")
    task_type = Column(String(64), nullable=False, default="auto")
    target = Column(String(512), default="")
    status = Column(String(32), default="created")
    uploaded_file = Column(String(512), default="")
    challenge_id = Column(Integer, ForeignKey("challenges.id"), nullable=True, index=True)
    intent_result = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    # Round 2 additions
    plan_source = Column(String(32), default="rule")   # rule / llm / fallback
    llm_enabled = Column(Boolean, default=False)
    llm_model = Column(String(128), default="")
