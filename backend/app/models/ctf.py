"""
CTF task persistence models.

Tables:
- ctf_tasks: 任务主表（状态、计划、当前脚本、best_flag 等）
- ctf_events: 事件流（每一步 evidence）
- ctf_artifacts: 脚本执行结果（stdout/stderr/exit_code）
- ctf_flags: 候选 flag（含置信度、来源）
"""
import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, Float, Index

from app.database import Base


class CtfTask(Base):
    __tablename__ = "ctf_tasks"

    task_id = Column(String(64), primary_key=True, index=True)
    title = Column(String(256), nullable=False, default="")
    description = Column(Text, default="")
    category_hint = Column(String(32), default="auto")
    flag_format = Column(String(256), nullable=True)
    authorized = Column(Boolean, default=False)
    allow_network = Column(Boolean, default=False)
    allowed_hosts = Column(Text, default="[]")
    allowed_ports = Column(Text, default="[]")
    max_rounds = Column(Integer, default=8)
    max_time_sec = Column(Integer, default=600)

    attachments = Column(Text, default="[]")  # JSON list

    state = Column(String(32), default="INIT", index=True)
    rounds_used = Column(Integer, default=0)
    plan_json = Column(Text, default="")  # JSON
    analysis_json = Column(Text, default="")
    current_script = Column(Text, default="")
    best_flag = Column(String(256), nullable=True)
    writeup_path = Column(String(512), default="")
    writeup_md = Column(Text, default="")
    error = Column(Text, default="")

    # 异步执行状态
    is_running = Column(Boolean, default=False)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    # 元数据（来源 / 是否 demo / 是否 LLM）
    source = Column(String(32), default="api")  # api / demo / llm_smoke
    demo_id = Column(String(64), nullable=True)
    expected_flag = Column(String(256), nullable=True)  # 仅 benchmark 用，不允许 orchestrator 读
    engine = Column(String(32), default="legacy")
    agent_run_id = Column(String(96), nullable=True, index=True)
    agent_workspace = Column(String(1024), nullable=True)


class CtfEvent(Base):
    __tablename__ = "ctf_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(64), index=True, nullable=False)
    step = Column(String(64), index=True)
    timestamp = Column(Float, default=0.0)
    duration_ms = Column(Integer, default=0)
    input_summary = Column(Text, default="")
    output_summary = Column(Text, default="")
    success = Column(Boolean, default=True)
    artifacts_json = Column(Text, default="{}")

    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    Index("ix_ctf_events_task_step", "task_id", "step")


class CtfArtifact(Base):
    """脚本运行结果（每次 RUN_SCRIPT 一行）"""
    __tablename__ = "ctf_artifacts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(64), index=True, nullable=False)
    run_index = Column(Integer, default=0)
    success = Column(Boolean, default=False)
    exit_code = Column(Integer, default=0)
    stdout = Column(Text, default="")
    stderr = Column(Text, default="")
    duration_ms = Column(Integer, default=0)
    timed_out = Column(Boolean, default=False)
    workdir = Column(String(512), default="")
    error = Column(String(256), nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class CtfFlag(Base):
    """候选 flag"""
    __tablename__ = "ctf_flags"

    id = Column(Integer, primary_key=True, autoincrement=True)
    task_id = Column(String(64), index=True, nullable=False)
    flag = Column(String(256), nullable=False)
    source = Column(String(256), default="")
    line = Column(Integer, nullable=True)
    snippet = Column(Text, default="")
    confidence = Column(Float, default=0.5)
    matched_pattern = Column(String(128), nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    Index("ix_ctf_flags_task", "task_id")
