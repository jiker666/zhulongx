"""Apply the Worker filesystem boundary and replace this process."""
from __future__ import annotations

import os
import sys

from app.landlock import apply_workspace_landlock


def main() -> int:
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        print("usage: sandbox_exec WORKSPACE -- COMMAND [ARG ...]", file=sys.stderr)
        return 125
    workspace = sys.argv[1]
    command = sys.argv[3:]
    try:
        apply_workspace_landlock(workspace)
    except Exception as exc:
        print(f"workspace sandbox initialization failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 126
    os.execvpe(command[0], command, os.environ)
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
