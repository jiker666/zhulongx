from __future__ import annotations

import shutil
import stat
import tarfile
import zipfile
from pathlib import Path
from typing import Any, Mapping

from app.agent_engine.tools.builtin.filesystem import resolve_path
from app.agent_engine.tools.types import ToolContext, ToolResult


class ExtractArchiveExecutor:
    def execute(self, context: ToolContext, arguments: Mapping[str, Any]) -> ToolResult:
        source = resolve_path(context.workspace, str(arguments["path"]))
        if source is None:
            return ToolResult(False, "archive path escapes workspace", error="path_escape")
        if not source.is_file():
            return ToolResult(False, "archive does not exist", error="not_found")
        destination = context.workspace / ".extracted" / source.name
        destination.mkdir(parents=True, exist_ok=True)
        rejected: list[str] = []
        try:
            if zipfile.is_zipfile(source):
                rejected = self._zip(source, destination)
            elif tarfile.is_tarfile(source):
                rejected = self._tar(source, destination)
            else:
                return ToolResult(False, "unsupported archive format", error="unsupported_format")
        except (OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
            return ToolResult(False, "archive extraction failed", error=f"{type(exc).__name__}: {exc}")
        files = [
            str(item.relative_to(context.workspace))
            for item in sorted(destination.rglob("*"))
            if item.is_file() and resolve_path(context.workspace, str(item)) is not None
        ][:500]
        return ToolResult(
            True,
            f"extracted {len(files)} files; rejected {len(rejected)} unsafe members",
            output="\n".join(files),
            artifacts=({"path": str(destination.relative_to(context.workspace)), "kind": "extracted_directory"},),
            metadata={"files": files, "rejected_members": rejected},
        )

    @staticmethod
    def _target(destination: Path, name: str) -> Path | None:
        target = (destination / name).resolve(strict=False)
        try:
            target.relative_to(destination.resolve())
        except ValueError:
            return None
        return target

    @classmethod
    def _zip(cls, source: Path, destination: Path) -> list[str]:
        rejected = []
        with zipfile.ZipFile(source) as archive:
            for member in archive.infolist():
                target = cls._target(destination, member.filename)
                mode = member.external_attr >> 16
                if target is None or stat.S_ISLNK(mode):
                    rejected.append(member.filename)
                    continue
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as input_file, target.open("wb") as output:
                    shutil.copyfileobj(input_file, output)
        return rejected

    @classmethod
    def _tar(cls, source: Path, destination: Path) -> list[str]:
        rejected = []
        with tarfile.open(source) as archive:
            for member in archive.getmembers():
                target = cls._target(destination, member.name)
                if target is None or member.issym() or member.islnk() or member.isdev():
                    rejected.append(member.name)
                    continue
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not member.isfile():
                    rejected.append(member.name)
                    continue
                input_file = archive.extractfile(member)
                if input_file is None:
                    rejected.append(member.name)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with input_file, target.open("wb") as output:
                    shutil.copyfileobj(input_file, output)
        return rejected
