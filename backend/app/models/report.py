import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from app.database import Base


class Report(Base):
    __tablename__ = "reports"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, unique=True, index=True)
    content = Column(Text, default="")
    file_path = Column(String(512), default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
