"""Repository for competition snapshots; additive and SQLite-compatible."""
from __future__ import annotations
import json
import datetime
from typing import Optional
from sqlalchemy.orm import Session
from app.models.competition_runtime import CompetitionSnapshot
from app.core.competition_runtime import TaskState

class CompetitionRepository:
    def save(self, db: Session, state: TaskState) -> CompetitionSnapshot:
        row = db.get(CompetitionSnapshot, state.task_id)
        if row is None:
            row = CompetitionSnapshot(task_id=state.task_id, competition_id=state.competition_id, challenge_id=state.challenge_id, state_json=state.model_dump_json(), version=1)
            db.add(row)
        else:
            row.state_json = state.model_dump_json(); row.version += 1; row.updated_at = datetime.datetime.utcnow()
        db.commit(); db.refresh(row); return row
    def load(self, db: Session, task_id: str) -> Optional[TaskState]:
        row = db.get(CompetitionSnapshot, task_id)
        return TaskState.model_validate_json(row.state_json) if row else None
    def list(self, db: Session):
        return [TaskState.model_validate_json(row.state_json) for row in db.query(CompetitionSnapshot).order_by(CompetitionSnapshot.updated_at.desc()).all()]
    def mark_sessions_lost(self, db: Session) -> int:
        changed = 0
        for row in db.query(CompetitionSnapshot).all():
            state = TaskState.model_validate_json(row.state_json)
            if state.sessions and state.status in {"running", "created", "paused"}:
                state.sessions = []; state.status = "interrupted"; row.state_json = state.model_dump_json(); row.version += 1; changed += 1
        db.commit(); return changed
