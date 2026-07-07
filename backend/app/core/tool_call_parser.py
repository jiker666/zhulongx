"""
Tool Call Parser — 双通道工具调用解析器。

支持三种输入格式：
1. OpenAI-compatible tool_calls（原生 function calling）
2. JSON 文本 tool_calls（国产模型兼容模式）
3. 旧格式文本（SHELL:/SCRIPT:/FLAG:/STUCK 等）

统一输出 List[ToolCall]。
解析失败不直接报错，返回 recoverable error 供 agent 重试。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from app.core.tool_protocol import ToolCall, make_tool_call

from dataclasses import dataclass

logger = logging.getLogger(__name__)

OLD_TYPE_MAP = {
    "shell": "run_shell",
    "script": "run_python",
    "flag": "submit_flag",
    "expand_context": "read_file",
    "replan": "internal_replan",
    "stuck": "ask_human",
}


@dataclass
class ParseResult:
    tool_calls: List[ToolCall]
    recoverable_error: str = ""
    raw_content: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tool_calls": [tc.to_dict() for tc in self.tool_calls],
            "recoverable_error": self.recoverable_error,
            "raw_content": self.raw_content[:500],
        }


def parse_tool_calls(content: str, native_tool_calls: Optional[List[Dict[str, Any]]] = None) -> ParseResult:
    raw = content.strip()
    if native_tool_calls:
        return _parse_native(native_tool_calls, raw)
    calls = _parse_json_tool_calls(raw)
    if calls:
        return ParseResult(tool_calls=calls, raw_content=raw)
    calls = _parse_old_format(raw)
    if calls:
        return ParseResult(tool_calls=calls, raw_content=raw)
    calls = _parse_nl_tool_calls(raw)
    if calls:
        return ParseResult(tool_calls=calls, raw_content=raw)
    return ParseResult(
        tool_calls=[],
        recoverable_error="无法解析工具调用，请输出 JSON 格式的 tool_calls 或使用 SHELL:/SCRIPT:/FLAG: 格式",
        raw_content=raw,
    )


_KNOWN_TOOLS = re.compile(
    r'(?:用|使用|调用|执行)\s+'
    r'(run_shell|run_python|http_request|list_dir|read_file|write_file|grep|extract_archive|submit_flag|ask_human|internal_replan)'
    r'[\s:：]?\s*(.+)',
    re.IGNORECASE,
)


def _parse_nl_tool_calls(content: str) -> List[ToolCall]:
    m = _KNOWN_TOOLS.search(content)
    if not m:
        return []
    name = m.group(1)
    detail = m.group(2).strip().rstrip("。.")
    args: Dict[str, Any] = {}
    if name == "run_shell":
        args = {"command": detail}
    elif name == "run_python":
        args = {"code": detail, "filename": "solve.py"}
    elif name == "http_request":
        args = {"url": detail}
    elif name == "submit_flag":
        args = {"flag": detail, "confidence": 0.8}
    elif name == "read_file":
        args = {"file": detail}
    elif name == "list_dir":
        args = {"path": detail}
    elif name == "internal_replan":
        args = {"reason": detail}
    elif name == "ask_human":
        args = {"question": detail}
    else:
        args = {"content": detail}
    return [make_tool_call(name=name, arguments=args, raw=content[:500])]


def _parse_native(native_tool_calls: List[Dict[str, Any]], raw: str) -> ParseResult:
    calls: List[ToolCall] = []
    for tc in native_tool_calls:
        func = tc.get("function", {})
        name = func.get("name", "")
        args_str = func.get("arguments", "{}")
        try:
            arguments = json.loads(args_str) if isinstance(args_str, str) else args_str
        except json.JSONDecodeError:
            arguments = {"_raw": args_str}
        tc_id = tc.get("id", "")
        calls.append(ToolCall(id=tc_id or f"native_{len(calls)}", name=name, arguments=arguments, raw=args_str))
    return ParseResult(tool_calls=calls, raw_content=raw)


def _parse_json_tool_calls(content: str) -> List[ToolCall]:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        json_match = re.search(r'\{[\s\S]*"tool_calls"[\s\S]*\}', text)
        if json_match:
            try:
                data = json.loads(json_match.group(0))
            except json.JSONDecodeError:
                json_match = None
        else:
            json_match = None
        if json_match is None:
            cb_match = re.search(r'```(?:json)?\s*\n?([\s\S]*?)\n?```', text)
            if cb_match:
                try:
                    data = json.loads(cb_match.group(1))
                except json.JSONDecodeError:
                    return []
            else:
                action_match = re.search(r'\{[\s\S]*"action"[\s\S]*\}', text)
                if action_match:
                    try:
                        data = json.loads(action_match.group(0))
                    except json.JSONDecodeError:
                        return []
                else:
                    return []
    if isinstance(data, dict) and "tool_calls" in data:
        calls: List[ToolCall] = []
        for tc in data["tool_calls"]:
            if not isinstance(tc, dict):
                continue
            name = tc.get("name", "")
            arguments = tc.get("arguments", {})
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {"_raw": arguments}
            calls.append(make_tool_call(name=name, arguments=arguments, raw=json.dumps(tc, ensure_ascii=False)))
        return calls
    if isinstance(data, dict) and "action" in data:
        action = data["action"]
        action_type = str(action.get("type", "")).lower().strip()
        action_content = action.get("content", "")
        mapped = OLD_TYPE_MAP.get(action_type, action_type)
        arguments: Dict[str, Any] = {}
        if mapped == "run_shell":
            arguments = {"command": str(action_content), "purpose": data.get("thought_summary", "")}
        elif mapped == "run_python":
            arguments = {"code": str(action_content), "filename": "solve.py"}
        elif mapped == "submit_flag":
            arguments = {"flag": str(action_content), "confidence": 0.8, "evidence": []}
        elif mapped == "read_file":
            if isinstance(action_content, dict):
                arguments = action_content
            elif isinstance(action_content, str):
                try:
                    arguments = json.loads(action_content)
                except json.JSONDecodeError:
                    arguments = {"file": action_content.strip()}
            else:
                arguments = {"file": str(action_content)}
        elif mapped == "internal_replan":
            arguments = {"reason": str(action_content)}
        elif mapped == "ask_human":
            arguments = {"question": str(action_content) if action_content else "I need help"}
        else:
            arguments = {"content": str(action_content)}
        extra = {}
        if data.get("hypotheses"):
            extra["hypotheses"] = data["hypotheses"]
        if data.get("thought_summary"):
            extra["thought_summary"] = data["thought_summary"]
        if extra:
            arguments["_extra"] = extra
        return [make_tool_call(name=mapped, arguments=arguments, raw=content[:500])]
    return []


def _parse_old_format(content: str) -> List[ToolCall]:
    clean = content
    if clean.startswith("```"):
        lines = clean.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        clean = "\n".join(lines).strip()
    upper = clean.upper()
    if upper.strip() == "STUCK" or upper.startswith("STUCK"):
        return [make_tool_call(name="ask_human", arguments={"question": clean[5:].strip() or "Agent stuck"}, raw=content)]
    m = re.match(r'^FLAG:\s*(.+)', clean, re.IGNORECASE)
    if m:
        return [make_tool_call(name="submit_flag", arguments={"flag": m.group(1).strip(), "confidence": 0.8, "evidence": []}, raw=content)]
    m = re.match(r'^SHELL:\s*(.+)', clean, re.IGNORECASE)
    if m:
        return [make_tool_call(name="run_shell", arguments={"command": m.group(1).strip(), "purpose": ""}, raw=content)]
    m = re.match(r'^SCRIPT:\s*(.+)', clean, re.IGNORECASE | re.DOTALL)
    if m:
        return [make_tool_call(name="run_python", arguments={"code": m.group(1).strip(), "filename": "solve.py"}, raw=content)]
    if upper.startswith("REPLAN"):
        return [make_tool_call(name="internal_replan", arguments={"reason": clean[6:].strip()}, raw=content)]
    if upper.startswith("EXPAND_CONTEXT"):
        return [make_tool_call(name="read_file", arguments={"file": clean[14:].strip()}, raw=content)]
    if clean.startswith("$ ") or clean.startswith("./"):
        return [make_tool_call(name="run_shell", arguments={"command": clean.lstrip("$ ").strip(), "purpose": ""}, raw=content)]
    if clean.startswith("python"):
        return [make_tool_call(name="run_python", arguments={"code": clean, "filename": "solve.py"}, raw=content)]
    return []
