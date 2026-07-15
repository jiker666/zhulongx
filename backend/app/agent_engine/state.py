from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Mapping, Optional

from app.agent_engine.budget import BudgetLimits


class RunStatus(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"
    HUMAN_REQUIRED = "human_required"
    PENDING_EXTERNAL = "pending_external"


TERMINAL_STATUSES = {
    RunStatus.SUCCEEDED,
    RunStatus.FAILED,
    RunStatus.TIMED_OUT,
    RunStatus.CANCELLED,
    RunStatus.HUMAN_REQUIRED,
}

PAUSED_STATUSES = {RunStatus.HUMAN_REQUIRED, RunStatus.PENDING_EXTERNAL}


@dataclass(frozen=True)
class InputReference:
    name: str
    path: str
    media_type: str = "application/octet-stream"
    readonly: bool = True


@dataclass(frozen=True)
class NetworkPolicy:
    mode: str = "deny"
    allowed_hosts: tuple[str, ...] = ()
    allowed_ports: tuple[int, ...] = ()


@dataclass(frozen=True)
class ModelConfig:
    provider: str = "mock"
    model: str = "scripted"
    gateway_profile: str = "default"
    base_url: str = ""
    temperature: float = 0.0
    max_tokens: int = 4096
    timeout_seconds: float = 60.0
    parallel_tool_calls: bool = True
    cheap_model: str = ""
    expert_model: str = ""
    reviewer_model: str = ""
    degradation_policy: str = "fail_visible"
    thinking_enabled: bool = True
    clear_thinking: bool = False
    reasoning_effort: str = "max"
    stream: bool = True
    tool_stream: bool = True
    connect_timeout_seconds: float = 10.0
    read_timeout_seconds: float = 120.0


@dataclass(frozen=True)
class RunRequest:
    task_id: str
    title: str
    objective: str
    workspace: str
    inputs: tuple[InputReference, ...] = ()
    scenario: str = "ctf"
    authorization: Mapping[str, Any] = field(default_factory=dict)
    network_policy: NetworkPolicy = field(default_factory=NetworkPolicy)
    budgets: BudgetLimits = field(default_factory=BudgetLimits)
    model_config: ModelConfig = field(default_factory=ModelConfig)
    execution_mode: str = "auto"
    orchestration_profile: str = "balanced"
    autonomy_level: str = "high"
    max_parallel_agents: int = 4
    max_agent_depth: int = 1

    def __post_init__(self) -> None:
        if self.execution_mode not in {"auto", "coordinator", "single"}:
            raise ValueError(f"unknown execution mode: {self.execution_mode}")
        if self.orchestration_profile not in {"conservative", "balanced", "aggressive"}:
            raise ValueError(f"unknown orchestration profile: {self.orchestration_profile}")
        if self.autonomy_level not in {"low", "medium", "high"}:
            raise ValueError(f"unknown autonomy level: {self.autonomy_level}")
        if not 1 <= self.max_parallel_agents <= 16:
            raise ValueError("max_parallel_agents must be between 1 and 16")
        if not 1 <= self.max_agent_depth <= 4:
            raise ValueError("max_agent_depth must be between 1 and 4")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "RunRequest":
        values = dict(raw)
        values["inputs"] = tuple(InputReference(**dict(item)) for item in values.get("inputs", ()))
        network = dict(values.get("network_policy", {}))
        network["allowed_hosts"] = tuple(network.get("allowed_hosts", ()))
        network["allowed_ports"] = tuple(int(port) for port in network.get("allowed_ports", ()))
        values["network_policy"] = NetworkPolicy(**network)
        values["budgets"] = BudgetLimits(**dict(values.get("budgets", {})))
        values["model_config"] = ModelConfig(**dict(values.get("model_config", {})))
        values["authorization"] = dict(values.get("authorization", {}))
        return cls(**values)


@dataclass
class SessionState:
    run_id: str
    objective: str
    status: RunStatus = RunStatus.CREATED
    current_plan: dict[str, Any] = field(default_factory=dict)
    plan_history: list[dict[str, Any]] = field(default_factory=list)
    tasks: list[dict[str, Any]] = field(default_factory=list)
    agents: list[dict[str, Any]] = field(default_factory=list)
    confirmed_facts: list[dict[str, Any]] = field(default_factory=list)
    open_hypotheses: list[dict[str, Any]] = field(default_factory=list)
    failed_hypotheses: list[dict[str, Any]] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    contradictions: list[dict[str, Any]] = field(default_factory=list)
    decisions: list[dict[str, Any]] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    important_tool_results: list[dict[str, Any]] = field(default_factory=list)
    candidate_answers: list[dict[str, Any]] = field(default_factory=list)
    budget_usage: dict[str, Any] = field(default_factory=dict)
    last_event_sequence: int = 0
    final_output: Optional[dict[str, Any]] = None
    human_handoff: Optional[dict[str, Any]] = None
    history_summary: dict[str, Any] = field(default_factory=dict)
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        raw = asdict(self)
        raw["status"] = self.status.value
        return raw

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "SessionState":
        values = dict(raw)
        values["status"] = RunStatus(values.get("status", RunStatus.CREATED.value))
        if isinstance(values.get("current_plan"), list):
            values["current_plan"] = {
                "plan_id": "legacy",
                "version": 1,
                "goal": values.get("objective", ""),
                "nodes": [
                    {"task_id": f"legacy_{index}", "title": str(step), "status": "pending"}
                    for index, step in enumerate(values["current_plan"])
                ],
            }
        return cls(**values)
