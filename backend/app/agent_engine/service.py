from __future__ import annotations

from pathlib import Path

from app.agent_engine.checkpoint import CheckpointStore
from app.agent_engine.events import AppendOnlyEventStore
from app.agent_engine.managed_run import ManagedRun
from app.agent_engine.manager import run_manager
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.run_store import RunMetadataStore
from app.agent_engine.run_session_factory import RunSessionFactory
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.skills.index import SkillIndex
from app.agent_engine.skills.loader import SkillLoader
from app.agent_engine.state import RunRequest
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.validation.base import Validator
from app.config import settings


class AgentRunService:
    """Canonical construction path shared by generic and scenario-specific APIs."""

    def __init__(self, factory: RunSessionFactory | None = None) -> None:
        self.factory = factory or RunSessionFactory()

    def create_session(
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
        scenario_config: dict[str, object] | None = None,
        register: bool = True,
    ) -> ManagedRun:
        workspace = Path(request.workspace).expanduser().resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        event_store = events or AppendOnlyEventStore(workspace / ".agent_state" / "events.jsonl")
        checkpoints = checkpoint_store or CheckpointStore(workspace / ".agent_state" / "checkpoints")
        skill_index = SkillIndex.scan(Path(__file__).resolve().parents[1] / "skills")
        skill_loader = SkillLoader(skill_index)
        selected_sandbox = sandbox or ContainerSandbox(
            workspace,
            readonly_paths=[item.path for item in request.inputs if item.readonly],
            runtime=settings.AGENT_SANDBOX_RUNTIME or None,
            image=settings.AGENT_SANDBOX_IMAGE,
        )
        session = self.factory.create(
            request,
            validator,
            run_id=run_id,
            provider=provider,
            sandbox=selected_sandbox,
            events=event_store,
            checkpoint_store=checkpoints,
            registry=registry,
            policy=policy,
            skill_index=skill_index,
            skill_loader=skill_loader,
        )
        RunMetadataStore.for_workspace(workspace).save(
            session.run_id,
            request,
            scenario_config=scenario_config or {},
        )
        if register and run_manager.get(session.run_id) is None:
            run_manager.add(session)
        return session


agent_run_service = AgentRunService()
