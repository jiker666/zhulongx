from sqlalchemy import Column, Integer, String, Text, Boolean
from app.database import Base


class Tool(Base):
    __tablename__ = "tools"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    name = Column(String(128), nullable=False, unique=True)
    description = Column(Text, default="")
    category = Column(String(64), default="general")
    enabled = Column(Boolean, default=True)
    input_schema = Column(Text, default="{}")
    output_schema = Column(Text, default="{}")
    permissions = Column(Text, default="[]")
    risk_level = Column(String(32), default="low")
    timeout_seconds = Column(Integer, default=30)
    tags = Column(Text, default="[]")
