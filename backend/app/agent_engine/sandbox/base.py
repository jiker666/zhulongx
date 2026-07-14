from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence

from app.agent_engine.abort import AbortToken


@dataclass(frozen=True)
class ProcessResult:
    success: bool
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    timed_out: bool = False
    aborted: bool = False


class Sandbox(ABC):
    release_capable: bool = False

    @abstractmethod
    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        abort_token: AbortToken,
        env: Mapping[str, str] | None = None,
    ) -> ProcessResult:
        raise NotImplementedError

    @abstractmethod
    def abort_all(self) -> None:
        raise NotImplementedError
