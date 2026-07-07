"""
Tool Protocol — Codex/Claude Code 风格 Agent 工具协议层。

定义统一数据结构：
- ToolSpec: 工具描述 + 参数 schema + 权限 + 风险等级
- ToolCall: 一次工具调用的请求
- ToolObservation: 一次工具调用的返回结果
- AgentTurn: 一轮 agent 交互的完整记录
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: Dict[str, Any] = field(default_factory=dict)
    permissions: List[str] = field(default_factory=lambda: ["local_read"])
    risk_level: str = "low"
    timeout_seconds: int = 30

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
            "permissions": self.permissions,
            "risk_level": self.risk_level,
            "timeout_seconds": self.timeout_seconds,
        }

    def to_openai_tool(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: Dict[str, Any] = field(default_factory=dict)
    raw: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "arguments": self.arguments,
            "raw": self.raw[:500],
        }


@dataclass
class ToolObservation:
    tool_call_id: str
    tool_name: str
    success: bool
    output: str = ""
    error: str = ""
    artifacts: Dict[str, Any] = field(default_factory=dict)
    duration_ms: int = 0
    truncated: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "tool_call_id": self.tool_call_id,
            "tool_name": self.tool_name,
            "success": self.success,
            "output": self.output[:5000],
            "error": self.error[:1000],
            "artifacts": self.artifacts,
            "duration_ms": self.duration_ms,
            "truncated": self.truncated,
        }


@dataclass
class AgentTurn:
    turn_index: int
    model: str = ""
    input_summary: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    observations: List[ToolObservation] = field(default_factory=list)
    final_answer: str = ""
    usage: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "turn_index": self.turn_index,
            "model": self.model,
            "input_summary": self.input_summary[:500],
            "tool_calls": [tc.to_dict() for tc in self.tool_calls],
            "observations": [obs.to_dict() for obs in self.observations],
            "final_answer": self.final_answer[:1000],
            "usage": self.usage,
        }


def new_tool_call_id() -> str:
    return f"tc_{uuid.uuid4().hex[:12]}"


def make_tool_call(name: str, arguments: Dict[str, Any], raw: str = "") -> ToolCall:
    return ToolCall(id=new_tool_call_id(), name=name, arguments=arguments, raw=raw)


def make_observation(
    tool_call: ToolCall,
    *,
    success: bool,
    output: str = "",
    error: str = "",
    artifacts: Optional[Dict[str, Any]] = None,
    duration_ms: int = 0,
    truncated: bool = False,
) -> ToolObservation:
    return ToolObservation(
        tool_call_id=tool_call.id,
        tool_name=tool_call.name,
        success=success,
        output=output,
        error=error,
        artifacts=artifacts or {},
        duration_ms=duration_ms,
        truncated=truncated,
    )
