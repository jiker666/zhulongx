from __future__ import annotations

import json
from typing import Any, Iterable, Mapping

from app.agent_engine.artifacts.retrieval import ArtifactRetriever
from app.agent_engine.context_budget import (
    ContextBudget,
    ContextPack,
    ContextPackStats,
    estimate_tokens,
    messages_tokens,
    stable_prefix_sha256,
)
from app.agent_engine.events import AgentEvent, AppendOnlyEventStore, EventType
from app.agent_engine.skills.index import SkillIndex
from app.agent_engine.state import RunRequest, SessionState


class ContextBuilder:
    """Build stable-prefix, token-aware context packs with native tool pairing."""

    def __init__(
        self,
        *,
        max_events: int = 40,
        skill_index: SkillIndex | None = None,
        artifact_retriever: ArtifactRetriever | None = None,
    ) -> None:
        # Retained for serialized compatibility; selection is governed by token budgets.
        self.max_events = max_events
        self.skill_index = skill_index
        self.artifact_retriever = artifact_retriever or ArtifactRetriever()
        self.last_stats: ContextPackStats | None = None

    def build(
        self,
        request: RunRequest,
        state: SessionState,
        events: AppendOnlyEventStore,
    ) -> list[dict[str, Any]]:
        return [dict(message) for message in self.build_pack(request, state, events).messages]

    def build_pack(
        self,
        request: RunRequest,
        state: SessionState,
        events: AppendOnlyEventStore,
    ) -> ContextPack:
        budget = ContextBudget.for_request(request)
        stable = self._stable_prefix(request)
        stable_tokens = messages_tokens(stable)
        dynamic_budget = max(512, budget.max_prompt_tokens - stable_tokens)
        artifact_budget = min(24_000, max(128, dynamic_budget // 6))
        retrieved = self.artifact_retriever.retrieve(
            state.artifacts,
            f"{request.objective} {self._active_node_text(state)}",
            max_tokens=artifact_budget,
        )
        artifact_payload = [item.to_dict() for item in retrieved]
        artifact_tokens = estimate_tokens(artifact_payload)
        dynamic = self._dynamic_message(
            request,
            state,
            artifact_payload,
            max_tokens=max(256, dynamic_budget // 2),
        )
        base = [*stable, dynamic]
        transcript_budget = max(0, budget.max_prompt_tokens - messages_tokens(base))
        groups = self._transcript_groups(events.read(state.run_id))
        selected: list[tuple[tuple[dict[str, Any], ...], tuple[int, ...]]] = []
        used = 0
        for messages, sequences in reversed(groups):
            cost = messages_tokens(messages)
            if used + cost > transcript_budget:
                continue
            selected.append((messages, sequences))
            used += cost
        selected.reverse()
        transcript = [message for messages, _ in selected for message in messages]
        included_sequences = tuple(sequence for _, sequences in selected for sequence in sequences)
        messages = tuple([*base, *transcript])
        stats = ContextPackStats(
            estimated_prompt_tokens=messages_tokens(messages),
            max_prompt_tokens=budget.max_prompt_tokens,
            stable_prefix_tokens=stable_tokens,
            stable_prefix_sha256=stable_prefix_sha256(stable),
            transcript_tokens=used,
            artifact_tokens=artifact_tokens,
            included_event_sequences=included_sequences,
            omitted_event_count=max(0, sum(len(sequences) for _, sequences in groups) - len(included_sequences)),
        )
        self.last_stats = stats
        return ContextPack(messages, stats)

    def compactable_events(
        self,
        request: RunRequest,
        state: SessionState,
        events: AppendOnlyEventStore,
    ) -> list[AgentEvent]:
        source = events.read(state.run_id)
        pack = self.build_pack(request, state, events)
        if pack.stats.omitted_event_count <= 0 or not pack.stats.included_event_sequences:
            return []
        first_retained = min(pack.stats.included_event_sequences)
        return [event for event in source if event.sequence < first_retained]

    def _stable_prefix(self, request: RunRequest) -> list[dict[str, Any]]:
        skills = self.skill_index.prompt_index(scenario=request.scenario) if self.skill_index else []
        content = (
            "You are a focused worker in an Agent Engine run. Registered tools are proposals: the harness validates "
            "schema, policy, scope, idempotency, resource locks, execution, evidence, and completion. Keep observations, "
            "hypotheses, and confirmed facts distinct. A candidate completes only through the configured validator. "
            + (f"Assigned role: {request.agent_role}. {request.role_instructions} " if request.agent_role else "")
            + "Return only public decision summaries; private model reasoning is not an audit artifact."
        )
        if skills:
            content += "\nStable skill index:\n" + json.dumps(skills, ensure_ascii=False, sort_keys=True)
        return [{"role": "system", "content": content}]

    def _dynamic_message(
        self,
        request: RunRequest,
        state: SessionState,
        artifact_chunks: list[dict[str, Any]],
        *,
        max_tokens: int,
    ) -> dict[str, Any]:
        per_section = max(64, max_tokens // 8)
        payload = {
            "task": {
                "title": request.title,
                "objective": request.objective,
                "scenario": request.scenario,
                "lineage": {
                    "root_run_id": request.root_run_id or state.run_id,
                    "parent_run_id": request.parent_run_id,
                    "role": request.agent_role or "single",
                },
                "inputs": [
                    {"name": item.name, "path": item.path, "media_type": item.media_type}
                    for item in request.inputs
                ],
            },
            "current_plan": self._plan_projection(state.current_plan),
            "facts": self._bounded_items(state.confirmed_facts, per_section),
            "open_hypotheses": self._bounded_items(state.open_hypotheses, per_section),
            "failed_hypotheses": self._bounded_items(state.failed_hypotheses, per_section),
            "evidence_index": self._bounded_items(state.evidence, per_section),
            "artifact_inventory": self._artifact_inventory(state.artifacts, per_section),
            "retrieved_artifact_chunks": artifact_chunks,
            "history_summary": self._bounded_mapping(state.history_summary, per_section),
            "candidate_answers": self._bounded_items(state.candidate_answers, per_section),
        }
        content = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        if estimate_tokens(content) > max_tokens:
            for key in (
                "retrieved_artifact_chunks", "candidate_answers", "failed_hypotheses",
                "open_hypotheses", "evidence_index", "facts", "artifact_inventory",
            ):
                values = payload[key]
                while values and estimate_tokens(content) > max_tokens:
                    values.pop(0)
                    content = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        if estimate_tokens(content) > max_tokens:
            payload["current_plan"]["nodes"] = list(payload["current_plan"].get("nodes", ()))[:3]
            payload["task"]["objective"] = str(payload["task"]["objective"])[: max(128, int(max_tokens * 2))]
            payload["context_truncated"] = True
            content = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        if estimate_tokens(content) > max_tokens:
            payload = {
                "task": {
                    "title": request.title[:500],
                    "objective": request.objective[: max(64, int(max_tokens * 1.5))],
                    "scenario": request.scenario,
                    "role": request.agent_role or "single",
                },
                "current_plan": {
                    "plan_id": state.current_plan.get("plan_id", ""),
                    "version": state.current_plan.get("version", 0),
                },
                "context_truncated": True,
            }
            content = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        return {"role": "user", "content": content}

    @staticmethod
    def _plan_projection(plan: Mapping[str, Any]) -> dict[str, Any]:
        if not plan:
            return {}
        nodes = list(plan.get("nodes", []))
        important = [
            node for node in nodes
            if node.get("status") in {"running", "ready", "blocked", "failed"}
            or node.get("task_id") in set(plan.get("critical_path", ()))
        ]
        if not important:
            important = nodes[:20]
        return {
            key: plan.get(key)
            for key in ("plan_id", "version", "goal", "critical_path", "revision_reason", "completion_contract")
            if key in plan
        } | {"nodes": important[:50]}

    @staticmethod
    def _bounded_items(items: Iterable[Mapping[str, Any]], max_tokens: int) -> list[dict[str, Any]]:
        selected: list[dict[str, Any]] = []
        used = 0
        for item in reversed(list(items)):
            value = dict(item)
            cost = estimate_tokens(value)
            if selected and used + cost > max_tokens:
                continue
            selected.append(value)
            used += cost
            if used >= max_tokens:
                break
        selected.reverse()
        return selected

    @staticmethod
    def _bounded_mapping(value: Mapping[str, Any], max_tokens: int) -> dict[str, Any]:
        if estimate_tokens(value) <= max_tokens:
            return dict(value)
        return {
            "through_sequence": value.get("through_sequence", 0),
            "source_event_ids": list(value.get("source_event_ids", ()))[:100],
            "truncated": True,
        }

    def _artifact_inventory(self, artifacts: Iterable[Mapping[str, Any]], max_tokens: int) -> list[dict[str, Any]]:
        inventory = []
        for item in artifacts:
            inventory.append({
                key: item.get(key)
                for key in ("artifact_id", "original_name", "media_type", "size", "sha256", "storage_path", "risk_tags")
                if key in item
            })
        return self._bounded_items(inventory, max_tokens)

    @staticmethod
    def _active_node_text(state: SessionState) -> str:
        for node in state.current_plan.get("nodes", []):
            if node.get("status") in {"running", "ready", "pending"}:
                return " ".join(str(node.get(key, "")) for key in ("title", "objective", "expected_output"))
        return ""

    def _transcript_groups(
        self,
        events: Iterable[AgentEvent],
    ) -> list[tuple[tuple[dict[str, Any], ...], tuple[int, ...]]]:
        groups: list[tuple[tuple[dict[str, Any], ...], tuple[int, ...]]] = []
        current_messages: list[dict[str, Any]] = []
        current_sequences: list[int] = []
        known_tool_calls: set[str] = set()

        def flush() -> None:
            nonlocal current_messages, current_sequences, known_tool_calls
            if current_messages:
                groups.append((tuple(current_messages), tuple(current_sequences)))
            current_messages = []
            current_sequences = []
            known_tool_calls = set()

        for event in events:
            if event.type == EventType.MODEL_RESPONDED.value:
                flush()
                message = self._event_message(event, known_tool_calls)
                if message:
                    current_messages.append(dict(message))
                    current_sequences.append(event.sequence)
                continue
            if event.type in {EventType.TOOL_FINISHED.value, EventType.TOOL_FAILED.value}:
                message = self._event_message(event, known_tool_calls)
                if message:
                    current_messages.append(dict(message))
                    current_sequences.append(event.sequence)
                continue
            if event.type == EventType.HUMAN_ANSWERED.value:
                flush()
                message = self._event_message(event, known_tool_calls)
                if message:
                    groups.append(((dict(message),), (event.sequence,)))
        flush()
        return groups

    @staticmethod
    def _event_message(event: AgentEvent, known_tool_calls: set[str]) -> Mapping[str, Any] | None:
        if event.type == EventType.MODEL_RESPONDED.value:
            text = str(event.payload.get("text", ""))
            raw_calls = list(event.payload.get("tool_calls", []))
            message: dict[str, Any] = {"role": "assistant", "content": text}
            tool_calls = []
            for call in raw_calls:
                call_id = str(call.get("id", ""))
                if not call_id:
                    continue
                known_tool_calls.add(call_id)
                tool_calls.append({
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": str(call.get("name", "")),
                        "arguments": json.dumps(call.get("arguments", {}), ensure_ascii=False, sort_keys=True),
                    },
                })
            if tool_calls:
                message["tool_calls"] = tool_calls
            return message if text or tool_calls else None
        if event.type in {EventType.TOOL_FINISHED.value, EventType.TOOL_FAILED.value}:
            call_id = str(event.payload.get("tool_call_id", ""))
            if not call_id or call_id not in known_tool_calls:
                return None
            return {
                "role": "tool",
                "tool_call_id": call_id,
                "name": str(event.payload.get("name", "")),
                "content": json.dumps({
                    "event_id": event.event_id,
                    "type": (
                        EventType.POLICY_DENIED.value
                        if event.payload.get("metadata", {}).get("code") == "policy_denied"
                        else event.type
                    ),
                    "success": bool(event.payload.get("success", event.type == EventType.TOOL_FINISHED.value)),
                    "summary": event.payload.get("summary", ""),
                    "output": event.payload.get("output", ""),
                    "error": event.payload.get("error", ""),
                    "artifacts": event.payload.get("artifacts", []),
                }, ensure_ascii=False),
            }
        if event.type == EventType.HUMAN_ANSWERED.value:
            return {
                "role": "user",
                "content": json.dumps({
                    "human_answer": event.payload.get("public_response", {}),
                    "answer_refs": event.payload.get("secure_input_refs", []),
                }, ensure_ascii=False),
            }
        return None
