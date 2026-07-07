import pytest
from app.tools.flag_submit import SubmitFlagTool


def test_submit_flag_valid():
    tool = SubmitFlagTool()
    result = tool.run({"flag": "flag{valid_flag}", "confidence": 0.9, "evidence": ["found in output"]})
    assert result["success"] is True
    assert result["details"]["accepted"] is True
    assert result["details"]["valid_format"] is True


def test_submit_flag_ctf_format():
    tool = SubmitFlagTool()
    result = tool.run({"flag": "CTF{uppercase}", "confidence": 0.8})
    assert result["success"] is True


def test_submit_flag_key_format():
    tool = SubmitFlagTool()
    result = tool.run({"flag": "key{some_key}", "confidence": 0.7})
    assert result["success"] is True


def test_submit_flag_invalid_format_does_not_crash():
    tool = SubmitFlagTool()
    result = tool.run({"flag": "not_a_flag_at_all", "confidence": 0.1})
    assert result["success"] is False
    assert result["details"]["accepted"] is False


def test_submit_flag_invalid_format_continues_loop():
    tool = SubmitFlagTool()
    result = tool.run({"flag": "random_string", "confidence": 0.2})
    assert result["success"] is False
    assert "reason" in result["details"]


def test_submit_flag_empty():
    tool = SubmitFlagTool()
    result = tool.run({"flag": ""})
    assert result["success"] is False


def test_submit_flag_no_flag():
    tool = SubmitFlagTool()
    result = tool.run({})
    assert result["success"] is False


def test_submit_flag_custom_format_rejection():
    tool = SubmitFlagTool()
    result = tool.run({"flag": "flag{test}", "confidence": 0.9, "flag_format": r"HTB\{.*\}"})
    assert result["success"] is False
    assert "不符合格式" in result["summary"]


def test_submit_flag_custom_format_acceptance():
    tool = SubmitFlagTool()
    result = tool.run({"flag": "HTB{pwned}", "confidence": 0.9, "flag_format": r"HTB\{.*\}"})
    assert result["success"] is True


def test_submit_flag_tool_metadata():
    tool = SubmitFlagTool()
    assert tool.name == "submit_flag"
    assert tool.category == "ctf"
    assert tool.risk_level == "low"
