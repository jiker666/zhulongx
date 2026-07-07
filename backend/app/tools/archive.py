"""
ExtractArchiveTool — 解压压缩包工具。

支持格式：zip/tar/tar.gz/gz/7z
安全约束：
- 解压路径必须在 workspace/extracted 下
- 防 zip slip 路径穿越
- 返回文件树摘要
"""
from __future__ import annotations

import logging
import os
import zipfile
from typing import Any, Dict, Optional

from app.tools.base import BaseTool
from app.core.tool_protocol import ToolSpec

logger = logging.getLogger(__name__)


class ExtractArchiveTool(BaseTool):
    name = "extract_archive"
    description = "解压压缩包（zip/tar/tar.gz/gz/7z）。防 zip slip 路径穿越。解压到 workspace/extracted/。"
    category = "filesystem"
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "压缩包路径（相对于 workspace）"},
        },
        "required": ["path"],
    }
    output_schema = {"type": "object", "properties": {"file_tree": {"type": "string"}}}
    permissions = ["local_read", "local_write"]
    risk_level = "medium"
    timeout_seconds = 60

    def run(self, context: Dict[str, Any]) -> Dict[str, Any]:
        from app.core.code_execution_sandbox import get_sandbox
        workspace = context.get("workspace", ".")
        path = context.get("path", "")
        if not path:
            return {"success": False, "summary": "no path specified", "details": {"error": "no_path"}, "evidence": []}
        safe = self._safe_path(workspace, path)
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
        extract_dir = os.path.join(workspace, "extracted", os.path.basename(safe))
        os.makedirs(extract_dir, exist_ok=True)
        lower = safe.lower()
        try:
            if lower.endswith(".zip"):
                self._safe_extract_zip(safe, extract_dir)
            elif lower.endswith((".tar.gz", ".tgz")):
                sandbox = get_sandbox(allow_network=False)
                res = sandbox.run_shell(f"tar xzf '{safe}' -C '{extract_dir}'", workdir=workspace, timeout=30)
                if not res.success:
                    return {"success": False, "summary": f"tar 解压失败: {res.stderr[:200]}", "details": {"error": res.stderr[:500]}, "evidence": []}
            elif lower.endswith(".tar"):
                sandbox = get_sandbox(allow_network=False)
                res = sandbox.run_shell(f"tar xf '{safe}' -C '{extract_dir}'", workdir=workspace, timeout=30)
                if not res.success:
                    return {"success": False, "summary": f"tar 解压失败: {res.stderr[:200]}", "details": {"error": res.stderr[:500]}, "evidence": []}
            elif lower.endswith(".gz") and not lower.endswith(".tar.gz"):
                sandbox = get_sandbox(allow_network=False)
                out_name = os.path.basename(safe)[:-3]
                res = sandbox.run_shell(f"gunzip -k -c '{safe}' > '{extract_dir}/{out_name}'", workdir=workspace, timeout=15)
                if not res.success:
                    return {"success": False, "summary": f"gunzip 失败: {res.stderr[:200]}", "details": {"error": res.stderr[:500]}, "evidence": []}
            elif lower.endswith(".7z"):
                sandbox = get_sandbox(allow_network=False)
                res = sandbox.run_shell(f"7z x '{safe}' -o'{extract_dir}' -y 2>/dev/null || echo '7z not available'", workdir=workspace, timeout=30)
            else:
                return {"success": False, "summary": f"不支持的压缩格式: {os.path.basename(path)}", "details": {"error": "unsupported_format"}, "evidence": []}
            tree = self._get_file_tree(extract_dir, max_depth=3)
            return {
                "success": True,
                "summary": f"解压完成: {os.path.basename(path)}",
                "details": {"extract_dir": extract_dir, "file_tree": tree},
                "evidence": [],
            }
        except Exception as e:
            return {"success": False, "summary": f"解压失败: {e}", "details": {"error": str(e)}, "evidence": []}

    @staticmethod
    def _safe_path(workspace: str, path: str) -> Optional[str]:
        ws = os.path.abspath(workspace)
        full = os.path.normpath(os.path.join(ws, path))
        if not full.startswith(ws + os.sep) and full != ws:
            return None
        return full

    @staticmethod
    def _safe_extract_zip(zip_path: str, dest: str) -> None:
        dest_abs = os.path.abspath(dest)
        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.namelist():
                member_path = os.path.normpath(os.path.join(dest, member))
                if not member_path.startswith(dest_abs + os.sep) and member_path != dest_abs:
                    logger.warning("zip slip detected: %s", member)
                    continue
                if member.endswith("/"):
                    os.makedirs(member_path, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(member_path), exist_ok=True)
                    with zf.open(member) as src, open(member_path, "wb") as dst:
                        dst.write(src.read())

    @staticmethod
    def _get_file_tree(path: str, max_depth: int = 3, prefix: str = "") -> str:
        if max_depth <= 0:
            return ""
        lines = []
        try:
            entries = sorted(os.listdir(path))
        except PermissionError:
            return f"{prefix}(permission denied)"
        for entry in entries[:50]:
            full = os.path.join(path, entry)
            if os.path.isdir(full):
                lines.append(f"{prefix}{entry}/")
                lines.append(ExtractArchiveTool._get_file_tree(full, max_depth - 1, prefix + "  "))
            else:
                size = os.path.getsize(full)
                lines.append(f"{prefix}{entry} ({size}B)")
        return "\n".join(lines)

    @classmethod
    def as_spec(cls) -> ToolSpec:
        return ToolSpec(
            name=cls.name, description=cls.description,
            input_schema=cls.input_schema, permissions=cls.permissions,
            risk_level=cls.risk_level, timeout_seconds=cls.timeout_seconds,
        )
