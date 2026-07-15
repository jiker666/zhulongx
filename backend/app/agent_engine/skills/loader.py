from __future__ import annotations

from app.agent_engine.skills.index import SkillIndex


class SkillLoader:
    def __init__(self, index: SkillIndex, *, max_chars: int = 120_000) -> None:
        self.index = index
        self.max_chars = max_chars

    def load(self, name: str) -> str:
        descriptor = self.index.get(name)
        if descriptor is None:
            raise KeyError(f"unknown skill: {name}")
        content = descriptor.path.read_text(encoding="utf-8", errors="replace")
        if len(content) > self.max_chars:
            content = content[: self.max_chars] + "\n...[skill truncated]"
        return content
