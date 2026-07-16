from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable, Mapping

from app.agent_engine.context_budget import estimate_tokens


@dataclass(frozen=True)
class ArtifactChunk:
    artifact_id: str
    locator: str
    content: str
    score: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "locator": self.locator,
            "content": self.content,
            "score": self.score,
        }


class ArtifactRetriever:
    """Rank indexed extraction chunks without loading original attachments into memory."""

    def retrieve(
        self,
        artifacts: Iterable[Mapping[str, Any]],
        query: str,
        *,
        max_tokens: int,
        allowed_artifact_ids: Iterable[str] = (),
    ) -> tuple[ArtifactChunk, ...]:
        terms = {item.casefold() for item in re.findall(r"[A-Za-z0-9_]{3,}", query)}
        allowed = {str(item) for item in allowed_artifact_ids}
        candidates: list[ArtifactChunk] = []
        for artifact in artifacts:
            artifact_id = str(artifact.get("artifact_id") or "")
            if allowed and artifact_id not in allowed:
                continue
            extraction = artifact.get("extraction")
            if not isinstance(extraction, Mapping):
                continue
            chunks = extraction.get("chunks") or ()
            for index, raw in enumerate(chunks):
                content = str(raw)
                folded = content.casefold()
                score = sum(1 for term in terms if term in folded)
                score += 1 if index == 0 else 0
                candidates.append(ArtifactChunk(artifact_id, f"chunk:{index}", content, score))
        candidates.sort(key=lambda item: (-item.score, item.artifact_id, item.locator))
        selected: list[ArtifactChunk] = []
        used = 0
        for candidate in candidates:
            cost = estimate_tokens(candidate.to_dict())
            if selected and used + cost > max_tokens:
                continue
            if cost > max_tokens:
                bounded_chars = max(64, int(max_tokens * 3))
                candidate = ArtifactChunk(
                    candidate.artifact_id,
                    candidate.locator,
                    candidate.content[:bounded_chars],
                    candidate.score,
                )
                cost = estimate_tokens(candidate.to_dict())
            selected.append(candidate)
            used += cost
            if used >= max_tokens:
                break
        return tuple(selected)
