from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Mapping

from app.agent_engine.tools.types import ToolContext, ToolResult


def resolve_path(workspace: Path, requested: str) -> Path | None:
    candidate = Path(requested).expanduser()
    if not candidate.is_absolute():
        candidate = workspace / candidate
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(workspace.resolve())
    except ValueError:
        return None
    return resolved


def _readonly_inputs(context: ToolContext) -> set[Path]:
    readonly: set[Path] = set()
    for item in context.request.inputs:
        if item.readonly:
            readonly.add(Path(item.path).expanduser().resolve(strict=False))
    return readonly


class ListDirExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        target = resolve_path(context.workspace, str(arguments.get("path", ".")))
        if target is None:
            return ToolResult(False, "path escapes workspace", error="path_escape")
        if not target.is_dir():
            return ToolResult(False, "directory does not exist", error="not_a_directory")
        entries = []
        for entry in sorted(target.iterdir(), key=lambda item: item.name)[:500]:
            resolved = entry.resolve(strict=False)
            inside = resolve_path(context.workspace, str(resolved)) is not None
            entries.append({
                "name": entry.name,
                "type": "symlink" if entry.is_symlink() else ("directory" if entry.is_dir() else "file"),
                "size": entry.stat().st_size if entry.is_file() and inside else 0,
                "accessible": inside,
            })
        return ToolResult(True, f"listed {len(entries)} entries", output=json.dumps(entries, ensure_ascii=False))


class ReadFileExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        target = resolve_path(context.workspace, str(arguments["path"]))
        if target is None:
            return ToolResult(False, "path escapes workspace", error="path_escape")
        if not target.is_file():
            return ToolResult(False, "file does not exist", error="not_found")
        offset = int(arguments.get("offset", 0))
        limit = int(arguments.get("limit", 10000))
        with target.open("rb") as source:
            source.seek(offset)
            data = source.read(limit)
        output = data.decode("utf-8", errors="replace")
        return ToolResult(
            True,
            f"read {len(data)} bytes",
            output=output,
            metadata={"path": str(target.relative_to(context.workspace)), "offset": offset, "bytes": len(data)},
        )


class WriteFileExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        target = resolve_path(context.workspace, str(arguments["path"]))
        if target is None:
            return ToolResult(False, "path escapes workspace", error="path_escape")
        if target in _readonly_inputs(context):
            return ToolResult(False, "input is read-only", error="readonly_input")
        target.parent.mkdir(parents=True, exist_ok=True)
        content = str(arguments["content"])
        target.write_text(content, encoding="utf-8")
        return ToolResult(
            True,
            f"wrote {len(content)} characters",
            metadata={"path": str(target.relative_to(context.workspace)), "characters": len(content)},
        )


class GrepExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        target = resolve_path(context.workspace, str(arguments.get("path", ".")))
        if target is None:
            return ToolResult(False, "path escapes workspace", error="path_escape")
        try:
            pattern = re.compile(str(arguments["pattern"]))
        except re.error as exc:
            return ToolResult(False, "invalid regular expression", error=str(exc))
        max_results = int(arguments.get("max_results", 50))
        files = [target] if target.is_file() else (
            Path(root) / filename
            for root, dirs, names in os.walk(target, followlinks=False)
            for filename in names
        )
        matches: list[dict[str, Any]] = []
        for path in files:
            safe = resolve_path(context.workspace, str(path))
            if safe is None or not safe.is_file():
                continue
            try:
                text = safe.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for line_number, line in enumerate(text.splitlines(), 1):
                if pattern.search(line):
                    matches.append({
                        "path": str(safe.relative_to(context.workspace)),
                        "line": line_number,
                        "text": line[:1000],
                    })
                    if len(matches) >= max_results:
                        return ToolResult(True, f"found {len(matches)} matches", output=json.dumps(matches, ensure_ascii=False))
        return ToolResult(True, f"found {len(matches)} matches", output=json.dumps(matches, ensure_ascii=False))
