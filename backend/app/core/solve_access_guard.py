"""
Blind-solve file access guard for local CTF cases.

The guard is intentionally small and explicit: solve-time file reads must stay
inside the current case material or the current run directory. It records every
decision so solve_trace.json can prove what data was available to the solver.
"""
from __future__ import annotations

import contextvars
import datetime as dt
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from app.config import settings


SUSPICIOUS_NAME_TERMS = (
    "expected",
    "answer",
    "flag",
    "solution",
    "writeup",
    "solved",
    "wp",
    "exploit",
)

DEFAULT_DENIED_TERMS = (
    "evaluator",
    "expected_answer",
    "solution",
    "writeup",
    "solves",
    "final_drill_outputs",
    "team_drill_outputs",
    "backups",
    "dist",
    ".git",
    "vector_db",
    "chroma",
    "faiss",
    "embeddings",
    "rag_store",
    "knowledge_base",
)


class SolveAccessDenied(PermissionError):
    pass


@dataclass
class SolveAccessDecision:
    path: str
    normalized_path: str
    allowed: bool
    reason: str
    tool_name: str
    challenge_id: str
    timestamp: str
    file_hash: str = ""
    suspicious_name: bool = False
    archive_member: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "normalized_path": self.normalized_path,
            "allowed": self.allowed,
            "reason": self.reason,
            "tool_name": self.tool_name,
            "challenge_id": self.challenge_id,
            "timestamp": self.timestamp,
            "file_hash": self.file_hash,
            "suspicious_name": self.suspicious_name,
            "archive_member": self.archive_member,
        }


def _split_roots(value: str) -> List[Path]:
    roots: List[Path] = []
    for chunk in (value or "").replace("\n", ",").replace(";", ",").split(","):
        item = chunk.strip()
        if item:
            roots.append(Path(item).expanduser())
    return roots


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _timestamp() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _parts_lower(path: Path) -> List[str]:
    return [part.lower() for part in path.parts]


class SolveAccessGuard:
    def __init__(
        self,
        case_dir: str | Path,
        run_dir: str | Path,
        challenge_id: str | int = "",
        case_id: str = "",
        allowed_roots: Optional[Iterable[str | Path]] = None,
        denied_roots: Optional[Iterable[str | Path]] = None,
        enabled: bool | None = None,
    ) -> None:
        self.case_dir = Path(case_dir).resolve()
        self.run_dir = Path(run_dir).resolve()
        self.challenge_id = str(challenge_id or "")
        self.case_id = case_id or self.case_dir.name
        self.enabled = bool(settings.BLIND_SOLVE_MODE if enabled is None else enabled)
        self.access_log: List[Dict[str, Any]] = []
        self.denied_access_log: List[Dict[str, Any]] = []
        configured_allowed = _split_roots(settings.SOLVE_ALLOWED_ROOTS)
        configured_denied = _split_roots(settings.SOLVE_DENIED_ROOTS)
        base_allowed = list(allowed_roots or configured_allowed or self._default_allowed_roots())
        base_denied = list(denied_roots or configured_denied or self._default_denied_roots())
        self.allowed_roots = [Path(root).expanduser().resolve() for root in base_allowed]
        self.denied_roots = [Path(root).expanduser().resolve() for root in base_denied if Path(root).expanduser().exists()]

    def _default_allowed_roots(self) -> List[Path]:
        return [
            self.case_dir / "challenge.json",
            self.case_dir / "README.md",
            self.case_dir / "scope.env.example",
            self.case_dir / "attachments",
            self.run_dir,
        ]

    def _default_denied_roots(self) -> List[Path]:
        repo = self.case_dir
        for parent in self.case_dir.parents:
            if (parent / "ctf_runs").exists() or (parent / "backend").exists():
                repo = parent
                break
        return [
            self.case_dir / "evaluator",
            self.case_dir / "expected_answer.txt",
            self.case_dir / "solution",
            self.case_dir / "writeup",
            self.case_dir / "solves",
            repo / "ctf_runs",
            repo / "samples" / "final_drill_outputs",
            repo / "samples" / "team_drill_outputs",
            repo / "backups",
            repo / "dist",
            repo / ".git",
        ]

    def validate_path(
        self,
        path: str | Path,
        tool_name: str = "solver",
        challenge_id: str | int | None = None,
        purpose: str = "read",
        allow_missing: bool = False,
    ) -> SolveAccessDecision:
        raw = Path(path).expanduser()
        challenge = str(challenge_id if challenge_id is not None else self.challenge_id)
        normalized = raw.resolve(strict=False)
        reason = "blind solve access allowed"
        suspicious = self._is_suspicious_name(normalized)
        allowed = True

        if not self.enabled:
            decision = self._decision(raw, normalized, True, "blind solve mode disabled", tool_name, challenge, suspicious)
            self._record(decision)
            return decision

        if raw.is_symlink():
            allowed = False
            reason = "symbolic links are denied in blind solve mode"
        elif not allow_missing and not normalized.exists():
            allowed = False
            reason = "path does not exist"
        elif self._is_denied(normalized):
            allowed = False
            reason = "path matches denied solve root or denied term"
        elif not self._is_allowed(normalized):
            allowed = False
            reason = "path is outside allowed solve roots"
        elif purpose != "write" and normalized.exists() and normalized.is_dir():
            allowed = False
            reason = "directory content reads are not allowed through file read guard"
        elif suspicious and not self._inside_attachments(normalized):
            allowed = False
            reason = "suspicious answer-like path outside current attachments"
        elif suspicious:
            reason = "attachment path allowed but marked suspicious_name=true"

        decision = self._decision(raw, normalized, allowed, reason, tool_name, challenge, suspicious)
        self._record(decision)
        if not allowed:
            raise SolveAccessDenied(f"{reason}: {normalized}")
        return decision

    def validate_archive_member(
        self,
        archive_path: str | Path,
        member_name: str,
        tool_name: str = "solver",
        challenge_id: str | int | None = None,
    ) -> SolveAccessDecision:
        raw_archive = Path(archive_path).expanduser()
        archive = raw_archive.resolve(strict=False)
        challenge = str(challenge_id if challenge_id is not None else self.challenge_id)
        member = Path(member_name)
        suspicious = self._is_suspicious_name(member)
        allowed = True
        reason = "archive member allowed"
        if member.is_absolute() or ".." in member.parts:
            allowed = False
            reason = "archive member path escapes archive root"
        elif any(term in member.name.lower() for term in SUSPICIOUS_NAME_TERMS) and not self._inside_attachments(archive):
            allowed = False
            reason = "suspicious archive member outside current attachments"
        elif self._member_has_denied_term(member):
            allowed = False
            reason = "archive member matches denied solve term"
        elif suspicious:
            reason = "archive member allowed but marked suspicious_name=true"
        decision = self._decision(raw_archive, archive, allowed, reason, tool_name, challenge, suspicious, archive_member=member_name)
        self._record(decision)
        if not allowed:
            raise SolveAccessDenied(f"{reason}: {archive}!{member_name}")
        return decision

    def read_text(self, path: str | Path, tool_name: str = "solver", challenge_id: str | int | None = None) -> str:
        decision = self.validate_path(path, tool_name=tool_name, challenge_id=challenge_id)
        data = Path(decision.normalized_path).read_bytes()
        self._attach_hash(decision, data)
        return data.decode("utf-8", errors="ignore")

    def read_bytes(
        self,
        path: str | Path,
        tool_name: str = "solver",
        challenge_id: str | int | None = None,
        max_bytes: int | None = None,
    ) -> bytes:
        decision = self.validate_path(path, tool_name=tool_name, challenge_id=challenge_id)
        data = Path(decision.normalized_path).read_bytes()
        if max_bytes is not None:
            data = data[:max_bytes]
        self._attach_hash(decision, data)
        return data

    def _decision(
        self,
        raw: Path,
        normalized: Path,
        allowed: bool,
        reason: str,
        tool_name: str,
        challenge_id: str,
        suspicious: bool,
        archive_member: str = "",
    ) -> SolveAccessDecision:
        return SolveAccessDecision(
            path=str(raw),
            normalized_path=str(normalized),
            allowed=allowed,
            reason=reason,
            tool_name=tool_name,
            challenge_id=challenge_id,
            timestamp=_timestamp(),
            suspicious_name=suspicious,
            archive_member=archive_member,
        )

    def _record(self, decision: SolveAccessDecision) -> None:
        row = decision.to_dict()
        self.access_log.append(row)
        if not decision.allowed:
            self.denied_access_log.append(row)

    def _attach_hash(self, decision: SolveAccessDecision, data: bytes) -> None:
        digest = hashlib.sha256(data).hexdigest()
        decision.file_hash = digest
        for row in reversed(self.access_log):
            if row["timestamp"] == decision.timestamp and row["normalized_path"] == decision.normalized_path:
                row["file_hash"] = digest
                break

    def _is_allowed(self, normalized: Path) -> bool:
        for root in self.allowed_roots:
            if normalized == root or (root.is_dir() and _inside(normalized, root)):
                return True
        return False

    def _is_denied(self, normalized: Path) -> bool:
        if _inside(normalized, self.run_dir) or normalized == self.run_dir:
            return False
        for root in self.denied_roots:
            if normalized == root or _inside(normalized, root):
                return True
        parts = _parts_lower(normalized)
        for idx, part in enumerate(parts):
            if part in {".git", "evaluator", "solution", "writeup", "solves", "backups", "dist"}:
                return True
            if part in {"vector_db", "chroma", "faiss", "embeddings", "rag_store", "knowledge_base"}:
                return True
            if "expected_answer" in part:
                return True
            if part == "ctf_runs" and not _inside(normalized, self.run_dir):
                return True
            if idx >= 1 and parts[idx - 1] == "docs" and part in {"demo_answers.md", "sample_answers.md"}:
                return True
        return False

    def _is_suspicious_name(self, path: Path) -> bool:
        name = path.name.lower()
        return any(term in name for term in SUSPICIOUS_NAME_TERMS)

    def _member_has_denied_term(self, member: Path) -> bool:
        parts = [part.lower() for part in member.parts]
        return any(part in {"evaluator", "solution", "writeup", "solves"} or "expected_answer" in part for part in parts)

    def _inside_attachments(self, path: Path) -> bool:
        attachments = (self.case_dir / "attachments").resolve(strict=False)
        return path == attachments or _inside(path, attachments)

    def to_trace(self) -> Dict[str, Any]:
        return {
            "access_log": self.access_log,
            "denied_access_log": self.denied_access_log,
            "allowed_roots": [str(root) for root in self.allowed_roots],
            "denied_roots": [str(root) for root in self.denied_roots],
        }


_active_guard: contextvars.ContextVar[SolveAccessGuard | None] = contextvars.ContextVar("active_solve_access_guard", default=None)


def set_active_solve_guard(guard: SolveAccessGuard) -> contextvars.Token:
    return _active_guard.set(guard)


def get_active_solve_guard() -> SolveAccessGuard | None:
    return _active_guard.get()


def reset_active_solve_guard(guard_context: contextvars.Token) -> None:
    _active_guard.reset(guard_context)
