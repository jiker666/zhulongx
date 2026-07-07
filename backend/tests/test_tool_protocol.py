import pytest
from app.core.tool_protocol import (
    ToolSpec, ToolCall, ToolObservation, AgentTurn,
    new_tool_call_id, make_tool_call, make_observation,
)


def test_new_tool_call_id_format():
    tid = new_tool_call_id()
    assert tid.startswith("tc_")
    assert len(tid) == 15


def test_tool_spec_to_dict():
    spec = ToolSpec(name="run_shell", description="execute shell", risk_level="medium")
    d = spec.to_dict()
    assert d["name"] == "run_shell"
    assert d["risk_level"] == "medium"


def test_tool_spec_to_openai_tool():
    spec = ToolSpec(
        name="read_file", description="read file",
        input_schema={"type": "object", "properties": {"file": {"type": "string"}}},
    )
    oai = spec.to_openai_tool()
    assert oai["type"] == "function"
    assert oai["function"]["name"] == "read_file"


def test_tool_call_to_dict():
    tc = ToolCall(id="tc_abc", name="run_shell", arguments={"command": "ls"})
    d = tc.to_dict()
    assert d["id"] == "tc_abc"
    assert d["name"] == "run_shell"
    assert d["arguments"]["command"] == "ls"


def test_make_tool_call():
    tc = make_tool_call("read_file", {"file": "a.txt"})
    assert tc.name == "read_file"
    assert tc.arguments["file"] == "a.txt"
    assert tc.id.startswith("tc_")


def test_tool_observation_to_dict():
    obs = ToolObservation(
        tool_call_id="tc_1", tool_name="run_shell",
        success=True, output="ok", duration_ms=100,
    )
    d = obs.to_dict()
    assert d["success"] is True
    assert d["duration_ms"] == 100


def test_make_observation():
    tc = make_tool_call("grep", {"pattern": "flag"})
    obs = make_observation(tc, success=True, output="match found", duration_ms=50)
    assert obs.tool_call_id == tc.id
    assert obs.tool_name == "grep"
    assert obs.success is True


def test_agent_turn_to_dict():
    tc = make_tool_call("list_dir", {"path": "."})
    obs = make_observation(tc, success=True, output="file1\nfile2")
    turn = AgentTurn(
        turn_index=0, model="test", tool_calls=[tc], observations=[obs],
    )
    d = turn.to_dict()
    assert d["turn_index"] == 0
    assert len(d["tool_calls"]) == 1
    assert len(d["observations"]) == 1
