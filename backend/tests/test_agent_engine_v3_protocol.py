import threading

from app.agent_engine.abort import AbortToken
from app.agent_engine.context import ContextBuilder
from app.agent_engine.events import AppendOnlyEventStore, EventType
from app.agent_engine.policy.engine import PolicyEngine
from app.agent_engine.providers.base import AssistantTurn, ProviderToolCall
from app.agent_engine.providers.mock import ScriptedProvider
from app.agent_engine.reducer import StateReducer
from app.agent_engine.sandbox.local_test import LocalTestSandbox
from app.agent_engine.session import AgentSession
from app.agent_engine.state import RunRequest, RunStatus, SessionState
from app.agent_engine.tools.batch import BoundedToolBatchExecutor
from app.agent_engine.tools.executor import ToolExecutionService
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolCall, ToolContext, ToolDefinition, ToolResult
from app.agent_engine.validation.ctf import CTFValidator


def test_context_rebuilds_native_parallel_tool_transcript(tmp_path):
    events = AppendOnlyEventStore()
    state = SessionState("run_transcript", "inspect")
    request = RunRequest("task", "title", "inspect", str(tmp_path))
    events.append(
        state.run_id,
        EventType.MODEL_RESPONDED,
        actor="provider",
        payload={
            "text": "Inspect both files.",
            "tool_calls": [
                {"id": "call_a", "name": "read_file", "arguments": {"path": "a.txt"}},
                {"id": "call_b", "name": "read_file", "arguments": {"path": "b.txt"}},
            ],
        },
    )
    events.append(
        state.run_id,
        EventType.TOOL_FINISHED,
        actor="tool_executor",
        payload={"tool_call_id": "call_a", "name": "read_file", "success": True, "output": "A"},
    )
    events.append(
        state.run_id,
        EventType.TOOL_FAILED,
        actor="tool_executor",
        payload={"tool_call_id": "call_b", "name": "read_file", "success": False, "error": "missing"},
    )

    messages = ContextBuilder().build(request, state, events)

    assistant = messages[2]
    assert assistant["role"] == "assistant"
    assert [item["id"] for item in assistant["tool_calls"]] == ["call_a", "call_b"]
    assert [item["role"] for item in messages[3:]] == ["tool", "tool"]
    assert [item["tool_call_id"] for item in messages[3:]] == ["call_a", "call_b"]


def test_state_reducer_replays_plan_fact_hypothesis_and_evidence():
    events = AppendOnlyEventStore()
    run_id = "run_reducer_v3"
    events.append(run_id, EventType.RUN_STARTED, actor="session")
    events.append(run_id, EventType.PLAN_PROPOSED, actor="planner", payload={
        "plan": {"plan_id": "p1", "version": 1, "goal": "solve", "nodes": []},
        "reason": "initial evidence inventory",
    })
    events.append(run_id, EventType.EVIDENCE_RECORDED, actor="analyst", payload={
        "evidence": {"evidence_id": "e1", "summary": "header", "source_event_ids": ["evt_source"]},
    })
    events.append(run_id, EventType.FACT_CONFIRMED, actor="analyst", payload={
        "fact": {"fact_id": "f1", "statement": "ELF", "evidence_ids": ["e1"], "confidence": 1.0},
    })
    events.append(run_id, EventType.HYPOTHESIS_PROPOSED, actor="planner", payload={
        "hypothesis": {"hypothesis_id": "h1", "statement": "XOR", "status": "open"},
    })
    events.append(run_id, EventType.HYPOTHESIS_REFUTED, actor="verifier", payload={
        "hypothesis": {"hypothesis_id": "h1", "statement": "XOR", "reason": "known plaintext mismatch"},
    })

    state = StateReducer().replay(run_id, "solve", events.read(run_id))

    assert state.status == RunStatus.RUNNING
    assert state.current_plan["plan_id"] == "p1"
    assert state.confirmed_facts[0]["fact_id"] == "f1"
    assert state.open_hypotheses == []
    assert state.failed_hypotheses[0]["status"] == "refuted"
    assert state.last_event_sequence == 6


class _BarrierExecutor:
    def __init__(self, barrier):
        self.barrier = barrier

    def execute(self, context, arguments):
        self.barrier.wait(timeout=2)
        return ToolResult(True, "parallel", output=str(arguments["value"]))


def test_bounded_batch_executes_declared_parallel_safe_tools(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    barrier = threading.Barrier(2)
    registry = ToolRegistry()
    registry.register(ToolDefinition(
        name="parallel_read",
        description="test",
        input_schema={"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"]},
        risk_level="low",
        permissions=("local_read",),
        timeout_seconds=2,
        executor=_BarrierExecutor(barrier),
        idempotency="read_only",
        side_effect_level="read",
        parallel_safe=True,
    ))
    events = AppendOnlyEventStore()
    service = ToolExecutionService(registry, PolicyEngine(), events)
    context = ToolContext(
        "run_batch",
        RunRequest("task_batch", "batch", "parallel", str(workspace)),
        workspace,
        AbortToken(),
        LocalTestSandbox(workspace),
    )

    results = BoundedToolBatchExecutor(registry, service, max_concurrency=2).execute(
        [ToolCall("a", "parallel_read", {"value": "A"}), ToolCall("b", "parallel_read", {"value": "B"})],
        context,
    )

    assert [item.execution.result.output for item in results] == ["A", "B"]
    assert all(item.execution.result.success for item in results)


def test_ctf_candidate_waits_for_external_validation_and_can_complete(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "answer.txt").write_text("flag{pending}", encoding="utf-8")
    provider = ScriptedProvider([
        AssistantTurn(tool_calls=(ProviderToolCall("read", "read_file", {"path": "answer.txt"}),)),
        AssistantTurn(tool_calls=(ProviderToolCall("submit", "submit_candidate", {"candidate": "flag{pending}"}),)),
    ])
    session = AgentSession(
        RunRequest("task_pending", "pending", "find candidate", str(workspace)),
        provider=provider,
        validator=CTFValidator(flag_pattern=r"flag\{[^}]+\}"),
        sandbox=LocalTestSandbox(workspace),
    )

    assert session.run().status == RunStatus.PENDING_EXTERNAL
    assert not any(event.type == EventType.RUN_FAILED.value for event in session.event_stream())
    assert session.state.candidate_answers[-1]["completion_state"] == "submitted_pending_external"
    assert session.submit_external_validation(accepted=True, reason="judge accepted").status == RunStatus.SUCCEEDED


def test_human_handoff_answer_resumes_same_session(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "answer.txt").write_text("flag{resume}", encoding="utf-8")
    provider = ScriptedProvider([
        AssistantTurn(tool_calls=(ProviderToolCall("human", "ask_human", {"question": "Select input"}),)),
        AssistantTurn(tool_calls=(ProviderToolCall("read", "read_file", {"path": "answer.txt"}),)),
        AssistantTurn(tool_calls=(ProviderToolCall("submit", "submit_candidate", {"candidate": "flag{resume}"}),)),
    ])
    session = AgentSession(
        RunRequest("task_human", "human", "resume", str(workspace)),
        provider=provider,
        validator=CTFValidator(flag_pattern=r"flag\{[^}]+\}", evaluator=lambda value: value == "flag{resume}"),
        sandbox=LocalTestSandbox(workspace),
    )

    assert session.run().status == RunStatus.HUMAN_REQUIRED
    assert session.state.human_handoff["minimal_blocker"] == "explicit human gate"
    session.answer_human({"selection": "answer.txt"})
    assert session.run().status == RunStatus.SUCCEEDED
    assert EventType.HUMAN_ANSWERED.value in [event.type for event in session.event_stream()]
