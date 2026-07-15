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


def default_role_profiles() -> dict[str, RoleProfile]:
    read_tools = ("list_dir", "read_file", "grep", "load_skill")
    knowledge_tools = ("record_evidence", "record_fact", "record_hypothesis", "refute_hypothesis")
    return {
        AgentRole.COORDINATOR.value: RoleProfile(AgentRole.COORDINATOR, (), 1),
        AgentRole.SCOUT.value: RoleProfile(AgentRole.SCOUT, read_tools, 3),
        AgentRole.RESEARCHER.value: RoleProfile(AgentRole.RESEARCHER, read_tools + ("http_request",), 2, can_use_network=True),
        AgentRole.PLANNER.value: RoleProfile(AgentRole.PLANNER, read_tools + ("record_hypothesis", "revise_plan"), 1),
        AgentRole.EXECUTOR.value: RoleProfile(
            AgentRole.EXECUTOR,
            read_tools + knowledge_tools + ("write_file", "extract_archive", "run_shell", "run_python", "http_request", "submit_candidate"),
            3,
            can_write=True,
            can_use_network=True,
            can_execute=True,
        ),
        AgentRole.ANALYST.value: RoleProfile(AgentRole.ANALYST, read_tools + knowledge_tools, 2),
        AgentRole.VERIFIER.value: RoleProfile(AgentRole.VERIFIER, read_tools + knowledge_tools + ("run_shell", "run_python"), 2, can_execute=True),
        AgentRole.REFUTER.value: RoleProfile(AgentRole.REFUTER, read_tools + knowledge_tools + ("run_shell", "run_python"), 1, can_execute=True),
        AgentRole.SYNTHESIZER.value: RoleProfile(AgentRole.SYNTHESIZER, read_tools, 1),
        AgentRole.HUMAN_LIAISON.value: RoleProfile(AgentRole.HUMAN_LIAISON, ("ask_human",), 1),
    }
