from __future__ import annotations

import json
import shutil
import threading
from dataclasses import replace
from pathlib import Path
from typing import Callable, Mapping

from app.agent_engine.agents.base import AgentHandoff, AgentSummary
from app.agent_engine.agents.roles import RoleExecutionProfile, default_role_execution_profiles
from app.agent_engine.budget import BudgetLimits
from app.agent_engine.checkpoint import CheckpointStore
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.mailbox import AgentMailbox
from app.agent_engine.orchestration.subagent_manager import SubagentRecord
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import ModelProvider
from app.agent_engine.sandbox.base import Sandbox
from app.agent_engine.sandbox.container import ContainerSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.state import InputReference, ModelConfig, RunRequest, RunStatus
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.validation.base import Validator


ProviderForRole = Callable[[str, ModelConfig], ModelProvider]
SandboxForWorkspace = Callable[[Path, tuple[Path, ...]], Sandbox]


class ChildEventProjector:
    """Project safe child execution events into the root event lineage."""

    PROJECTED_TYPES = {
        EventType.MODEL_REQUESTED.value,
        EventType.MODEL_RESPONDED.value,
        EventType.PROVIDER_CAPABILITY_NEGOTIATED.value,
        EventType.TOOL_REQUESTED.value,
        EventType.POLICY_ALLOWED.value,
        EventType.POLICY_DENIED.value,
        EventType.TOOL_STARTED.value,
        EventType.TOOL_FINISHED.value,
        EventType.TOOL_FAILED.value,
        EventType.FACT_CONFIRMED.value,
        EventType.FACT_RETRACTED.value,
        EventType.HYPOTHESIS_PROPOSED.value,
        EventType.HYPOTHESIS_CONFIRMED.value,
        EventType.HYPOTHESIS_REFUTED.value,
        EventType.EVIDENCE_RECORDED.value,
        EventType.CONTRADICTION_RECORDED.value,
        EventType.DECISION_RECORDED.value,
        EventType.ARTIFACT_INGESTED.value,
        EventType.SKILL_LOADED.value,
        EventType.BUDGET_WARNING.value,
        EventType.BUDGET_EXCEEDED.value,
        EventType.CANDIDATE_DETECTED.value,
        EventType.CANDIDATE_VALIDATED.value,
        EventType.CANDIDATE_REJECTED.value,
        EventType.VALIDATION_REQUESTED.value,
        EventType.VALIDATION_COMPLETED.value,
    }

    def __init__(
        self,
        record: SubagentRecord,
        child_events: AppendOnlyEventStore,
        root_events: AppendOnlyEventStore,
    ) -> None:
        self.record = record
        self.child_events = child_events
        self.root_events = root_events
        self._cursor = 0
        self._event_map: dict[str, str] = {}
        for event in root_events.read(record.root_run_id):
            lineage = event.payload.get("lineage")
            if not isinstance(lineage, Mapping) or lineage.get("child_run_id") != record.child_run_id:
                continue
            self._cursor = max(self._cursor, int(lineage.get("child_sequence", 0) or 0))
            child_event_id = str(lineage.get("child_event_id") or "")
            if child_event_id:
                self._event_map[child_event_id] = event.event_id

    def run(self, finished: threading.Event) -> None:
        base_parent = self._spawn_event_id()
        while True:
            source = self.child_events.read(self.record.child_run_id, after_sequence=self._cursor)
            for event in source:
                self._cursor = event.sequence
                if event.type not in self.PROJECTED_TYPES:
                    continue
                payload = dict(event.payload)
                if isinstance(payload.get("evidence_event_ids"), list):
                    payload["evidence_event_ids"] = [
                        self._event_map.get(str(event_id), str(event_id))
                        for event_id in payload["evidence_event_ids"]
                    ]
                projected = self.root_events.append(
                    self.record.root_run_id,
                    event.type,
                    actor=self.record.agent_id,
                    parent_event_id=self._event_map.get(event.parent_event_id or "", base_parent),
                    agent_id=self.record.agent_id,
                    task_id=self.record.task.task_id,
                    payload={
                        **payload,
                        "lineage": {
                            "root_run_id": self.record.root_run_id,
                            "parent_run_id": self.record.root_run_id,
                            "child_run_id": self.record.child_run_id,
                            "agent_id": self.record.agent_id,
                            "role": self.record.role,
                            "child_event_id": event.event_id,
                            "child_sequence": event.sequence,
                        },
                    },
                )
                self._event_map[event.event_id] = projected.event_id
            if finished.is_set() and not self.child_events.read(
                self.record.child_run_id,
                after_sequence=self._cursor,
            ):
                return
            finished.wait(0.02)

    def _spawn_event_id(self) -> str | None:
        for event in reversed(self.root_events.read(self.record.root_run_id)):
            if event.type == EventType.AGENT_SPAWNED.value and event.agent_id == self.record.agent_id:
                return event.event_id
        return None


class LLMSubagentWorker:
    """Run one coordinator task through the canonical leaf AgentSession."""

    def __init__(
        self,
        root_request: RunRequest,
        validator: Validator,
        registry: ToolRegistry,
        policy: PolicyEngine,
        provider_for_role: ProviderForRole,
        *,
        sandbox_for_workspace: SandboxForWorkspace | None = None,
        role_execution_profiles: Mapping[str, RoleExecutionProfile] | None = None,
    ) -> None:
        self.root_request = root_request
        self.validator = validator
        self.registry = registry
        self.policy = policy
        self.provider_for_role = provider_for_role
        self.sandbox_for_workspace = sandbox_for_workspace
        self.role_execution_profiles = dict(role_execution_profiles or default_role_execution_profiles())
        self._lock = threading.RLock()
        self._active: dict[str, AgentSession] = {}

    def __call__(self, record: SubagentRecord, mailbox: AgentMailbox) -> AgentSummary:
        execution_profile = self.role_execution_profiles[record.role]
        inputs = self._materialize_inputs(record.workspace)
        model_config = replace(
            self.root_request.model_config,
            model=self.root_request.model_config.model or execution_profile.model,
            temperature=execution_profile.temperature,
            max_tokens=min(execution_profile.max_output_tokens, record.budget.max_tokens),
            timeout_seconds=min(execution_profile.timeout_seconds, record.budget.max_seconds),
            reasoning_effort=execution_profile.reasoning_effort,
            max_parallel_tools=execution_profile.max_parallel_tools,
            parallel_tool_calls=execution_profile.max_parallel_tools > 1,
            context_budget_tokens=execution_profile.context_budget_tokens,
        )
        child_request = replace(
            self.root_request,
            task_id=record.task.task_id,
            title=record.task.title,
            objective=self._objective(record, execution_profile, mailbox),
            workspace=str(record.workspace),
            inputs=inputs,
            budgets=BudgetLimits(
                max_seconds=min(self.root_request.budgets.max_seconds, record.budget.max_seconds),
                max_model_requests=max(1, min(
                    self.root_request.budgets.max_model_requests,
                    execution_profile.max_tool_rounds,
                    record.budget.max_tool_calls,
                )),
                max_tool_calls=record.budget.max_tool_calls,
                max_tokens=record.budget.max_tokens,
                max_cost_usd=record.budget.max_cost_usd,
            ),
            execution_mode="single",
            max_parallel_agents=1,
            max_agent_depth=1,
            model_config=model_config,
            root_run_id=record.root_run_id,
            parent_run_id=record.root_run_id,
            agent_role=record.role,
            role_instructions=execution_profile.system_prompt,
        )
        child_events = AppendOnlyEventStore(record.workspace / ".agent_state" / "events.jsonl")
        readonly = tuple(Path(item.path) for item in inputs if item.readonly)
        sandbox = (
            self.sandbox_for_workspace(record.workspace, readonly)
            if self.sandbox_for_workspace is not None
            else ContainerSandbox(record.workspace, readonly_paths=readonly)
        )
        selected_provider = self.provider_for_role(record.role, child_request.model_config)
        trace_context = getattr(selected_provider, "trace_context", None)
        if isinstance(trace_context, dict):
            trace_context.update({"run_id": record.child_run_id, "trace_id": record.root_run_id})
        checkpoint_store = CheckpointStore(record.workspace / ".agent_state" / "checkpoints")
        common = {
            "provider": selected_provider,
            "validator": self.validator,
            "events": child_events,
            "registry": self._registry_for(record),
            "policy": self.policy,
            "sandbox": sandbox,
            "checkpoint_store": checkpoint_store,
        }
        if checkpoint_store.exists(record.child_run_id):
            session = AgentSession.resume(child_request, run_id=record.child_run_id, **common)
        else:
            session = AgentSession(child_request, run_id=record.child_run_id, **common)
        with self._lock:
            self._active[record.agent_id] = session
        finished = threading.Event()
        projector = ChildEventProjector(record, child_events, mailbox.events)
        projector_thread = threading.Thread(
            target=projector.run,
            args=(finished,),
            daemon=True,
            name=f"subagent-events-{record.agent_id}",
        )
        projector_thread.start()
        watcher = threading.Thread(
            target=self._watch_cancel,
            args=(record, session, finished),
            daemon=True,
            name=f"subagent-cancel-{record.agent_id}",
        )
        watcher.start()
        try:
            state = session.run()
        finally:
            finished.set()
            projector_thread.join(timeout=2)
            with self._lock:
                self._active.pop(record.agent_id, None)
        status = "completed" if state.status in {RunStatus.SUCCEEDED, RunStatus.PENDING_EXTERNAL} else "blocked"
        if state.status == RunStatus.CANCELLED:
            status = "cancelled"
        final_handoff = dict((state.final_output or {}).get("handoff") or {})
        summary = str(final_handoff.get("summary") or self._summary_text(record, state.status, state.error))
        handoff = AgentHandoff(
            task_id=record.task.task_id,
            status=status,
            summary=summary,
            facts=tuple(final_handoff.get("facts") or state.confirmed_facts),
            hypotheses_supported=tuple(str(item) for item in final_handoff.get("hypotheses_supported", [])),
            hypotheses_refuted=tuple(str(item) for item in final_handoff.get("hypotheses_refuted", [])),
            evidence_refs=tuple(
                str(item) for item in (
                    final_handoff.get("evidence_refs")
                    or [value.get("evidence_id", "") for value in state.evidence]
                ) if item
            ),
            artifact_refs=tuple(
                str(item) for item in (
                    final_handoff.get("artifact_refs")
                    or [value.get("artifact_id", value.get("path", "")) for value in state.artifacts]
                ) if item
            ),
            commands_replay=tuple(str(item) for item in final_handoff.get("commands_replay", [])),
            unresolved_questions=tuple(
                str(item) for item in (final_handoff.get("unresolved_questions") or ([state.error] if state.error else []))
            ),
            recommended_next_actions=tuple(
                str(item) for item in (
                    final_handoff.get("recommended_next_actions")
                    or ["inspect child evidence and continue the validated graph"]
                )
            ),
            confidence=float(final_handoff.get("confidence", 1.0 if status == "completed" else 0.0)),
            verdict=str(final_handoff.get("verdict") or ""),
        )
        mailbox.send(
            record.agent_id,
            record.parent_agent_id or "agent_root",
            "agent_handoff",
            {
                "root_run_id": record.root_run_id,
                "child_run_id": record.child_run_id,
                "role": record.role,
                "review_independence": execution_profile.review_independence,
                **handoff.to_dict(),
            },
        )
        evidence = list(state.evidence)
        known_evidence = {str(item.get("evidence_id") or item.get("event_id") or "") for item in evidence}
        for evidence_ref in handoff.evidence_refs:
            if evidence_ref not in known_evidence:
                evidence.append({
                    "evidence_id": evidence_ref,
                    "summary": "child handoff evidence reference",
                    "source_event_ids": [evidence_ref],
                })
        return AgentSummary(
            agent_id=record.agent_id,
            role=record.role,
            task_id=record.task.task_id,
            status=status,
            summary=summary,
            facts=handoff.facts,
            hypotheses=tuple(state.open_hypotheses),
            evidence=tuple(evidence),
            artifacts=tuple(state.artifacts),
            recommendations=handoff.recommended_next_actions,
            error=state.error if status != "completed" else "",
            verdict=handoff.verdict,
        )

    def abort_all(self, reason: str) -> None:
        with self._lock:
            active = tuple(self._active.values())
        for session in active:
            session.abort(reason)

    @staticmethod
    def _watch_cancel(record: SubagentRecord, session: AgentSession, finished: threading.Event) -> None:
        while not finished.wait(0.05):
            if record.cancel_event.is_set():
                session.abort(record.error or "cancelled by coordinator")
                return

    def _registry_for(self, record: SubagentRecord) -> ToolRegistry:
        selected = ToolRegistry()
        profile = self.role_execution_profiles[record.role]
        allowed = set(record.task.allowed_tools) & set(profile.tool_capabilities)
        for definition in self.registry.definitions():
            if definition.name in allowed:
                selected.register(definition)
        return selected

    def _materialize_inputs(self, workspace: Path) -> tuple[InputReference, ...]:
        inputs: list[InputReference] = []
        input_root = workspace / "inputs"
        for item in self.root_request.inputs:
            source = Path(item.path).expanduser().resolve()
            if not source.is_file():
                continue
            input_root.mkdir(parents=True, exist_ok=True)
            target = input_root / Path(item.name).name
            if not target.exists():
                shutil.copy2(source, target)
            target.chmod(target.stat().st_mode & ~0o222)
            inputs.append(InputReference(item.name, str(target), item.media_type, True))
        return tuple(inputs)

    @staticmethod
    def _objective(record: SubagentRecord, profile: RoleExecutionProfile, mailbox: AgentMailbox) -> str:
        dependency_handoffs = [
            {
                "task_id": message.payload.get("task_id"),
                "status": message.payload.get("status"),
                "summary": message.payload.get("summary"),
                "facts": list(message.payload.get("facts", []))[:20],
                "evidence_refs": list(message.payload.get("evidence_refs", []))[:50],
                "artifact_refs": list(message.payload.get("artifact_refs", []))[:50],
            }
            for message in mailbox.receive("agent_root")
            if message.message_type == "agent_handoff" and message.payload.get("task_id") in set(record.task.dependencies)
        ]
        objective = (
            f"Role: {record.role}. {profile.system_prompt} Task: {record.task.title}. "
            f"Expected output: {record.task.expected_output}. "
            f"Success criteria: {'; '.join(record.task.success_criteria)}. "
            "Use only the assigned tools and finish with complete_task. "
            + ("Reproduce from an independent context and do not trust executor wording. " if profile.review_independence else "")
            + "Return evidence-backed results."
        )
        if dependency_handoffs:
            objective += " Dependency handoffs: " + json.dumps(dependency_handoffs, ensure_ascii=False, sort_keys=True)
        return objective

    @staticmethod
    def _summary_text(record: SubagentRecord, status: RunStatus, error: str) -> str:
        suffix = f": {error}" if error else ""
        return f"{record.role} task {record.task.task_id} ended with {status.value}{suffix}"
