import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey

from app.database import Base


class ChallengeNote(Base):
    __tablename__ = "challenge_notes"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    challenge_id = Column(Integer, ForeignKey("challenges.id"), nullable=False, index=True)
    author = Column(String(128), default="")
    note = Column(Text, default="")
    note_type = Column(String(32), default="manual")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
