import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey

from app.database import Base


class Evidence(Base):
    __tablename__ = "evidence"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    evidence_uid = Column(String(64), nullable=False, unique=True, index=True)
    source_tool = Column(String(128), default="")
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    challenge_id = Column(Integer, ForeignKey("challenges.id"), nullable=True, index=True)
    input_summary = Column(Text, default="")
    output_excerpt = Column(Text, default="")
    content_hash = Column(String(64), default="")
    reproduction_hint = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
