"""Resolved workspace path containment shared by legacy compatibility code."""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Union


PathLike = Union[str, Path]


def resolve_workspace_path(workspace: PathLike, requested: PathLike) -> Optional[Path]:
    """Return the resolved path only when it remains inside the workspace.

    ``Path.resolve(strict=False)`` follows every existing symlink in the path,
    including the final component, so reads and writes through an escaping
    symlink are rejected before the caller opens the target.
    """

    root = Path(workspace).expanduser().resolve()
    candidate = Path(requested).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError:
        return None
    return resolved


def is_within_workspace(workspace: PathLike, requested: PathLike) -> bool:
    return resolve_workspace_path(workspace, requested) is not None
