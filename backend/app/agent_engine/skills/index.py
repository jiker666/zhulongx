from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class SkillDescriptor:
    name: str
    title: str
    description: str
    applicable_scenarios: tuple[str, ...]
    required_tools: tuple[str, ...]
    path: Path

    def prompt_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "description": self.description,
            "applicable_scenarios": list(self.applicable_scenarios),
            "required_tools": list(self.required_tools),
        }


class SkillIndex:
    def __init__(self, descriptors: list[SkillDescriptor]) -> None:
        self._descriptors = {item.name: item for item in descriptors}

    @classmethod
    def scan(cls, root: str | Path) -> "SkillIndex":
        root_path = Path(root).expanduser().resolve()
        descriptors: list[SkillDescriptor] = []
        if not root_path.is_dir():
            return cls([])
        for path in sorted(root_path.glob("*/SKILL.md")):
            preview = path.read_text(encoding="utf-8", errors="replace")[:4096]
            name = path.parent.name
            title_match = re.search(r"(?m)^#\s+(.+?)\s*$", preview)
            title = title_match.group(1).strip() if title_match else name
            description = cls._first_description(preview, title_match.end() if title_match else 0)
            required_tools = tuple(sorted(set(re.findall(r"`([a-z][a-z0-9_-]{1,40})`", preview))))[:12]
            scenarios = ("ctf",) if name in {"ctf", "crypto", "forensics", "hard_ctf", "misc", "pwn", "reverse", "web"} else (name,)
            descriptors.append(SkillDescriptor(
                name=name,
                title=title,
                description=description,
                applicable_scenarios=scenarios,
                required_tools=required_tools,
                path=path.resolve(),
            ))
        return cls(descriptors)

    @staticmethod
    def _first_description(preview: str, offset: int) -> str:
        for block in re.split(r"\n\s*\n", preview[offset:]):
            cleaned = " ".join(line.strip() for line in block.splitlines() if line.strip() and not line.lstrip().startswith(("#", "-", "```")))
            if cleaned:
                return cleaned[:240]
        return "Load this skill for its specialized workflow."

    def get(self, name: str) -> SkillDescriptor | None:
        return self._descriptors.get(name)

    def descriptors(self) -> tuple[SkillDescriptor, ...]:
        return tuple(sorted(self._descriptors.values(), key=lambda item: item.name))

    def prompt_index(self, *, scenario: str | None = None) -> list[dict[str, object]]:
        descriptors = self.descriptors()
        if scenario:
            descriptors = tuple(item for item in descriptors if scenario in item.applicable_scenarios)
        return [item.prompt_dict() for item in descriptors]
