"""Additive persistence for the opt-in competition runtime."""
import datetime
from sqlalchemy import Column, DateTime, Integer, String, Text, UniqueConstraint, Index
from app.database import Base

class CompetitionSnapshot(Base):
    __tablename__ = "competition_runtime_snapshots"
    task_id = Column(String(64), primary_key=True, index=True)
    competition_id = Column(String(64), nullable=False, index=True)
    challenge_id = Column(String(64), nullable=False, index=True)
    state_json = Column(Text, nullable=False, default="{}")
    version = Column(Integer, nullable=False, default=1)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

class RuntimeRecord(Base):
    """Additive durable event store; JSON payloads preserve forward compatibility."""
    __tablename__ = "competition_runtime_records"
    id = Column(String(64), primary_key=True)
    record_type = Column(String(32), nullable=False, index=True)
    competition_id = Column(String(64), nullable=False, index=True)
    challenge_id = Column(String(64), nullable=False, index=True)
    task_id = Column(String(64), nullable=False, index=True)
    sequence_number = Column(Integer, nullable=False, default=0)
    status = Column(String(32), nullable=False, default="")
    payload_json = Column(Text, nullable=False, default="{}")
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)

class ExecutionResourceRecord(Base):
    __tablename__ = "competition_execution_resources"
    __table_args__ = (UniqueConstraint("worker_instance_id", "external_id", "resource_type", name="uq_runtime_resource_external"),)
    id = Column(String(64), primary_key=True)
    competition_id = Column(String(64), nullable=False, index=True)
    challenge_id = Column(String(64), nullable=False, index=True)
    task_id = Column(String(64), nullable=False, index=True)
    resource_type = Column(String(32), nullable=False)
    external_id = Column(String(128), nullable=False)
    worker_id = Column(String(64), nullable=False, default="")
    worker_instance_id = Column(String(128), nullable=False, default="local")
    status = Column(String(32), nullable=False, default="CREATING")
    command_summary = Column(Text, nullable=False, default="")
    cwd = Column(String(1024), nullable=False, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_activity_at = Column(DateTime, default=datetime.datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    output_cursor = Column(Integer, nullable=False, default=0)
    exit_code = Column(Integer, nullable=True)
    lost_reason = Column(Text, nullable=False, default="")
    metadata_json = Column(Text, nullable=False, default="{}")
    version = Column(Integer, nullable=False, default=1)

class CandidateRecord(Base):
    __tablename__ = "competition_candidates"
    __table_args__ = (UniqueConstraint("challenge_id", "candidate_type", "value_hash", name="uq_runtime_candidate_hash"),)
    id = Column(String(64), primary_key=True)
    competition_id = Column(String(64), nullable=False, index=True)
    challenge_id = Column(String(64), nullable=False, index=True)
    task_id = Column(String(64), nullable=False, index=True)
    candidate_type = Column(String(32), nullable=False, default="flag")
    value_hash = Column(String(64), nullable=False)
    protected_value = Column(Text, nullable=False)
    status = Column(String(32), nullable=False, default="DISCOVERED")
    source_observation_ids_json = Column(Text, nullable=False, default="[]")
    source_evidence_ids_json = Column(Text, nullable=False, default="[]")
    reproduction_plan_json = Column(Text, nullable=False, default="[]")
    reproduction_result_json = Column(Text, nullable=False, default="{}")
    verification_status = Column(String(32), nullable=False, default="PENDING")
    platform_status = Column(String(32), nullable=False, default="NOT_SUBMITTED")
    submission_attempts = Column(Integer, nullable=False, default=0)
    last_submitted_at = Column(DateTime, nullable=True)
    rejection_reason = Column(Text, nullable=False, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
    version = Column(Integer, nullable=False, default=1)

class VerificationRecord(Base):
    __tablename__ = "competition_verifications"
    id = Column(String(64), primary_key=True)
    candidate_id = Column(String(64), nullable=False, index=True)
    verification_stage = Column(String(32), nullable=False)
    verifier_type = Column(String(64), nullable=False, default="deterministic")
    verifier_model = Column(String(128), nullable=False, default="")
    status = Column(String(32), nullable=False)
    reason = Column(Text, nullable=False, default="")
    input_evidence_ids_json = Column(Text, nullable=False, default="[]")
    reproduction_tool_call_ids_json = Column(Text, nullable=False, default="[]")
    output_observation_ids_json = Column(Text, nullable=False, default="[]")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

Index("ix_runtime_records_challenge_sequence", RuntimeRecord.challenge_id, RuntimeRecord.sequence_number, unique=True)
Index("ix_runtime_records_task_type", RuntimeRecord.task_id, RuntimeRecord.record_type)
