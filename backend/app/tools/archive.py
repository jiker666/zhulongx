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
import gzip
import os
import shutil
import stat
import tarfile
import zipfile
from typing import Any, Dict, Optional

from app.tools.base import BaseTool
from app.core.tool_protocol import ToolSpec
from app.core.workspace_paths import resolve_workspace_path

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
            return {"success": False, "summary": f"路径超出 workspace: {path}", "details": {"error": "path_escape"}, "evidence": []}
        if not os.path.isfile(safe):
            return {"success": False, "summary": f"文件不存在: {path}", "details": {"error": "not_found"}, "evidence": []}
        extract_dir = os.path.join(workspace, "extracted", os.path.basename(safe))
        os.makedirs(extract_dir, exist_ok=True)
        lower = safe.lower()
        try:
            rejected = []
            if lower.endswith(".zip"):
                rejected = self._safe_extract_zip(safe, extract_dir)
            elif lower.endswith((".tar.gz", ".tgz")):
                rejected = self._safe_extract_tar(safe, extract_dir, mode="r:gz")
            elif lower.endswith(".tar"):
                rejected = self._safe_extract_tar(safe, extract_dir, mode="r:")
            elif lower.endswith(".gz") and not lower.endswith(".tar.gz"):
                out_name = os.path.basename(safe)[:-3]
                output = resolve_workspace_path(extract_dir, out_name)
                if output is None:
                    raise ValueError("gzip output escapes extraction directory")
                with gzip.open(safe, "rb") as src, output.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
            elif lower.endswith(".7z"):
                return {"success": False, "summary": "7z secure extraction is not available in the local sandbox", "details": {"error": "secure_extractor_unavailable"}, "evidence": []}
            else:
                return {"success": False, "summary": f"不支持的压缩格式: {os.path.basename(path)}", "details": {"error": "unsupported_format"}, "evidence": []}
            tree = self._get_file_tree(extract_dir, max_depth=3)
            return {
                "success": True,
                "summary": f"解压完成: {os.path.basename(path)}" + (f"; rejected {len(rejected)} unsafe member(s)" if rejected else ""),
                "details": {"extract_dir": extract_dir, "file_tree": tree, "rejected_members": rejected},
                "evidence": [],
            }
        except Exception as e:
            return {"success": False, "summary": f"解压失败: {e}", "details": {"error": str(e)}, "evidence": []}

    @staticmethod
    def _safe_path(workspace: str, path: str) -> Optional[str]:
        resolved = resolve_workspace_path(workspace, path)
        return str(resolved) if resolved is not None else None

    @staticmethod
    def _safe_extract_zip(zip_path: str, dest: str) -> list[str]:
        rejected: list[str] = []
        with zipfile.ZipFile(zip_path, "r") as zf:
            for info in zf.infolist():
                member = info.filename
                member_path = resolve_workspace_path(dest, member)
                unix_mode = info.external_attr >> 16
                if member_path is None or stat.S_ISLNK(unix_mode):
                    logger.warning("unsafe zip member rejected: %s", member)
                    rejected.append(member)
                    continue
                if info.is_dir():
                    member_path.mkdir(parents=True, exist_ok=True)
                else:
                    member_path.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as src, member_path.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        return rejected

    @staticmethod
    def _safe_extract_tar(tar_path: str, dest: str, *, mode: str) -> list[str]:
        rejected: list[str] = []
        with tarfile.open(tar_path, mode) as tf:
            for member in tf.getmembers():
                target = resolve_workspace_path(dest, member.name)
                if target is None or member.issym() or member.islnk() or member.isdev():
                    logger.warning("unsafe tar member rejected: %s", member.name)
                    rejected.append(member.name)
                    continue
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    rejected.append(member.name)
                    continue
                source = tf.extractfile(member)
                if source is None:
                    rejected.append(member.name)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
        return rejected

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
