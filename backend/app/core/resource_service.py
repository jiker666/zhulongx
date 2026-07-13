"""Only writer for durable execution-resource lifecycle state."""
from __future__ import annotations
import datetime
import json
import uuid
from typing import Any, Dict
from app.models.competition_runtime import ExecutionResourceRecord

TERMINAL = {"CANCELLED", "COMPLETED", "FAILED", "TIMED_OUT", "LOST", "CLOSED"}
TRANSITIONS = {
    "CREATING": {"ACTIVE", "RUNNING", "FAILED", "CANCELLED", "LOST"},
    "ACTIVE": {"CANCELLING", "CANCELLED", "CLOSED", "FAILED", "TIMED_OUT", "LOST"},
    "RUNNING": {"CANCELLING", "CANCELLED", "COMPLETED", "FAILED", "TIMED_OUT", "LOST"},
    "CANCELLING": {"CANCELLED", "FAILED", "LOST"},
}

class ResourceService:
    def create(self, db, *, competition_id: str, challenge_id: str, task_id: str, resource_type: str, external_id: str, status: str, worker_id: str = "worker-base", worker_instance_id: str = "local", command_summary: str = "", cwd: str = "", metadata: Dict[str, Any] | None = None) -> ExecutionResourceRecord:
        row = ExecutionResourceRecord(id=f"res_{uuid.uuid4().hex[:20]}", competition_id=competition_id, challenge_id=challenge_id, task_id=task_id, resource_type=resource_type, external_id=external_id, worker_id=worker_id, worker_instance_id=worker_instance_id, status=status, command_summary=command_summary[:2000], cwd=cwd, metadata_json=json.dumps(metadata or {}, ensure_ascii=False))
        db.add(row); db.commit(); db.refresh(row); return row
    def transition(self, db, resource_id: str, *, task_id: str, status: str, expected_version: int | None = None, output_cursor: int | None = None, exit_code: int | None = None, lost_reason: str = "") -> ExecutionResourceRecord:
        row = db.query(ExecutionResourceRecord).filter_by(id=resource_id, task_id=task_id).one_or_none()
        if row is None: raise KeyError("resource not found for task")
        if expected_version is not None and row.version != expected_version: raise RuntimeError("resource version conflict")
        if row.status in TERMINAL:
            if row.status != status: raise RuntimeError("terminal resource state cannot be overwritten")
            return row
        if status not in TRANSITIONS.get(row.status, set()): raise ValueError(f"invalid resource transition {row.status}->{status}")
        row.status = status; row.version += 1; row.last_activity_at = datetime.datetime.utcnow()
        if output_cursor is not None: row.output_cursor = output_cursor
        if exit_code is not None: row.exit_code = exit_code
        if lost_reason: row.lost_reason = lost_reason
        if status in TERMINAL: row.completed_at = datetime.datetime.utcnow()
        db.commit(); db.refresh(row); return row

resource_service = ResourceService()
