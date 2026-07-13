"""Durable source-of-truth records for runtime state, without Writeup coupling."""
from __future__ import annotations
import json
import time
import uuid
from typing import Any, Dict, List
from sqlalchemy import func
from app.models.competition_runtime import RuntimeRecord

class RuntimeRepository:
    def append(self, db, record_type: str, *, competition_id: str, challenge_id: str, task_id: str, payload: Dict[str, Any], status: str = "") -> RuntimeRecord:
        next_sequence = (db.query(func.max(RuntimeRecord.sequence_number)).filter_by(challenge_id=challenge_id).scalar() or 0) + 1
        row = RuntimeRecord(id=f"rr_{uuid.uuid4().hex[:20]}", record_type=record_type, competition_id=competition_id, challenge_id=challenge_id, task_id=task_id, sequence_number=next_sequence, status=status, payload_json=json.dumps(payload, ensure_ascii=False, default=str))
        db.add(row); db.commit(); db.refresh(row); return row
    def list_trace(self, db, challenge_id: str) -> List[RuntimeRecord]:
        return db.query(RuntimeRecord).filter_by(challenge_id=challenge_id, record_type="trace").order_by(RuntimeRecord.sequence_number).all()
    def list_records(self, db, task_id: str, record_type: str = "") -> List[RuntimeRecord]:
        q = db.query(RuntimeRecord).filter_by(task_id=task_id)
        if record_type: q = q.filter_by(record_type=record_type)
        return q.order_by(RuntimeRecord.sequence_number).all()
    def append_trace(self, db, *, competition_id: str, challenge_id: str, task_id: str, event_type: str, state_delta: Dict[str, Any], metadata: Dict[str, Any] | None = None) -> RuntimeRecord:
        return self.append(db, "trace", competition_id=competition_id, challenge_id=challenge_id, task_id=task_id, status=event_type, payload={"event_type": event_type, "state_delta": state_delta, "metadata": metadata or {}, "created_at": time.time()})
