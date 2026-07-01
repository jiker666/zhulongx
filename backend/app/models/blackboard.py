"""
Blackboard persistence models (v6) — Fact / Intent / Hint 三元组。

Tables:
- ctf_facts: 事实黑板（文件线索、候选 flag、错误、工具结果、约束）
- ctf_intents: 意图队列（待执行 / 进行中 / 完成 / 失败 / 弃用）
- ctf_hints: 人工 / Observer / 系统提示
"""
import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Float, Index

from app.database import Base


class CtfFact(Base):
    """事实黑板条目。"""
    __tablename__ = "ctf_facts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(64), index=True, nullable=False)
    fact_id = Column(String(64), index=True, nullable=False)  # 业务 id（uuid hex）
    kind = Column(String(32), index=True)  # file|clue|candidate|error|tool_result|constraint
    content = Column(Text, default="")
    confidence = Column(Float, default=0.5)
    source_step = Column(String(64), default="")
    evidence_ref = Column(String(128), nullable=True)
    created_at = Column(Float, default=0.0, index=True)

    Index("ix_ctf_facts_task_kind", "task_id", "kind")


class CtfIntent(Base):
    """意图队列条目。"""
    __tablename__ = "ctf_intents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(64), index=True, nullable=False)
    intent_id = Column(String(64), index=True, nullable=False)
    title = Column(String(256), default="")
    rationale = Column(Text, default="")
    status = Column(String(32), index=True, default="pending")  # pending|in_progress|completed|failed|deprecated
    priority = Column(Integer, default=5)
    depends_on = Column(Text, default="[]")  # JSON list of intent_id
    result_fact_ids = Column(Text, default="[]")  # JSON list of fact_id
    created_at = Column(Float, default=0.0, index=True)
    updated_at = Column(Float, default=0.0)

    Index("ix_ctf_intents_task_status", "task_id", "status")


class CtfHint(Base):
    """人工 / Observer / 系统提示。"""
    __tablename__ = "ctf_hints"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(64), index=True, nullable=False)
    hint_id = Column(String(64), index=True, nullable=False)
    content = Column(Text, default="")
    source = Column(String(32), default="system")  # human|observer|system
    consumed = Column(Integer, default=0)  # 0/1
    created_at = Column(Float, default=0.0, index=True)
