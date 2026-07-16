from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Iterable


class PrivateTranscriptStore:
    """Restricted local storage for exact provider-native reasoning blocks."""

    VERSION = 1

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.path.parent.chmod(0o700)
        except OSError:
            pass

    def load(self) -> list[tuple[str, str]]:
        if not self.path.is_file():
            return []
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        if raw.get("version") != self.VERSION:
            raise ValueError("unsupported private transcript version")
        records: list[tuple[str, str]] = []
        for item in raw.get("records", []):
            fingerprint = str(item.get("fingerprint") or "")
            reasoning = str(item.get("reasoning_content") or "")
            if fingerprint and reasoning:
                records.append((fingerprint, reasoning))
        return records

    def save(self, records: Iterable[tuple[str, str]]) -> None:
        payload = {
            "version": self.VERSION,
            "records": [
                {"fingerprint": fingerprint, "reasoning_content": reasoning}
                for fingerprint, reasoning in records
            ],
        }
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, sort_keys=True)
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            temporary.unlink(missing_ok=True)
            raise
        temporary.chmod(0o600)
        temporary.replace(self.path)
        self.path.chmod(0o600)

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)

