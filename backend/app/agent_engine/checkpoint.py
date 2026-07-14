from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class CheckpointSnapshot:
    run_id: str
    state: Mapping[str, Any]
    budget_usage: Mapping[str, Any]
    event_offset: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "state": dict(self.state),
            "budget_usage": dict(self.budget_usage),
            "event_offset": self.event_offset,
        }


class CheckpointStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, run_id: str) -> Path:
        safe_id = "".join(char for char in run_id if char.isalnum() or char in {"-", "_"})
        if not safe_id or safe_id != run_id:
            raise ValueError("invalid run id for checkpoint")
        return self.root / f"{safe_id}.json"

    def save(self, snapshot: CheckpointSnapshot) -> Path:
        target = self._path(snapshot.run_id)
        temporary = target.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(snapshot.to_dict(), ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        temporary.replace(target)
        return target

    def load(self, run_id: str) -> CheckpointSnapshot:
        raw = json.loads(self._path(run_id).read_text(encoding="utf-8"))
        if raw.get("run_id") != run_id:
            raise ValueError("checkpoint run id mismatch")
        return CheckpointSnapshot(
            run_id=run_id,
            state=raw["state"],
            budget_usage=raw["budget_usage"],
            event_offset=int(raw["event_offset"]),
        )

    def exists(self, run_id: str) -> bool:
        return self._path(run_id).is_file()
