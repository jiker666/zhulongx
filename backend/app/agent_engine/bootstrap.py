from __future__ import annotations

import hmac
import logging
from dataclasses import replace
from pathlib import Path
from typing import Any

from app.agent_engine.checkpoint import CheckpointStore
from app.agent_engine.events import AppendOnlyEventStore
from app.agent_engine.manager import run_manager
from app.agent_engine.managed_run import ManagedRun
from app.agent_engine.run_store import RunMetadata, RunMetadataStore
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.service import agent_run_service
from app.config import settings
from app.core.ctf_persistence import get_expected_flag
from app.scenarios import CTFScenario, default_scenarios


logger = logging.getLogger(__name__)


def _validator(metadata: RunMetadata):
    if metadata.request.scenario != "ctf":
        return default_scenarios().get(metadata.request.scenario).validator()
    config = metadata.scenario_config
    expected = None
    if config.get("evaluator_ref") == "ctf_task_expected":
        expected = get_expected_flag(metadata.request.task_id)
    evaluator = (lambda candidate, answer=expected: hmac.compare_digest(candidate, answer)) if expected else None
    return CTFScenario(
        flag_pattern=str(config.get("flag_pattern") or r"flag\{[^}]+\}"),
        evaluator=evaluator,
    ).validator()


def session_from_metadata(metadata: RunMetadata) -> ManagedRun:
    workspace = Path(metadata.request.workspace).expanduser().resolve()
    events = AppendOnlyEventStore(workspace / ".agent_state" / "events.jsonl")
    checkpoints = CheckpointStore(workspace / ".agent_state" / "checkpoints")
    sandbox = ContainerSandbox(
        workspace,
        readonly_paths=[item.path for item in metadata.request.inputs if item.readonly],
        runtime=settings.AGENT_SANDBOX_RUNTIME or None,
        image=settings.AGENT_SANDBOX_IMAGE,
    )
    request = metadata.request
    if checkpoints.exists(metadata.run_id) and not any(
        event.type == "run.mode_selected" for event in events.read(metadata.run_id)
    ):
        request = replace(request, execution_mode="single")
    return agent_run_service.create_session(
        request,
        _validator(metadata),
        run_id=metadata.run_id,
        events=events,
        checkpoint_store=checkpoints,
        sandbox=sandbox,
        scenario_config=dict(metadata.scenario_config),
        register=False,
    )


def restore_persisted_sessions(root: str | Path | None = None) -> dict[str, Any]:
    restored: list[str] = []
    failures: list[dict[str, str]] = []
    for store in RunMetadataStore.discover(root or settings.CTF_RUN_DIR):
        try:
            metadata = store.load()
            if run_manager.get(metadata.run_id) is not None:
                continue
            run_manager.add(session_from_metadata(metadata))
            restored.append(metadata.run_id)
        except Exception as exc:  # one corrupt run must not block service startup
            failures.append({"path": str(store.path), "error": type(exc).__name__})
            logger.warning("failed to restore persisted AgentSession metadata: %s", type(exc).__name__)
    return {"restored": restored, "failures": failures}
