"""
Evidence persistence helpers.
"""
from __future__ import annotations

import datetime
import hashlib
from typing import Optional

from sqlalchemy.orm import Session

from app.models.evidence import Evidence


class EvidenceVault:
    def create(
        self,
        db: Session,
        source_tool: str,
        input_summary: str,
        output_excerpt: str,
        challenge_id: Optional[int] = None,
        task_id: Optional[int] = None,
        reproduction_hint: str = "",
    ) -> Evidence:
        compact = (output_excerpt or "")[:4000]
        digest = hashlib.sha256(
            f"{source_tool}|{challenge_id}|{task_id}|{input_summary}|{compact}".encode("utf-8", errors="ignore")
        ).hexdigest()
        evidence = Evidence(
            evidence_uid="EV-" + digest[:12],
            source_tool=source_tool,
            challenge_id=challenge_id,
            task_id=task_id,
            input_summary=(input_summary or "")[:1000],
            output_excerpt=compact,
            content_hash=digest,
            reproduction_hint=(reproduction_hint or "")[:1000],
            created_at=datetime.datetime.utcnow(),
        )
        db.add(evidence)
        try:
            db.commit()
        except Exception:
            db.rollback()
            existing = db.query(Evidence).filter(Evidence.evidence_uid == evidence.evidence_uid).first()
            if existing:
                return existing
            raise
        db.refresh(evidence)
        return evidence

    def submission_text(self, evidence: Evidence, candidate: str = "") -> str:
        lines = []
        if candidate:
            lines.append(f"答案候选: {candidate}")
        lines.extend([
            f"证据 ID: {evidence.evidence_uid}",
            f"来源工具: {evidence.source_tool}",
            f"摘要: {evidence.output_excerpt[:500]}",
            f"复现路径: {evidence.reproduction_hint or '(见任务审计链)'}",
            f"Hash: {evidence.content_hash}",
        ])
        return "\n".join(lines)


evidence_vault = EvidenceVault()
