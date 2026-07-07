import json
import pytest
from app.core.tool_call_parser import parse_tool_calls


def test_parse_native_tool_calls():
    native = [{"id": "call_1", "function": {"name": "run_shell", "arguments": '{"command": "ls"}'}}]
    result = parse_tool_calls("", native_tool_calls=native)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "run_shell"
    assert result.tool_calls[0].arguments["command"] == "ls"


def test_parse_json_tool_calls_format():
    content = json.dumps({"tool_calls": [{"name": "read_file", "arguments": {"file": "a.txt"}}]})
    result = parse_tool_calls(content)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "read_file"
    assert result.tool_calls[0].arguments["file"] == "a.txt"


def test_parse_json_action_format():
    content = json.dumps({"action": {"type": "shell", "content": "ls -la"}})
    result = parse_tool_calls(content)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "run_shell"
    assert result.tool_calls[0].arguments["command"] == "ls -la"


def test_parse_old_flag_format():
    result = parse_tool_calls("FLAG: flag{test123}")
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "submit_flag"
    assert result.tool_calls[0].arguments["flag"] == "flag{test123}"


def test_parse_old_shell_format():
    result = parse_tool_calls("SHELL: cat /etc/passwd")
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "run_shell"
    assert result.tool_calls[0].arguments["command"] == "cat /etc/passwd"


def test_parse_old_script_format():
    result = parse_tool_calls("SCRIPT: print(1+1)")
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "run_python"
    assert result.tool_calls[0].arguments["code"] == "print(1+1)"


def test_parse_old_stuck_format():
    result = parse_tool_calls("STUCK")
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "ask_human"


def test_parse_old_replan_format():
    result = parse_tool_calls("REPLAN need different approach")
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "internal_replan"


def test_parse_dollar_prompt():
    result = parse_tool_calls("$ ls -la")
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "run_shell"
    assert result.tool_calls[0].arguments["command"] == "ls -la"


def test_parse_unrecognized_returns_recoverable():
    result = parse_tool_calls("just some random text without any tool call")
    assert len(result.tool_calls) == 0
    assert result.recoverable_error != ""


def test_parse_code_block_wrapped_json():
    content = '```json\n{"tool_calls": [{"name": "grep", "arguments": {"pattern": "flag"}}]}\n```'
    result = parse_tool_calls(content)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "grep"


def test_native_takes_priority():
    native = [{"id": "call_1", "function": {"name": "read_file", "arguments": '{"file": "b.txt"}'}}]
    content = json.dumps({"tool_calls": [{"name": "run_shell", "arguments": {"command": "ls"}}]})
    result = parse_tool_calls(content, native_tool_calls=native)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "read_file"


def test_parse_json_action_flag():
    content = json.dumps({"action": {"type": "flag", "content": "flag{abc}"}})
    result = parse_tool_calls(content)
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].name == "submit_flag"
    assert result.tool_calls[0].arguments["flag"] == "flag{abc}"
