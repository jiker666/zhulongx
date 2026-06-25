import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime

from app.database import Base


class Challenge(Base):
    __tablename__ = "challenges"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(256), nullable=False)
    challenge_type = Column(String(64), default="unknown")
    description = Column(Text, default="")
    target = Column(String(512), default="")
    uploaded_file = Column(String(512), default="")
    tags = Column(Text, default="[]")
    priority = Column(String(32), default="medium")
    status = Column(String(32), default="new")
    assignee = Column(String(128), default="")
    reviewer = Column(String(128), default="")
    submitter = Column(String(128), default="")
    submit_status = Column(String(32), default="not_submitted")
    submitted_answer = Column(Text, default="")
    submitted_at = Column(DateTime, nullable=True)
    submission_note = Column(Text, default="")
    notes = Column(Text, default="")
    latest_summary = Column(Text, default="")
    next_suggestion = Column(Text, default="")
    confidence = Column(String(32), default="0.0")
    runbook_json = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
