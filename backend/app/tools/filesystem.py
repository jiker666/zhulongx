"""
Filesystem Tools — Codex/Claude Code 风格文件操作工具。

- ListDirTool: 列出目录内容
- ReadFileTool: 读取文件（支持 offset/limit）
- WriteFileTool: 写入文件（仅 workspace 内，保护原始附件）
- GrepTool: 在文件中搜索模式

所有路径归一化并限制在 workspace 内。
"""
from __future__ import annotations

import os
import re
from typing import Any, Dict, List, Optional

from app.tools.base import BaseTool
from app.core.tool_protocol import ToolSpec


class ListDirTool(BaseTool):
    name = "list_dir"
    description = "列出目录内容。路径限制在任务 workspace 内。"
    category = "filesystem"
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "目录路径（相对于 workspace，默认 '.'）"},
        },
        "required": [],
    }
    output_schema = {"type": "object", "properties": {"entries": {"type": "array"}}}
    permissions = ["local_read"]
    risk_level = "low"
    timeout_seconds = 5

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        workspace = context.get("workspace", ".")
        path = context.get("path", ".")
        safe = self._safe_path(workspace, path)
        if safe is None:
            return {"success": False, "summary": f"路径超出 workspace: {path}", "details": {"error": "path_escape"}}
        target = safe if os.path.isdir(safe) else workspace
        try:
            entries = []
            for entry in sorted(os.listdir(target)):
                full = os.path.join(target, entry)
                size = os.path.getsize(full) if os.path.isfile(full) else 0
                kind = "dir" if os.path.isdir(full) else "file"
                entries.append({"name": entry, "type": kind, "size": size})
            return {"success": True, "summary": f"列出 {len(entries)} 项", "details": {"entries": entries[:200]}, "evidence": []}
        except Exception as e:
            return {"success": False, "summary": str(e), "details": {"error": str(e)}, "evidence": []}

    @staticmethod
    def _safe_path(workspace: str, path: str) -> Optional[str]:
        ws = os.path.abspath(workspace)
        full = os.path.normpath(os.path.join(ws, path))
        if not full.startswith(ws + os.sep) and full != ws:
            return None
        return full

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )


class ReadFileTool(BaseTool):
    name = "read_file"
    description = "读取文件内容。支持 offset/limit 分段读取。路径限制在 workspace 内。"
    category = "filesystem"
    input_schema = {
        "type": "object",
        "properties": {
            "file": {"type": "string", "description": "文件路径（相对于 workspace）"},
            "offset": {"type": "integer", "description": "起始字节偏移", "default": 0},
            "limit": {"type": "integer", "description": "最大读取字节数", "default": 5000},
        },
        "required": ["file"],
    }
    output_schema = {"type": "object", "properties": {"content": {"type": "string"}}}
    permissions = ["local_read"]
    risk_level = "low"
    timeout_seconds = 10

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        workspace = context.get("workspace", ".")
        path = context.get("file", context.get("path", ""))
        if not path:
            return {"success": False, "summary": "no file specified", "details": {"error": "no_file"}, "evidence": []}
        safe = ListDirTool._safe_path(workspace, path)
        if safe is None:
            attachments = context.get("attachments", [])
            for a in attachments:
                if os.path.basename(a) == os.path.basename(path):
                    safe = a
                    break
            else:
                return {"success": False, "summary": f"路径超出 workspace: {path}", "details": {"error": "path_escape"}, "evidence": []}
        if not os.path.isfile(safe):
            return {"success": False, "summary": f"文件不存在: {path}", "details": {"error": "not_found"}, "evidence": []}
        offset = int(context.get("offset", 0))
        limit = int(context.get("limit", 5000))
        try:
            size = os.path.getsize(safe)
            with open(safe, "rb") as f:
                f.seek(offset)
                raw = f.read(min(limit, 200000))
            try:
                text = raw.decode("utf-8", errors="replace")
            except Exception:
                text = raw.decode("latin-1", errors="replace")
            header = f"[{os.path.basename(safe)} size={size} offset={offset} read={len(raw)}B]"
            return {"success": True, "summary": f"读取 {len(raw)} 字节", "details": {"content": header + "\n" + text, "size": size}, "evidence": []}
        except Exception as e:
            return {"success": False, "summary": str(e), "details": {"error": str(e)}, "evidence": []}

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )


class WriteFileTool(BaseTool):
    name = "write_file"
    description = "写入文件到 workspace。不能覆盖上传原始文件，除非 allow_overwrite=true。"
    category = "filesystem"
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "文件路径（相对于 workspace）"},
            "content": {"type": "string", "description": "文件内容"},
            "allow_overwrite": {"type": "boolean", "description": "是否允许覆盖上传原始文件", "default": False},
        },
        "required": ["path", "content"],
    }
    output_schema = {"type": "object", "properties": {"written": {"type": "boolean"}}}
    permissions = ["local_write"]
    risk_level = "medium"
    timeout_seconds = 5

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        workspace = context.get("workspace", ".")
        path = context.get("path", "")
        content = context.get("content", "")
        if not path:
            return {"success": False, "summary": "no path specified", "details": {"error": "no_path"}, "evidence": []}
        safe = ListDirTool._safe_path(workspace, path)
        if safe is None:
            return {"success": False, "summary": f"路径超出 workspace: {path}", "details": {"error": "path_escape"}, "evidence": []}
        attachments = context.get("attachments", [])
        for a in attachments:
            if os.path.basename(a) == os.path.basename(path):
                if not context.get("allow_overwrite", False):
                    return {"success": False, "summary": f"禁止覆盖上传原始文件: {path}", "details": {"error": "overwrite_denied"}, "evidence": []}
        try:
            os.makedirs(os.path.dirname(safe), exist_ok=True)
            with open(safe, "w", encoding="utf-8") as f:
                f.write(content)
            return {"success": True, "summary": f"写入 {len(content)} 字符到 {os.path.basename(path)}", "details": {"path": os.path.basename(path), "chars": len(content)}, "evidence": []}
        except Exception as e:
            return {"success": False, "summary": str(e), "details": {"error": str(e)}, "evidence": []}

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )


class GrepTool(BaseTool):
    name = "grep"
    description = "在文件中搜索正则模式。支持 glob 过滤和结果数量限制。"
    category = "filesystem"
    input_schema = {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "搜索正则模式"},
            "path": {"type": "string", "description": "搜索路径（相对于 workspace，默认 '.'）", "default": "."},
            "glob": {"type": "string", "description": "文件 glob 过滤", "default": "*"},
            "max_results": {"type": "integer", "description": "最大结果数", "default": 50},
        },
        "required": ["pattern"],
    }
    output_schema = {"type": "object", "properties": {"matches": {"type": "array"}}}
    permissions = ["local_read"]
    risk_level = "low"
    timeout_seconds = 15

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        from app.core.code_execution_sandbox import get_sandbox
        workspace = context.get("workspace", ".")
        pattern = context.get("pattern", "")
        if not pattern:
            return {"success": False, "summary": "no pattern specified", "details": {"error": "no_pattern"}, "evidence": []}
        path = context.get("path", ".")
        safe = ListDirTool._safe_path(workspace, path)
        if safe is None:
            return {"success": False, "summary": f"路径超出 workspace: {path}", "details": {"error": "path_escape"}, "evidence": []}
        target = safe if os.path.isdir(safe) else workspace
        glob_pat = context.get("glob", "*")
        max_results = int(context.get("max_results", 50))
        try:
            sandbox = get_sandbox(allow_network=False)
            res = sandbox.run_shell(
                f"grep -rn --include='{glob_pat}' '{pattern}' . 2>/dev/null | head -{max_results}",
                workdir=target, timeout=10,
            )
            matches = res.stdout.strip().splitlines() if res.stdout.strip() else []
            return {"success": True, "summary": f"找到 {len(matches)} 个匹配", "details": {"matches": matches[:max_results]}, "evidence": []}
        except Exception as e:
            return {"success": False, "summary": str(e), "details": {"error": str(e)}, "evidence": []}

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )
