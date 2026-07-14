"""Single authority for converting environment output into trusted facts."""
from __future__ import annotations
import hashlib
import time
import uuid
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field

class ObservationEnvelope(BaseModel):
    observation_id: str = Field(default_factory=lambda: f"obs_{uuid.uuid4().hex[:12]}")
    competition_id: str = ""; challenge_id: str; task_id: str; action_id: str = ""; tool_call_id: str = ""
    environment_event_id: str = ""; resource_id: str = ""; session_id: str = ""; command_id: str = ""; artifact_id: str = ""
    source_type: str; source_module: str = ""; status: str = "COMPLETED"; output_hash: str = ""; raw_artifact_id: str = ""
    summary: str = ""; facts: list[Dict[str, Any]] = Field(default_factory=list); indicators: list[Dict[str, Any]] = Field(default_factory=list); errors: list[Dict[str, Any]] = Field(default_factory=list)
    trust_level: str = "MODEL_ONLY"; verified_origin: bool = False; duplicate_of: str = ""; created_at: float = Field(default_factory=time.time); metadata: Dict[str, Any] = Field(default_factory=dict)

class ObservationAuthority:
    environment_sources = {"WORKER_COMMAND_RESULT", "WORKER_PTY_OUTPUT", "TCP_CONNECT_RESULT", "TCP_SEND_RESULT", "TCP_RECEIVE_RESULT", "HTTP_RESPONSE", "FILE_ANALYSIS_RESULT", "ARTIFACT_EXTRACTION_RESULT", "TOOL_RESULT", "CHALLENGE_DATA"}
    trusted_sources = environment_sources | {"HUMAN_CONFIRMED", "HUMAN_INPUT", "VERIFIER_OUTPUT", "PLATFORM_SUBMISSION_RESULT", "WORKER_EVENT"}
    def __init__(self): self._events: Dict[str, str] = {}
    def accept(self, envelope: ObservationEnvelope, *, expected_task_id: str, expected_challenge_id: str, expected_competition_id: str = "") -> bool:
        if envelope.task_id != expected_task_id or envelope.challenge_id != expected_challenge_id: return False
        if expected_competition_id and envelope.competition_id != expected_competition_id: return False
        if envelope.source_type not in self.trusted_sources or envelope.source_type in {"MODEL_INFERENCE", "MODEL_SUMMARY"}: return False
        if envelope.status in {"CANCELLED", "FAILED", "TIMED_OUT", "LOST"}: return False
        if envelope.source_type in self.environment_sources and not (envelope.tool_call_id or envelope.environment_event_id): return False
        if envelope.environment_event_id and envelope.environment_event_id in self._events:
            envelope.duplicate_of = self._events[envelope.environment_event_id]; return False
        if not envelope.output_hash: return False
        if envelope.source_type in {"HUMAN_CONFIRMED", "HUMAN_INPUT"}: envelope.trust_level = "VERIFIED_HUMAN"
        elif envelope.source_type == "VERIFIER_OUTPUT": envelope.trust_level = "VERIFIED_VERIFIER"
        elif envelope.source_type == "PLATFORM_SUBMISSION_RESULT": envelope.trust_level = "VERIFIED_PLATFORM"
        elif envelope.source_type == "CHALLENGE_DATA": envelope.trust_level = "UNVERIFIED_CHALLENGE_DATA"
        else: envelope.trust_level = "VERIFIED_ENVIRONMENT"
        envelope.verified_origin = True
        if envelope.environment_event_id: self._events[envelope.environment_event_id] = envelope.observation_id
        return True
    def from_result(self, *, competition_id: str = "", task_id: str, challenge_id: str, action_id: str, tool_call_id: str, output: str, source_type: str = "TOOL_RESULT", source_module: str = "ToolBroker", status: str = "COMPLETED", facts: Optional[list[Dict[str, Any]]] = None, session_id: str = "", command_id: str = "", resource_id: str = "", environment_event_id: str = "") -> ObservationEnvelope:
        return ObservationEnvelope(competition_id=competition_id, task_id=task_id, challenge_id=challenge_id, action_id=action_id, tool_call_id=tool_call_id, source_type=source_type, source_module=source_module, status=status, environment_event_id=environment_event_id or tool_call_id, session_id=session_id, command_id=command_id, resource_id=resource_id, output_hash=hashlib.sha256(output.encode()).hexdigest(), summary=output[:2000], facts=facts or [])
    def from_tool_result(self, **kwargs) -> ObservationEnvelope:
        return self.from_result(**kwargs)

observation_authority = ObservationAuthority()
