from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable

from app.agent_engine.events import AgentEvent, EventType


@dataclass
class LegacyTaskProjection:
    """Incremental compatibility view for the existing CTF UI fields."""

    run_id: str
    after_sequence: int = 0
    state: str = "created"
    events: list[dict[str, Any]] = field(default_factory=list)
    shell_history: list[dict[str, Any]] = field(default_factory=list)
    script_runs: list[dict[str, Any]] = field(default_factory=list)
    candidate_flags: list[dict[str, Any]] = field(default_factory=list)
    best_flag: str | None = None
    current_script: str = ""

    def consume(self, source: Iterable[AgentEvent]) -> int:
        for event in sorted(source, key=lambda item: item.sequence):
            if event.run_id != self.run_id or event.sequence <= self.after_sequence:
                continue
            self._apply(event)
            self.after_sequence = event.sequence
        return self.after_sequence

    def _apply(self, event: AgentEvent) -> None:
        payload = dict(event.payload)
        payload_summary = json.dumps(payload, ensure_ascii=False, default=str)[:1000]
        self.events.append({
            "event_id": event.event_id,
            "sequence": event.sequence,
            "type": event.type,
            "step": event.type,
            "timestamp": event.created_at,
            "actor": event.actor,
            "payload": payload,
            "duration_ms": int(payload.get("duration_ms", 0) or 0),
            "input_summary": event.actor,
            "output_summary": payload_summary,
            "success": event.type not in {EventType.TOOL_FAILED.value, EventType.POLICY_DENIED.value},
            "artifacts": {"event_id": event.event_id, "parent_event_id": event.parent_event_id},
        })
        if event.type == EventType.TOOL_REQUESTED.value and event.payload.get("name") == "run_python":
            arguments = event.payload.get("arguments", {})
            if isinstance(arguments, dict):
                self.current_script = str(arguments.get("code", ""))
        if event.type in {EventType.TOOL_FINISHED.value, EventType.TOOL_FAILED.value}:
            name = str(event.payload.get("name", ""))
            output = str(event.payload.get("output", ""))
            exit_code = -1
            if output.startswith("exit_code="):
                try:
                    exit_code = int(output.splitlines()[0].split("=", 1)[1])
                except (ValueError, IndexError):
                    pass
            row = {
                "event_id": event.event_id,
                "tool_call_id": event.payload.get("tool_call_id"),
                "success": bool(event.payload.get("success", False)),
                "exit_code": exit_code,
                "stdout": output,
                "stderr": str(event.payload.get("error", "")),
                "duration_ms": int(event.payload.get("duration_ms", 0) or 0),
                "timed_out": event.payload.get("error") == "timeout",
                "workdir": "workspace",
            }
            if name in {"run_shell", "http_request"}:
                row["command"] = name
                self.shell_history.append(row)
            elif name == "run_python":
                row["run_index"] = len(self.script_runs)
                self.script_runs.append(row)
        elif event.type == EventType.CANDIDATE_DETECTED.value:
            value = str(event.payload.get("candidate", ""))
            if value and not any(item["flag"] == value for item in self.candidate_flags):
                self.candidate_flags.append({
                    "flag": value,
                    "source": "agent_session",
                    "confidence": 0.5,
                    "status": "detected",
                    "evidence_event_ids": list(event.payload.get("evidence_event_ids", [])),
                })
        elif event.type in {EventType.CANDIDATE_VALIDATED.value, EventType.CANDIDATE_REJECTED.value}:
            value = str(event.payload.get("candidate", ""))
            status = "validated" if event.type == EventType.CANDIDATE_VALIDATED.value else "rejected"
            for item in self.candidate_flags:
                if item["flag"] == value:
                    item["status"] = status
                    item["validation"] = event.payload.get("reason", "")
                    break
            if status == "validated":
                self.best_flag = value
                for item in self.candidate_flags:
                    if item["flag"] == value:
                        item["confidence"] = 1.0
        elif event.type == EventType.RUN_STARTED.value:
            self.state = "running"
        elif event.type == EventType.RUN_SUCCEEDED.value:
            self.state = "succeeded"
        elif event.type == EventType.RUN_FAILED.value:
            self.state = "failed"
        elif event.type == EventType.RUN_CANCELLED.value:
            self.state = "cancelled"
        elif event.type == EventType.RUN_TIMED_OUT.value:
            self.state = "timed_out"
        elif event.type == EventType.HUMAN_REQUESTED.value:
            self.state = "human_required"

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "after_sequence": self.after_sequence,
            "state": self.state,
            "events": self.events,
            "shell_history": self.shell_history,
            "script_runs": self.script_runs,
            "candidate_flags": self.candidate_flags,
            "best_flag": self.best_flag,
            "current_script": self.current_script,
        }
