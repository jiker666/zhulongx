from __future__ import annotations

import uuid
from dataclasses import replace
from pathlib import Path

from app.agent_engine.checkpoint import CheckpointStore
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.managed_run import ManagedRun
from app.agent_engine.orchestration.coordinator import CoordinatorSession
from app.agent_engine.orchestration.llm_subagent_worker import LLMSubagentWorker
from app.agent_engine.orchestration.subagent_manager import SubagentManager
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.providers.factory import configured_provider
from app.agent_engine.providers.routing import ModelRoutePolicy
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.skills.index import SkillIndex
from app.agent_engine.skills.loader import SkillLoader
from app.agent_engine.state import RunRequest
from app.agent_engine.tools.builtin import build_builtin_registry
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.validation.base import Validator
from app.config import settings
from app.scenarios import default_scenarios
from app.scenarios.workflow_factory import build_workflow


class RunModeSelector:
    COORDINATED_SCENARIOS = {
        "ctf",
        "pentest",
        "vuln_analysis",
        "incident_response",
        "reverse_forensics",
    }

    def select(self, request: RunRequest) -> tuple[str, tuple[str, ...]]:
        if request.execution_mode != "auto":
            return request.execution_mode, ("explicit request mode",)
        reasons: list[str] = []
        if request.scenario in self.COORDINATED_SCENARIOS:
            reasons.append(f"security scenario: {request.scenario}")
        if request.inputs:
            reasons.append("task has input artifacts")
        if len(request.objective.split()) >= 12 or len(request.objective) >= 120:
            reasons.append("objective is multi-step or open-ended")
        if request.autonomy_level == "high":
            reasons.append("high autonomy requested")
        if reasons:
            return "coordinator", tuple(reasons)
        return "single", ("bounded simple request",)


class RunSessionFactory:
    """Construct both root and leaf sessions through one formal path."""

    def __init__(self, selector: RunModeSelector | None = None) -> None:
        self.selector = selector or RunModeSelector()

    def create(
        self,
        request: RunRequest,
        validator: Validator,
        *,
        run_id: str | None = None,
        provider: ModelProvider | None = None,
        sandbox: Sandbox | None = None,
        events: AppendOnlyEventStore | None = None,
        checkpoint_store: CheckpointStore | None = None,
        registry: ToolRegistry | None = None,
        policy: PolicyEngine | None = None,
        skill_index: SkillIndex | None = None,
        skill_loader: SkillLoader | None = None,
    ) -> ManagedRun:
        workspace = Path(request.workspace).expanduser().resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        selected_run_id = run_id or f"run_{uuid.uuid4().hex}"
        event_store = events or AppendOnlyEventStore(workspace / ".agent_state" / "events.jsonl")
        checkpoints = checkpoint_store or CheckpointStore(workspace / ".agent_state" / "checkpoints")
        selected_registry = registry or build_builtin_registry(skill_loader)
        selected_policy = policy or PolicyEngine()
        selected_sandbox = sandbox or ContainerSandbox(
            workspace,
            readonly_paths=[item.path for item in request.inputs if item.readonly],
            runtime=settings.AGENT_SANDBOX_RUNTIME or None,
            image=settings.AGENT_SANDBOX_IMAGE,
        )
        effective_mode, reasons = self.selector.select(request)
        if effective_mode == "single":
            selected_provider = provider or configured_provider(request.model_config)
            common = {
                "provider": selected_provider,
                "validator": validator,
                "events": event_store,
                "checkpoint_store": checkpoints,
                "sandbox": selected_sandbox,
                "skill_index": skill_index,
                "skill_loader": skill_loader,
                "registry": selected_registry,
                "policy": selected_policy,
            }
            if checkpoints.exists(selected_run_id):
                session: ManagedRun = AgentSession.resume(request, run_id=selected_run_id, **common)
            else:
                session = AgentSession(request, run_id=selected_run_id, **common)
        else:
            scenario = default_scenarios().get(request.scenario)
            plan = replace(scenario.build_plan(request.objective), plan_id=f"plan_{selected_run_id}")
            workflow = build_workflow(scenario.manifest(), plan)
            route_policy = ModelRoutePolicy()

            def provider_for_role(role: str) -> ModelProvider:
                if provider is not None:
                    return provider
                return configured_provider(route_policy.for_role(request.model_config, role))

            def sandbox_for_workspace(child_workspace: Path, readonly: tuple[Path, ...]) -> Sandbox:
                if sandbox is not None and not isinstance(sandbox, ContainerSandbox):
                    return sandbox
                return ContainerSandbox(
                    child_workspace,
                    readonly_paths=readonly,
                    runtime=settings.AGENT_SANDBOX_RUNTIME or None,
                    image=settings.AGENT_SANDBOX_IMAGE,
                )

            worker = LLMSubagentWorker(
                request,
                validator,
                selected_registry,
                selected_policy,
                provider_for_role,
                sandbox_for_workspace=sandbox_for_workspace,
            )
            manager = SubagentManager(
                selected_run_id,
                workspace,
                event_store,
                worker,
                max_concurrency=request.max_parallel_agents,
            )
            coordinator_kwargs = {
                "events": event_store,
                "run_id": selected_run_id,
                "checkpoint_store": checkpoints,
                "validator": validator,
                "registry": selected_registry,
                "policy": selected_policy,
                "sandbox": selected_sandbox,
            }
            if checkpoints.exists(selected_run_id):
                session = CoordinatorSession.resume(request, plan, workflow, manager, **coordinator_kwargs)
            else:
                session = CoordinatorSession(request, plan, workflow, manager, **coordinator_kwargs)
        self._record_mode(session, effective_mode, reasons)
        return session

    @staticmethod
    def _record_mode(session: ManagedRun, mode: str, reasons: tuple[str, ...]) -> None:
        if any(event.type == EventType.RUN_MODE_SELECTED.value for event in session.event_stream()):
            return
        event = session.events.append(
            session.run_id,
            EventType.RUN_MODE_SELECTED,
            actor="run_session_factory",
            payload={
                "requested_mode": session.request.execution_mode,
                "effective_mode": mode,
                "reasons": list(reasons),
            },
            agent_id="agent_root",
            task_id=session.request.task_id,
        )
        session.reducer.apply(session.state, event)
