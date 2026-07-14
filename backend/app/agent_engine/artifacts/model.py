from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class ExtractionResult:
    extractor: str
    summary: str
    metadata: Mapping[str, Any]
    chunks: tuple[str, ...] = ()
    risk_tags: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    original_name: str
    media_type: str
    size: int
    sha256: str
    source: str
    storage_path: str
    derived_from: tuple[str, ...] = ()
    extraction: ExtractionResult | None = None
    risk_tags: tuple[str, ...] = ()
    visibility: str = "run"
    evidence_ids: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["extraction"] = self.extraction.to_dict() if self.extraction else None
        return value
