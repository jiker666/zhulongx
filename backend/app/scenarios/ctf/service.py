from __future__ import annotations

import hmac
import shutil
import uuid
from pathlib import Path
from typing import Any, Callable

from app.agent_engine.checkpoint import CheckpointStore
from app.agent_engine.events import AppendOnlyEventStore
from app.agent_engine.manager import run_manager
from app.agent_engine.projections import LegacyTaskProjection
from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.providers.factory import configured_provider
from app.agent_engine.run_store import RunMetadataStore
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.skills.index import SkillIndex
from app.agent_engine.skills.loader import SkillLoader
from app.config import settings
from app.core.ctf_persistence import get_expected_flag, list_tasks_view, load_task_view, save_task
from app.scenarios.ctf import CTFRunRequestAdapter, CTFScenario


ProviderFactory = Callable[[], ModelProvider]
SandboxFactory = Callable[[Path, tuple[Path, ...]], Sandbox]


def build_provider() -> ModelProvider:
    return configured_provider()


class CTFSessionService:
    """CTF control-plane adapter; AgentSession remains the only run authority."""

    _LEGACY_STATE = {
        "created": "INIT",
        "running": "AGENT_THINK",
        "succeeded": "DONE",
        "failed": "FAILED",
        "timed_out": "HUMAN_REQUIRED",
        "cancelled": "HUMAN_REQUIRED",
        "human_required": "HUMAN_REQUIRED",
    }

    def __init__(
        self,
        provider_factory: ProviderFactory | None = None,
        sandbox_factory: SandboxFactory | None = None,
    ) -> None:
        self.provider_factory = provider_factory
        self.sandbox_factory = sandbox_factory

    def create_task(
        self,
        *,
        title: str,
        description: str,
        category_hint: str = "auto",
        flag_format: str | None = None,
        authorized: bool = False,
        allow_network: bool = False,
        allowed_hosts: tuple[str, ...] = (),
        allowed_ports: tuple[int, ...] = (),
        max_rounds: int = 0,
        max_time_sec: int = 600,
        source: str = "api",
        demo_id: str | None = None,
        expected_flag: str | None = None,
    ) -> dict[str, Any]:
        task_id = f"ctf_{uuid.uuid4().hex[:10]}"
        task = {
            "task_id": task_id,
            "title": title,
            "description": description,
            "category_hint": category_hint,
            "flag_format": flag_format,
            "authorized": bool(authorized),
            "allow_network": bool(allow_network and authorized and allowed_hosts),
            "allowed_hosts": list(allowed_hosts),
            "allowed_ports": [int(port) for port in allowed_ports],
            "max_rounds": int(max_rounds),
            "max_time_sec": max(30, min(int(max_time_sec), 3600)),
            "attachments": [],
            "state": "INIT",
            "rounds_used": 0,
            "is_running": False,
            "source": source,
            "demo_id": demo_id,
            "expected_flag": expected_flag,
            "engine": "v2",
        }
        save_task(task)
        return self.get_task(task_id)

    def add_attachment(self, task_id: str, path: str | Path) -> bool:
        task = load_task_view(task_id)
        source = Path(path).expanduser().resolve()
        if not task or task.get("agent_run_id") or not source.is_file() or source.name == "expected_flag.txt":
            return False
        attachments = [str(item) for item in task.get("attachments", [])]
        if str(source) not in attachments:
            attachments.append(str(source))
        save_task({**task, "attachments": attachments})
        return True

    def start(
        self,
        task_id: str,
        *,
        max_rounds: int | None = None,
        max_time_sec: int | None = None,
        sync: bool = False,
    ) -> tuple[dict[str, Any], bool]:
        task = load_task_view(task_id)
        if not task:
            raise KeyError(task_id)
        session = self._session_for(task, max_rounds=max_rounds, max_time_sec=max_time_sec)
        started = run_manager.start(session.run_id)
        if started:
            save_task({**task, "state": "AGENT_THINK", "is_running": True})
        if sync:
            run_manager.wait(session.run_id, timeout=float(session.request.budgets.max_seconds) + 3)
        return self.get_task(task_id), started

    def abort(self, task_id: str, reason: str = "cancelled by user") -> bool:
        task = load_task_view(task_id)
        if not task or not task.get("agent_run_id"):
            return False
        session = run_manager.get(str(task["agent_run_id"]))
        if session is None:
            session = self._session_for(task)
        return run_manager.abort(session.run_id, reason)

    def get_task(self, task_id: str) -> dict[str, Any]:
        task = load_task_view(task_id)
        if not task:
            raise KeyError(task_id)
        return self._project(task)

    def list_tasks(self, limit: int = 200) -> list[dict[str, Any]]:
        return [self._project(task) for task in list_tasks_view(limit=limit)]

    def events(self, task_id: str, *, after_sequence: int = 0) -> dict[str, Any]:
        task = self.get_task(task_id)
        events = [event for event in task["evidence"] if int(event.get("sequence", 0)) > after_sequence]
        return {
            "task_id": task_id,
            "run_id": task.get("agent_run_id"),
            "state": task["state"],
            "agent_status": task.get("agent_status", "created"),
            "is_running": task["is_running"],
            "after_sequence": after_sequence,
            "last_sequence": task.get("last_event_sequence", after_sequence),
            "events": events,
            "script_runs": task["script_runs"],
            "shell_history": task["shell_history"],
            "candidate_flags": task["candidate_flags"],
            "best_flag": task["best_flag"],
            "current_script": task["current_script"],
        }

    def _session_for(
        self,
        task: dict[str, Any],
        *,
        max_rounds: int | None = None,
        max_time_sec: int | None = None,
    ) -> AgentSession:
        existing_run_id = str(task.get("agent_run_id") or "")
        if existing_run_id:
            existing = run_manager.get(existing_run_id)
            if existing is not None:
                return existing
        run_id = existing_run_id or f"run_{uuid.uuid4().hex}"
        workspace = self._prepare_workspace(task, run_id)
        request_task = dict(task)
        request_task["attachments"] = [str(path) for path in sorted(workspace.iterdir()) if path.is_file()]
        if max_rounds is not None:
            request_task["max_rounds"] = max_rounds
        if max_time_sec is not None:
            request_task["max_time_sec"] = max_time_sec
        request = CTFRunRequestAdapter().adapt(
            request_task,
            workspace=workspace,
            allowed_hosts=tuple(str(item) for item in task.get("allowed_hosts", [])),
            allowed_ports=tuple(int(item) for item in task.get("allowed_ports", [])),
            provider=settings.LLM_PROVIDER,
            model=settings.LLM_MODEL,
        )
        event_store = AppendOnlyEventStore(workspace / ".agent_state" / "events.jsonl")
        checkpoint_store = CheckpointStore(workspace / ".agent_state" / "checkpoints")
        skill_index = SkillIndex.scan(Path(__file__).resolve().parents[2] / "skills")
        skill_loader = SkillLoader(skill_index)
        expected = get_expected_flag(str(task["task_id"])) if task.get("source") == "demo" else None
        evaluator = (lambda candidate, answer=expected: hmac.compare_digest(candidate, answer)) if expected else None
        validator = CTFScenario(
            flag_pattern=str(task.get("flag_format") or r"flag\{[^}]+\}"),
            evaluator=evaluator,
        ).validator()
        readonly_paths = tuple(Path(item.path) for item in request.inputs if item.readonly)
        sandbox = (
            self.sandbox_factory(workspace, readonly_paths)
            if self.sandbox_factory is not None
            else ContainerSandbox(
                workspace,
                readonly_paths=readonly_paths,
                runtime=settings.AGENT_SANDBOX_RUNTIME or None,
                image=settings.AGENT_SANDBOX_IMAGE,
            )
        )
        provider = self.provider_factory() if self.provider_factory is not None else build_provider()
        if checkpoint_store.exists(run_id):
            session = AgentSession.resume(
                request,
                run_id=run_id,
                provider=provider,
                validator=validator,
                events=event_store,
                checkpoint_store=checkpoint_store,
                sandbox=sandbox,
                skill_index=skill_index,
                skill_loader=skill_loader,
            )
        else:
            session = AgentSession(
                request,
                run_id=run_id,
                provider=provider,
                validator=validator,
                events=event_store,
                checkpoint_store=checkpoint_store,
                sandbox=sandbox,
                skill_index=skill_index,
                skill_loader=skill_loader,
            )
        RunMetadataStore.for_workspace(workspace).save(
            run_id,
            request,
            scenario_config={
                "flag_pattern": str(task.get("flag_format") or r"flag\{[^}]+\}"),
                "evaluator_ref": "ctf_task_expected" if expected else "none",
            },
        )
        run_manager.add(session)
        save_task({
            **task,
            "agent_run_id": run_id,
            "agent_workspace": str(workspace),
            "engine": "v2",
        })
        return session

    @staticmethod
    def _prepare_workspace(task: dict[str, Any], run_id: str) -> Path:
        existing = task.get("agent_workspace")
        workspace = (
            Path(str(existing)).expanduser().resolve()
            if existing
            else (Path(settings.CTF_RUN_DIR).expanduser().resolve() / str(task["task_id"]) / run_id)
        )
        workspace.mkdir(parents=True, exist_ok=True)
        for raw in task.get("attachments", []):
            source = Path(str(raw)).expanduser().resolve()
            if not source.is_file() or source.name == "expected_flag.txt":
                continue
            target = workspace / source.name
            suffix = 1
            while target.exists() and target.read_bytes() != source.read_bytes():
                target = workspace / f"{source.stem}_{suffix}{source.suffix}"
                suffix += 1
            if not target.exists():
                shutil.copy2(source, target)
        return workspace

    @classmethod
    def _project(cls, task: dict[str, Any]) -> dict[str, Any]:
        run_id = str(task.get("agent_run_id") or "")
        workspace_value = task.get("agent_workspace")
        if not run_id or not workspace_value:
            return task
        workspace = Path(str(workspace_value)).expanduser().resolve()
        session = run_manager.get(run_id)
        if session is not None:
            source = session.event_stream()
            agent_status = session.state.status.value
            error = session.state.error
            is_running = run_manager.is_running(run_id)
        else:
            source = AppendOnlyEventStore(workspace / ".agent_state" / "events.jsonl").read(run_id)
            projection_status = LegacyTaskProjection(run_id)
            projection_status.consume(source)
            agent_status = projection_status.state
            error = ""
            is_running = False
        projection = LegacyTaskProjection(run_id)
        projection.consume(source)
        view = projection.to_dict()
        task.update({
            "state": cls._LEGACY_STATE.get(agent_status, "HUMAN_REQUIRED"),
            "agent_status": agent_status,
            "is_running": is_running,
            "evidence": view["events"],
            "shell_history": view["shell_history"],
            "script_runs": view["script_runs"],
            "candidate_flags": view["candidate_flags"],
            "best_flag": view["best_flag"],
            "current_script": view["current_script"],
            "last_event_sequence": view["after_sequence"],
            "rounds_used": sum(1 for item in view["events"] if item["type"] == "model.responded"),
            "error": error,
        })
        if not is_running and agent_status != "created":
            save_task({**task, "is_running": False})
        return task


ctf_session_service = CTFSessionService()
