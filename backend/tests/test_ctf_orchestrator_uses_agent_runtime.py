import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest


def _get_orch():
    from app.core.ctf_agent_orchestrator import CtfOrchestrator
    return CtfOrchestrator


def test_parse_agent_action_uses_tool_call_parser():
    CtfOrchestrator = _get_orch()
    orch = CtfOrchestrator.__new__(CtfOrchestrator)
    content = json.dumps({"tool_calls": [{"name": "run_shell", "arguments": {"command": "ls"}}]})
    action, detail, extra = orch._parse_agent_action(content)
    assert action == "SHELL"
    assert detail == "ls"


def test_parse_agent_action_flag():
    CtfOrchestrator = _get_orch()
    orch = CtfOrchestrator.__new__(CtfOrchestrator)
    content = json.dumps({"tool_calls": [{"name": "submit_flag", "arguments": {"flag": "flag{test}"}}]})
    action, detail, extra = orch._parse_agent_action(content)
    assert action == "FLAG"
    assert detail == "flag{test}"


def test_parse_agent_action_stuck():
    CtfOrchestrator = _get_orch()
    orch = CtfOrchestrator.__new__(CtfOrchestrator)
    content = json.dumps({"tool_calls": [{"name": "ask_human", "arguments": {"question": "I need help"}}]})
    action, detail, extra = orch._parse_agent_action(content)
    assert action == "STUCK"
    assert detail == "I need help"


def test_parse_agent_action_replan():
    CtfOrchestrator = _get_orch()
    orch = CtfOrchestrator.__new__(CtfOrchestrator)
    content = json.dumps({"tool_calls": [{"name": "internal_replan", "arguments": {"reason": "stuck"}}]})
    action, detail, extra = orch._parse_agent_action(content)
    assert action == "REPLAN"


def test_parse_agent_action_unknown():
    CtfOrchestrator = _get_orch()
    orch = CtfOrchestrator.__new__(CtfOrchestrator)
    action, detail, extra = orch._parse_agent_action("random nonsense")
    assert action == "UNKNOWN"


def test_parse_agent_action_old_format_shell():
    CtfOrchestrator = _get_orch()
    orch = CtfOrchestrator.__new__(CtfOrchestrator)
    action, detail, extra = orch._parse_agent_action("SHELL: cat flag.txt")
    assert action == "SHELL"
    assert detail == "cat flag.txt"


def test_parse_agent_action_old_format_flag():
    CtfOrchestrator = _get_orch()
    orch = CtfOrchestrator.__new__(CtfOrchestrator)
    action, detail, extra = orch._parse_agent_action("FLAG: flag{abc}")
    assert action == "FLAG"
    assert detail == "flag{abc}"
