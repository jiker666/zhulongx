import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Float, ForeignKey

from app.database import Base


class AnswerCandidate(Base):
    __tablename__ = "answer_candidates"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    challenge_id = Column(Integer, ForeignKey("challenges.id"), nullable=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    candidate = Column(Text, default="")
    source = Column(String(256), default="")
    evidence = Column(Text, default="")
    evidence_id = Column(String(64), default="")
    confidence = Column(Float, default=0.5)
    why_selected = Column(Text, default="")
    validation_status = Column(String(32), default="unverified")
    note = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
