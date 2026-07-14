import os

import pytest

from app.agent_engine.artifacts.ingest import ArtifactIngestor
from app.agent_engine.compaction import ContextCompactor
from app.agent_engine.contracts.plan import Plan
from app.agent_engine.contracts.task import TaskNode
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.orchestration.task_graph import TaskGraph, TaskGraphValidationError
from app.agent_engine.state import SessionState


def _node(task_id, dependencies=()):
    return TaskNode(
        task_id=task_id,
        title=task_id,
        role="scout",
        expected_output="evidence",
        success_criteria=("evidence recorded",),
        dependencies=dependencies,
        allowed_tools=("read_file",),
    )


def test_plan_task_graph_validates_dependencies_and_cycles():
    graph = TaskGraph(
        Plan("plan_1", 1, "solve", (_node("a"), _node("b", ("a",)))),
        allowed_roles={"scout"},
        available_tools={"read_file"},
    )
    assert graph.topological_order() == ("a", "b")
    assert [item.task_id for item in graph.ready(set())] == ["a"]

    with pytest.raises(TaskGraphValidationError, match="cycle"):
        TaskGraph(Plan("plan_cycle", 1, "solve", (_node("a", ("b",)), _node("b", ("a",)))))


def test_revised_plan_requires_reason():
    with pytest.raises(ValueError, match="revision reason"):
        Plan("plan_2", 2, "solve", (_node("a"),))


def test_artifact_ingest_preserves_original_and_builds_inventory(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    original = tmp_path / "input.json"
    original.write_text('{"kind":"fixture","items":[1,2]}', encoding="utf-8")
    before = original.read_bytes()

    artifact = ArtifactIngestor(workspace).ingest(original)

    assert original.read_bytes() == before
    stored = workspace / artifact.storage_path
    assert stored.read_bytes() == before
    assert artifact.extraction.metadata["top_level_keys"] == ["kind", "items"]
    assert os.stat(stored).st_mode & 0o222 == 0


def test_compaction_keeps_hypotheses_separate_from_facts():
    events = AppendOnlyEventStore()
    state = SessionState("run_compact", "analyze")
    state.confirmed_facts = [{"fact_id": "f1", "statement": "ELF", "evidence_ids": ["e1"]}]
    state.open_hypotheses = [{"hypothesis_id": "h1", "statement": "packed"}]
    state.failed_hypotheses = [{"hypothesis_id": "h2", "statement": "UPX", "status": "refuted"}]
    events.append(state.run_id, EventType.TOOL_FAILED, actor="tool", payload={"error": "unsupported format"})

    summary = ContextCompactor().compact(state, events.read(state.run_id))

    assert [item["fact_id"] for item in summary.facts] == ["f1"]
    assert [item["hypothesis_id"] for item in summary.open_hypotheses] == ["h1"]
    assert [item["hypothesis_id"] for item in summary.failed_hypotheses] == ["h2"]
    assert summary.notable_failures[0]["error"] == "unsupported format"
