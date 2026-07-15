from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from app.agent_engine.state import RunRequest


_SENSITIVE_KEY = re.compile(
    r"(?i)(api[_-]?key|(?:^|[_-])token$|secret|password|credential|authorization_header)"
)
_SECRET_TEXT = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{8,}\b")


def _sanitize(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): "***REDACTED***" if _SENSITIVE_KEY.search(str(key)) else _sanitize(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    if isinstance(value, str):
        return _SECRET_TEXT.sub(lambda match: (match.group(1) if match.lastindex else "") + "***REDACTED***", value)
    return value


@dataclass(frozen=True)
class RunMetadata:
    run_id: str
    request: RunRequest
    scenario_config: Mapping[str, Any]
    created_at: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "run_id": self.run_id,
            "request": self.request.to_dict(),
            "scenario_config": dict(self.scenario_config),
            "created_at": self.created_at,
        }


class RunMetadataStore:
    """Atomic, secret-free run metadata used to reconstruct sessions."""

    FILENAME = "run.json"

    @classmethod
    def for_workspace(cls, workspace: str | Path) -> "RunMetadataStore":
        return cls(Path(workspace) / ".agent_state" / cls.FILENAME)

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser().resolve()

    def save(
        self,
        run_id: str,
        request: RunRequest,
        *,
        scenario_config: Mapping[str, Any] | None = None,
    ) -> Path:
        metadata = RunMetadata(run_id, request, scenario_config or {}, time.time())
        payload = metadata.to_dict()
        authorization = dict(payload["request"].get("authorization", {}))
        payload["request"]["authorization"] = {
            key: bool(authorization.get(key, False))
            for key in ("authorized", "allow_process", "allow_private_network")
            if key in authorization
        }
        payload = _sanitize(payload)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        temporary.replace(self.path)
        return self.path

    def load(self) -> RunMetadata:
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        if raw.get("version") != 1:
            raise ValueError("unsupported run metadata version")
        request = RunRequest.from_dict(raw["request"])
        run_id = str(raw["run_id"])
        if not run_id or Path(request.workspace).expanduser().resolve() != self.path.parents[1]:
            raise ValueError("run metadata workspace mismatch")
        return RunMetadata(
            run_id=run_id,
            request=request,
            scenario_config=dict(raw.get("scenario_config", {})),
            created_at=float(raw.get("created_at", 0.0)),
        )

    @classmethod
    def discover(cls, root: str | Path) -> list["RunMetadataStore"]:
        base = Path(root).expanduser().resolve()
        if not base.is_dir():
            return []
        return [cls(path) for path in sorted(base.rglob(f".agent_state/{cls.FILENAME}")) if path.is_file()]
