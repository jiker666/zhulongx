"""Rebuild a challenge state from durable ordered trace records only."""
from __future__ import annotations
import json
from typing import Any, Dict
from app.core.runtime_repository import RuntimeRepository

class ReplayService:
    def __init__(self, repository: RuntimeRepository | None = None): self.repository = repository or RuntimeRepository()
    def replay_challenge(self, db, challenge_id: str, sequence: int | None = None) -> Dict[str, Any]:
        state: Dict[str, Any] = {"status": "unknown", "current_phase": "", "hypotheses": [], "selected_actions": [], "resources": [], "observations": [], "evidence": [], "candidates": [], "failure_history": [], "handoffs": [], "final_result": None}
        records = self.repository.list_trace(db, challenge_id)
        last = 0
        for row in records:
            if sequence is not None and row.sequence_number > sequence: break
            if row.sequence_number <= last: raise ValueError("non-monotonic trace sequence")
            last = row.sequence_number; payload = json.loads(row.payload_json); delta = payload.get("state_delta", {})
            if not isinstance(delta, dict): raise ValueError("corrupt state_delta")
            state.update({k: v for k, v in delta.items() if k in state or k in {"status", "workspace"}})
            state["last_event"] = payload.get("event_type", row.status); state["sequence_number"] = row.sequence_number
        return state
    def replay_task(self, db, task_id: str) -> Dict[str, Any]:
        rows = self.repository.list_records(db, task_id, "trace")
        if not rows: raise KeyError("trace not found")
        return self.replay_challenge(db, rows[0].challenge_id)
    def state_at_sequence(self, db, challenge_id: str, sequence: int) -> Dict[str, Any]: return self.replay_challenge(db, challenge_id, sequence)
    def verify_replay_consistency(self, db, challenge_id: str) -> bool:
        state = self.replay_challenge(db, challenge_id)
        return bool(state.get("sequence_number", 0))
