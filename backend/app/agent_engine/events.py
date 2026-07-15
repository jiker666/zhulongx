from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Optional


class EventType(str, Enum):
    RUN_CREATED = "run.created"
    RUN_STARTED = "run.started"
    RUN_MODE_SELECTED = "run.mode_selected"
    MODEL_REQUESTED = "model.requested"
    MODEL_RESPONDED = "model.responded"
    PROVIDER_CAPABILITY_NEGOTIATED = "provider.capability_negotiated"
    PLAN_PROPOSED = "plan.proposed"
    PLAN_ACCEPTED = "plan.accepted"
    PLAN_NODE_STARTED = "plan.node_started"
    PLAN_NODE_BLOCKED = "plan.node_blocked"
    PLAN_REVISED = "plan.revised"
    PLAN_COMPLETED = "plan.completed"
    TASK_SCHEDULED = "task.scheduled"
    TASK_STARTED = "task.started"
    TASK_BLOCKED = "task.blocked"
    TASK_COMPLETED = "task.completed"
    AGENT_SPAWNED = "agent.spawned"
    AGENT_RESUMED = "agent.resumed"
    AGENT_CANCELLED = "agent.cancelled"
    AGENT_COMPLETED = "agent.completed"
    MAILBOX_MESSAGE = "mailbox.message"
    TOOL_REQUESTED = "tool.requested"
    POLICY_ALLOWED = "policy.allowed"
    POLICY_DENIED = "policy.denied"
    TOOL_STARTED = "tool.started"
    TOOL_FINISHED = "tool.finished"
    TOOL_FAILED = "tool.failed"
    FACT_CONFIRMED = "fact.confirmed"
    FACT_RETRACTED = "fact.retracted"
    HYPOTHESIS_PROPOSED = "hypothesis.proposed"
    HYPOTHESIS_CONFIRMED = "hypothesis.confirmed"
    HYPOTHESIS_REFUTED = "hypothesis.refuted"
    EVIDENCE_RECORDED = "evidence.recorded"
    CONTRADICTION_RECORDED = "contradiction.recorded"
    DECISION_RECORDED = "decision.recorded"
    ARTIFACT_INGESTED = "artifact.ingested"
    SKILL_LOADED = "skill.loaded"
    STATE_UPDATED = "state.updated"
    CONTEXT_COMPACTED = "context.compacted"
    CHECKPOINT_SAVED = "checkpoint.saved"
    CHECKPOINT_RESTORED = "checkpoint.restored"
    CANDIDATE_DETECTED = "candidate.detected"
    CANDIDATE_VALIDATED = "candidate.validated"
    CANDIDATE_REJECTED = "candidate.rejected"
    CANDIDATE_PENDING_EXTERNAL = "candidate.pending_external"
    CANDIDATE_EXTERNALLY_ACCEPTED = "candidate.externally_accepted"
    CANDIDATE_EXTERNALLY_REJECTED = "candidate.externally_rejected"
    VALIDATION_REQUESTED = "validation.requested"
    VALIDATION_COMPLETED = "validation.completed"
    BUDGET_WARNING = "budget.warning"
    BUDGET_EXCEEDED = "budget.exceeded"
    HUMAN_REQUESTED = "human.requested"
    HUMAN_ANSWERED = "human.answered"
    COMPLETION_DECIDED = "completion.decided"
    RUN_SUCCEEDED = "run.succeeded"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"
    RUN_TIMED_OUT = "run.timed_out"


TERMINAL_EVENT_TYPES = {
    EventType.RUN_SUCCEEDED.value,
    EventType.RUN_FAILED.value,
    EventType.RUN_CANCELLED.value,
    EventType.RUN_TIMED_OUT.value,
}

_SENSITIVE_KEY = re.compile(
    r"(?i)(api[_-]?key|(?:^|[_-])token$|secret|password|credential|authorization)"
)
_SECRET_TEXT = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}\b")


@dataclass(frozen=True)
class AgentEvent:
    event_id: str
    run_id: str
    sequence: int
    created_at: float
    type: str
    actor: str
    parent_event_id: Optional[str]
    payload: Mapping[str, Any] = field(default_factory=dict)
    redaction_metadata: Mapping[str, Any] = field(default_factory=dict)
    schema_version: int = 1
    agent_id: Optional[str] = None
    task_id: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "AgentEvent":
        values = dict(raw)
        values.setdefault("schema_version", 1)
        values.setdefault("agent_id", None)
        values.setdefault("task_id", None)
        return cls(**values)


def _redact(value: Any, path: str, redacted: list[str]) -> Any:
    if isinstance(value, Mapping):
        output: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            child_path = f"{path}.{key_text}" if path else key_text
            if _SENSITIVE_KEY.search(key_text):
                output[key_text] = "***REDACTED***"
                redacted.append(child_path)
            else:
                output[key_text] = _redact(item, child_path, redacted)
        return output
    if isinstance(value, (list, tuple)):
        return [_redact(item, f"{path}[{index}]", redacted) for index, item in enumerate(value)]
    if isinstance(value, str):
        replaced = _SECRET_TEXT.sub(lambda match: (match.group(1) if match.lastindex else "") + "***REDACTED***", value)
        if replaced != value:
            redacted.append(path)
        return replaced
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)


class AppendOnlyEventStore:
    """Thread-safe in-memory event log with optional append-only JSONL storage."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path).resolve() if path is not None else None
        self._lock = threading.Lock()
        self._events: dict[str, list[AgentEvent]] = {}
        if self.path and self.path.is_file():
            self._load()

    def _load(self) -> None:
        assert self.path is not None
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = AgentEvent.from_dict(json.loads(line))
            events = self._events.setdefault(event.run_id, [])
            expected = len(events) + 1
            if event.sequence != expected:
                raise ValueError(f"non-contiguous event sequence for {event.run_id}: {event.sequence} != {expected}")
            events.append(event)

    def append(
        self,
        run_id: str,
        event_type: EventType | str,
        *,
        actor: str,
        payload: Mapping[str, Any] | None = None,
        parent_event_id: str | None = None,
        agent_id: str | None = None,
        task_id: str | None = None,
        schema_version: int = 1,
    ) -> AgentEvent:
        type_value = event_type.value if isinstance(event_type, EventType) else str(event_type)
        with self._lock:
            events = self._events.setdefault(run_id, [])
            if type_value in TERMINAL_EVENT_TYPES:
                for existing in events:
                    if existing.type in TERMINAL_EVENT_TYPES:
                        return existing
            redacted_paths: list[str] = []
            safe_payload = _redact(payload or {}, "payload", redacted_paths)
            event = AgentEvent(
                event_id=f"evt_{uuid.uuid4().hex}",
                run_id=run_id,
                sequence=len(events) + 1,
                created_at=time.time(),
                type=type_value,
                actor=actor,
                parent_event_id=parent_event_id,
                payload=safe_payload,
                redaction_metadata={"redacted_paths": redacted_paths},
                schema_version=schema_version,
                agent_id=agent_id,
                task_id=task_id,
            )
            events.append(event)
            if self.path:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as output:
                    output.write(json.dumps(event.to_dict(), ensure_ascii=False, sort_keys=True) + "\n")
                    output.flush()
            return event

    def read(self, run_id: str, *, after_sequence: int = 0) -> list[AgentEvent]:
        with self._lock:
            return [event for event in self._events.get(run_id, []) if event.sequence > after_sequence]

    def last_sequence(self, run_id: str) -> int:
        with self._lock:
            events = self._events.get(run_id, [])
            return events[-1].sequence if events else 0
