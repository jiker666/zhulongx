from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class AgentRole(str, Enum):
    COORDINATOR = "coordinator"
    SCOUT = "scout"
    RESEARCHER = "researcher"
    PLANNER = "planner"
    EXECUTOR = "executor"
    ANALYST = "analyst"
    VERIFIER = "verifier"
    REFUTER = "refuter"
    SYNTHESIZER = "synthesizer"
    HUMAN_LIAISON = "human_liaison"


@dataclass(frozen=True)
class RoleProfile:
    role: AgentRole
    allowed_tools: tuple[str, ...]
    max_instances: int
    can_write: bool = False
    can_use_network: bool = False
    can_execute: bool = False


@dataclass(frozen=True)
class RoleExecutionProfile:
    role: str
    model: str = "glm-5.2"
    reasoning_effort: str = "high"
    temperature: float = 0.1
    max_output_tokens: int = 16_384
    context_budget_tokens: int = 128_000
    tool_capabilities: tuple[str, ...] = ()
    max_tool_rounds: int = 20
    max_parallel_tools: int = 2
    timeout_seconds: float = 120.0
    review_independence: bool = False
    system_prompt: str = ""

    def __post_init__(self) -> None:
        if self.reasoning_effort not in {"none", "minimal", "low", "medium", "high", "max", "xhigh"}:
            raise ValueError(f"unsupported reasoning effort: {self.reasoning_effort}")
        if not 0 <= self.temperature <= 1:
            raise ValueError("role temperature must be between 0 and 1")
        if min(
            self.max_output_tokens,
            self.context_budget_tokens,
            self.max_tool_rounds,
            self.max_parallel_tools,
            self.timeout_seconds,
        ) <= 0:
            raise ValueError("role execution budgets must be positive")


def default_role_profiles() -> dict[str, RoleProfile]:
    read_tools = ("list_dir", "read_file", "grep", "load_skill")
    knowledge_tools = ("record_evidence", "record_fact", "record_hypothesis", "refute_hypothesis")
    handoff = ("complete_task",)
    return {
        AgentRole.COORDINATOR.value: RoleProfile(AgentRole.COORDINATOR, (), 1),
        AgentRole.SCOUT.value: RoleProfile(AgentRole.SCOUT, read_tools + handoff, 3),
        AgentRole.RESEARCHER.value: RoleProfile(AgentRole.RESEARCHER, read_tools + ("http_request",) + handoff, 2, can_use_network=True),
        AgentRole.PLANNER.value: RoleProfile(AgentRole.PLANNER, read_tools + ("record_hypothesis", "revise_plan") + handoff, 1),
        AgentRole.EXECUTOR.value: RoleProfile(
            AgentRole.EXECUTOR,
            read_tools + knowledge_tools + ("write_file", "extract_archive", "run_shell", "run_python", "http_request", "submit_candidate") + handoff,
            3,
            can_write=True,
            can_use_network=True,
            can_execute=True,
        ),
        AgentRole.ANALYST.value: RoleProfile(AgentRole.ANALYST, read_tools + knowledge_tools + handoff, 2),
        AgentRole.VERIFIER.value: RoleProfile(AgentRole.VERIFIER, read_tools + knowledge_tools + ("run_shell", "run_python") + handoff, 2, can_execute=True),
        AgentRole.REFUTER.value: RoleProfile(AgentRole.REFUTER, read_tools + knowledge_tools + ("run_shell", "run_python") + handoff, 1, can_execute=True),
        AgentRole.SYNTHESIZER.value: RoleProfile(AgentRole.SYNTHESIZER, read_tools + handoff, 1),
        AgentRole.HUMAN_LIAISON.value: RoleProfile(AgentRole.HUMAN_LIAISON, ("ask_human",), 1),
    }


def default_role_execution_profiles() -> dict[str, RoleExecutionProfile]:
    roles = default_role_profiles()
    prompts = {
        "coordinator": "Maintain the global goal, graph, evidence threshold, conflicts, and budget.",
        "planner": "Produce or revise a schema-valid task graph. Do not perform risky execution.",
        "scout": "Perform bounded low-cost triage. Report observations and unknowns without declaring success.",
        "researcher": "Investigate the assigned protocol, code, artifact, or documentation question deeply.",
        "executor": "Execute the assigned reproducible experiment and bind every conclusion to tool evidence.",
        "analyst": "Test explicit hypotheses against artifacts and separate observations from conclusions.",
        "verifier": "Independently reproduce critical claims from evidence and return accepted, rejected, or insufficient.",
        "refuter": "Actively seek counterexamples, alternate explanations, leakage, and irreproducible steps.",
        "synthesizer": "Use only validated evidence and verdicts to produce the requested structured result.",
        "human_liaison": "Ask one minimal structured question when external input is strictly required.",
    }
    efforts = {
        "coordinator": "max",
        "planner": "max",
        "scout": "high",
        "researcher": "high",
        "executor": "max",
        "analyst": "high",
        "verifier": "max",
        "refuter": "max",
        "synthesizer": "high",
        "human_liaison": "low",
    }
    temperatures = {"scout": 0.2, "researcher": 0.1}
    profiles: dict[str, RoleExecutionProfile] = {}
    for name, role_profile in roles.items():
        profiles[name] = RoleExecutionProfile(
            role=name,
            reasoning_effort=efforts[name],
            temperature=temperatures.get(name, 0.0 if name in {"verifier", "refuter"} else 0.1),
            max_output_tokens=32_768 if name in {"coordinator", "planner", "executor", "verifier", "refuter"} else 16_384,
            context_budget_tokens=256_000 if name in {"coordinator", "planner", "executor"} else 128_000,
            tool_capabilities=role_profile.allowed_tools,
            max_tool_rounds=30 if name in {"executor", "verifier", "refuter"} else 15,
            max_parallel_tools=1 if name in {"planner", "verifier", "refuter", "synthesizer"} else 2,
            timeout_seconds=180 if name in {"executor", "verifier", "refuter"} else 120,
            review_independence=name in {"verifier", "refuter"},
            system_prompt=prompts[name],
        )
    return profiles
