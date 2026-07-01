"""
Blackboard — 事实黑板（v6 借鉴 Cairn）。

三元组：
- Fact: 事实（文件线索、候选 flag、错误、工具结果、约束）
- Intent: 意图（待执行 / 进行中 / 完成 / 失败 / 弃用）
- Hint: 人工 / Observer / 系统提示

职责：
- SQLite 持久化 + 内存缓存
- Orchestrator 每一步自动写入事实
- 发现候选 flag 写入 candidate fact
- 失败脚本写入 error fact
- 提供 API 查询 / 更新
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from sqlalchemy import desc, select

from app.database import SessionLocal
from app.models.blackboard import CtfFact, CtfHint, CtfIntent

logger = logging.getLogger(__name__)


@dataclass
class Fact:
    """事实黑板条目（业务层）。"""
    fact_id: str
    task_id: str
    kind: str  # file|clue|candidate|error|tool_result|constraint
    content: str
    confidence: float = 0.5
    source_step: str = ""
    evidence_ref: Optional[str] = None
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "fact_id": self.fact_id,
            "task_id": self.task_id,
            "kind": self.kind,
            "content": self.content,
            "confidence": self.confidence,
            "source_step": self.source_step,
            "evidence_ref": self.evidence_ref,
            "created_at": self.created_at,
        }


@dataclass
class Intent:
    """意图队列条目（业务层）。"""
    intent_id: str
    task_id: str
    title: str
    rationale: str = ""
    status: str = "pending"  # pending|in_progress|completed|failed|deprecated
    priority: int = 5
    depends_on: List[str] = field(default_factory=list)
    result_fact_ids: List[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "intent_id": self.intent_id,
            "task_id": self.task_id,
            "title": self.title,
            "rationale": self.rationale,
            "status": self.status,
            "priority": self.priority,
            "depends_on": self.depends_on,
            "result_fact_ids": self.result_fact_ids,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass
class Hint:
    """提示条目（业务层）。"""
    hint_id: str
    task_id: str
    content: str
    source: str = "system"  # human|observer|system
    consumed: bool = False
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "hint_id": self.hint_id,
            "task_id": self.task_id,
            "content": self.content,
            "source": self.source,
            "consumed": self.consumed,
            "created_at": self.created_at,
        }


class Blackboard:
    """事实黑板 + 意图队列 + 提示（SQLite 持久化 + 内存缓存）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    # ---------- Fact ----------

    def add_fact(
        self,
        *,
        task_id: str,
        kind: str,
        content: str,
        confidence: float = 0.5,
        source_step: str = "",
        evidence_ref: Optional[str] = None,
        fact_id: Optional[str] = None,
    ) -> Fact:
        """写入一条事实。"""
        fid = fact_id or f"fact_{uuid.uuid4().hex[:12]}"
        fact = Fact(
            fact_id=fid, task_id=task_id, kind=kind, content=content,
            confidence=confidence, source_step=source_step,
            evidence_ref=evidence_ref, created_at=time.time(),
        )
        with SessionLocal() as db:
            row = CtfFact(
                task_id=task_id, fact_id=fid, kind=kind, content=content,
                confidence=confidence, source_step=source_step,
                evidence_ref=evidence_ref, created_at=fact.created_at,
            )
            db.add(row)
            db.commit()
        return fact

    def list_facts(
        self, task_id: str, *, kind: Optional[str] = None, limit: int = 200
    ) -> List[Fact]:
        with SessionLocal() as db:
            stmt = select(CtfFact).where(CtfFact.task_id == task_id)
            if kind:
                stmt = stmt.where(CtfFact.kind == kind)
            stmt = stmt.order_by(desc(CtfFact.created_at)).limit(limit)
            rows = db.execute(stmt).scalars().all()
        return [Fact(
            fact_id=r.fact_id, task_id=r.task_id, kind=r.kind,
            content=r.content, confidence=r.confidence,
            source_step=r.source_step, evidence_ref=r.evidence_ref,
            created_at=r.created_at,
        ) for r in rows]

    def get_candidates(self, task_id: str) -> List[Fact]:
        """获取候选 flag facts。"""
        return self.list_facts(task_id, kind="candidate")

    def get_recent_errors(self, task_id: str, limit: int = 5) -> List[Fact]:
        return self.list_facts(task_id, kind="error", limit=limit)

    def fact_count(self, task_id: str) -> int:
        return len(self.list_facts(task_id, limit=10000))

    # ---------- Intent ----------

    def add_intent(
        self,
        *,
        task_id: str,
        title: str,
        rationale: str = "",
        status: str = "pending",
        priority: int = 5,
        depends_on: Optional[List[str]] = None,
        result_fact_ids: Optional[List[str]] = None,
        intent_id: Optional[str] = None,
    ) -> Intent:
        iid = intent_id or f"intent_{uuid.uuid4().hex[:12]}"
        now = time.time()
        intent = Intent(
            intent_id=iid, task_id=task_id, title=title,
            rationale=rationale, status=status, priority=priority,
            depends_on=depends_on or [], result_fact_ids=result_fact_ids or [],
            created_at=now, updated_at=now,
        )
        with SessionLocal() as db:
            row = CtfIntent(
                task_id=task_id, intent_id=iid, title=title, rationale=rationale,
                status=status, priority=priority,
                depends_on=json.dumps(intent.depends_on),
                result_fact_ids=json.dumps(intent.result_fact_ids),
                created_at=now, updated_at=now,
            )
            db.add(row)
            db.commit()
        return intent

    def list_intents(
        self, task_id: str, *, status: Optional[str] = None, limit: int = 100
    ) -> List[Intent]:
        with SessionLocal() as db:
            stmt = select(CtfIntent).where(CtfIntent.task_id == task_id)
            if status:
                stmt = stmt.where(CtfIntent.status == status)
            stmt = stmt.order_by(desc(CtfIntent.created_at)).limit(limit)
            rows = db.execute(stmt).scalars().all()
        return [Intent(
            intent_id=r.intent_id, task_id=r.task_id, title=r.title,
            rationale=r.rationale, status=r.status, priority=r.priority,
            depends_on=_safe_json_list(r.depends_on),
            result_fact_ids=_safe_json_list(r.result_fact_ids),
            created_at=r.created_at, updated_at=r.updated_at,
        ) for r in rows]

    def update_intent(
        self,
        task_id: str,
        intent_id: str,
        *,
        status: Optional[str] = None,
        result_fact_ids: Optional[List[str]] = None,
        title: Optional[str] = None,
        rationale: Optional[str] = None,
        priority: Optional[int] = None,
    ) -> Optional[Intent]:
        with SessionLocal() as db:
            stmt = select(CtfIntent).where(
                CtfIntent.task_id == task_id, CtfIntent.intent_id == intent_id
            )
            row = db.execute(stmt).scalar_one_or_none()
            if not row:
                return None
            if status is not None:
                row.status = status
            if title is not None:
                row.title = title
            if rationale is not None:
                row.rationale = rationale
            if priority is not None:
                row.priority = priority
            if result_fact_ids is not None:
                row.result_fact_ids = json.dumps(result_fact_ids)
            row.updated_at = time.time()
            db.commit()
            return Intent(
                intent_id=row.intent_id, task_id=row.task_id, title=row.title,
                rationale=row.rationale, status=row.status, priority=row.priority,
                depends_on=_safe_json_list(row.depends_on),
                result_fact_ids=_safe_json_list(row.result_fact_ids),
                created_at=row.created_at, updated_at=row.updated_at,
            )

    def deprecate_intents(self, task_id: str, intent_ids: List[str]) -> int:
        """批量弃用意图。"""
        n = 0
        for iid in intent_ids:
            if self.update_intent(task_id, iid, status="deprecated"):
                n += 1
        return n

    # ---------- Hint ----------

    def add_hint(
        self,
        *,
        task_id: str,
        content: str,
        source: str = "system",
        hint_id: Optional[str] = None,
    ) -> Hint:
        hid = hint_id or f"hint_{uuid.uuid4().hex[:12]}"
        hint = Hint(
            hint_id=hid, task_id=task_id, content=content,
            source=source, consumed=False, created_at=time.time(),
        )
        with SessionLocal() as db:
            row = CtfHint(
                task_id=task_id, hint_id=hid, content=content,
                source=source, consumed=0, created_at=hint.created_at,
            )
            db.add(row)
            db.commit()
        return hint

    def list_hints(self, task_id: str, *, include_consumed: bool = True, limit: int = 100) -> List[Hint]:
        with SessionLocal() as db:
            stmt = select(CtfHint).where(CtfHint.task_id == task_id)
            if not include_consumed:
                stmt = stmt.where(CtfHint.consumed == 0)
            stmt = stmt.order_by(desc(CtfHint.created_at)).limit(limit)
            rows = db.execute(stmt).scalars().all()
        return [Hint(
            hint_id=r.hint_id, task_id=r.task_id, content=r.content,
            source=r.source, consumed=bool(r.consumed), created_at=r.created_at,
        ) for r in rows]

    def mark_hint_consumed(self, task_id: str, hint_id: str) -> bool:
        with SessionLocal() as db:
            stmt = select(CtfHint).where(
                CtfHint.task_id == task_id, CtfHint.hint_id == hint_id
            )
            row = db.execute(stmt).scalar_one_or_none()
            if not row:
                return False
            row.consumed = 1
            db.commit()
            return True

    # ---------- snapshot for API / Observer ----------

    def snapshot(self, task_id: str) -> Dict[str, Any]:
        """返回黑板全量快照（供前端 / Observer 使用）。"""
        return {
            "task_id": task_id,
            "facts": [f.to_dict() for f in self.list_facts(task_id, limit=500)],
            "intents": [i.to_dict() for i in self.list_intents(task_id, limit=200)],
            "hints": [h.to_dict() for h in self.list_hints(task_id, limit=100)],
            "fact_count": self.fact_count(task_id),
            "candidate_count": len(self.get_candidates(task_id)),
        }

    # ---------- reset ----------

    def reset_task(self, task_id: str) -> None:
        """清空某 task 的所有黑板数据。"""
        with SessionLocal() as db:
            db.query(CtfFact).filter(CtfFact.task_id == task_id).delete()
            db.query(CtfIntent).filter(CtfIntent.task_id == task_id).delete()
            db.query(CtfHint).filter(CtfHint.task_id == task_id).delete()
            db.commit()


def _safe_json_list(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    try:
        v = json.loads(raw)
        return v if isinstance(v, list) else []
    except Exception:
        return []


# 全局单例
_blackboard: Optional[Blackboard] = None
_bb_lock = threading.Lock()


def get_blackboard() -> Blackboard:
    global _blackboard
    if _blackboard is None:
        with _bb_lock:
            if _blackboard is None:
                _blackboard = Blackboard()
    return _blackboard
