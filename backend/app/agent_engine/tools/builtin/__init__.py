from __future__ import annotations

from app.agent_engine.tools.builtin.candidate import SubmitCandidateExecutor
from app.agent_engine.tools.builtin.archive import ExtractArchiveExecutor
from app.agent_engine.tools.builtin.filesystem import GrepExecutor, ListDirExecutor, ReadFileExecutor, WriteFileExecutor
from app.agent_engine.tools.builtin.http import HttpRequestExecutor
from app.agent_engine.tools.builtin.human import AskHumanExecutor
from app.agent_engine.tools.builtin.process import RunPythonExecutor, RunShellExecutor
from app.agent_engine.tools.builtin.skill import LoadSkillExecutor
from app.agent_engine.tools.registry import ToolRegistry
from app.agent_engine.tools.types import ToolDefinition
from app.agent_engine.skills.loader import SkillLoader


def build_builtin_registry(
    skill_loader: SkillLoader | None = None,
    *,
    http_executor: HttpRequestExecutor | None = None,
) -> ToolRegistry:
    registry = ToolRegistry()
    definitions = (
        ToolDefinition(
            name="list_dir",
            description="List files and directories inside the run workspace.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string", "maxLength": 4096}},
                "additionalProperties": False,
            },
            risk_level="low",
            permissions=("local_read",),
            timeout_seconds=5,
            executor=ListDirExecutor(),
        ),
        ToolDefinition(
            name="read_file",
            description="Read a bounded byte range from a workspace file.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "offset": {"type": "integer", "minimum": 0},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200000},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
            risk_level="low",
            permissions=("local_read",),
            timeout_seconds=10,
            executor=ReadFileExecutor(),
        ),
        ToolDefinition(
            name="write_file",
            description="Write a text file inside the writable run workspace.",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "content": {"type": "string", "maxLength": 1000000},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
            risk_level="medium",
            permissions=("local_write",),
            timeout_seconds=10,
            executor=WriteFileExecutor(),
        ),
        ToolDefinition(
            name="grep",
            description="Search workspace text files with a regular expression.",
            input_schema={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "minLength": 1, "maxLength": 1000},
                    "path": {"type": "string", "maxLength": 4096},
                    "max_results": {"type": "integer", "minimum": 1, "maximum": 200},
                },
                "required": ["pattern"],
                "additionalProperties": False,
            },
            risk_level="low",
            permissions=("local_read",),
            timeout_seconds=15,
            executor=GrepExecutor(),
        ),
        ToolDefinition(
            name="run_shell",
            description="Run a shell command in the configured sandbox workspace.",
            input_schema={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "minLength": 1, "maxLength": 20000},
                    "timeout_seconds": {"type": "number", "minimum": 0.1, "maximum": 30},
                },
                "required": ["command"],
                "additionalProperties": False,
            },
            risk_level="high",
            permissions=("process_execution",),
            timeout_seconds=30,
            executor=RunShellExecutor(),
        ),
        ToolDefinition(
            name="run_python",
            description="Run Python code in the configured sandbox workspace.",
            input_schema={
                "type": "object",
                "properties": {
                    "code": {"type": "string", "minLength": 1, "maxLength": 200000},
                    "timeout_seconds": {"type": "number", "minimum": 0.1, "maximum": 30},
                },
                "required": ["code"],
                "additionalProperties": False,
            },
            risk_level="high",
            permissions=("process_execution",),
            timeout_seconds=30,
            executor=RunPythonExecutor(),
        ),
        ToolDefinition(
            name="submit_candidate",
            description="Submit a candidate result with evidence event references for validation.",
            input_schema={
                "type": "object",
                "properties": {
                    "candidate": {"type": "string", "minLength": 1, "maxLength": 4096},
                    "evidence_event_ids": {"type": "array", "items": {"type": "string"}},
                    "reproduction": {"type": "string", "maxLength": 20000},
                },
                "required": ["candidate"],
                "additionalProperties": False,
            },
            risk_level="low",
            permissions=("candidate_submit",),
            timeout_seconds=5,
            executor=SubmitCandidateExecutor(),
        ),
        ToolDefinition(
            name="extract_archive",
            description="Extract ZIP or TAR members inside the workspace with traversal and link checks.",
            input_schema={
                "type": "object",
                "properties": {"path": {"type": "string", "minLength": 1, "maxLength": 4096}},
                "required": ["path"],
                "additionalProperties": False,
            },
            risk_level="medium",
            permissions=("local_read", "local_write"),
            timeout_seconds=30,
            executor=ExtractArchiveExecutor(),
        ),
        ToolDefinition(
            name="http_request",
            description="Send one non-redirecting HTTP request to an explicitly authorized allowlisted target.",
            input_schema={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "minLength": 1, "maxLength": 8192},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]},
                    "headers": {"type": "object"},
                    "body": {"type": "string", "maxLength": 1000000},
                    "timeout_seconds": {"type": "number", "minimum": 0.1, "maximum": 20},
                },
                "required": ["url"],
                "additionalProperties": False,
            },
            risk_level="high",
            permissions=("network_access",),
            timeout_seconds=20,
            executor=http_executor or HttpRequestExecutor(),
        ),
        ToolDefinition(
            name="ask_human",
            description="Pause the run and request a specific human decision or missing input.",
            input_schema={
                "type": "object",
                "properties": {"question": {"type": "string", "minLength": 1, "maxLength": 10000}},
                "required": ["question"],
                "additionalProperties": False,
            },
            risk_level="low",
            permissions=(),
            timeout_seconds=5,
            executor=AskHumanExecutor(),
        ),
    )
    for definition in definitions:
        registry.register(definition)
    if skill_loader is not None:
        registry.register(ToolDefinition(
            name="load_skill",
            description="Load the full body of one indexed skill on demand.",
            input_schema={
                "type": "object",
                "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 100}},
                "required": ["name"],
                "additionalProperties": False,
            },
            risk_level="low",
            permissions=("local_read",),
            timeout_seconds=5,
            executor=LoadSkillExecutor(skill_loader),
        ))
    return registry


__all__ = ["build_builtin_registry"]
