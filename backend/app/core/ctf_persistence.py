"""
CTF Persistence Layer — 把 Orchestrator 内存状态 ↔ SQLite 持久化。

设计原则：
- Orchestrator 仍以 CtfTask dataclass 为主，作为运行时状态
- 每次状态变化都同步写 DB（save_task / append_event / append_artifact / upsert_flag）
- 重启后通过 load_task() 从 DB 恢复 CtfTask（只读视图，不能再 run）
- expected_flag 仅写入 DB 用于 benchmark，永远不让 orchestrator/LLM 读取
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.ctf import CtfTask as CtfTaskModel, CtfEvent, CtfArtifact, CtfFlag

logger = logging.getLogger(__name__)


def _j(obj: Any) -> str:
    """safe JSON encode"""
    if obj is None:
        return ""
    try:
        return json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        return ""


def _jd(s: str, default: Any = None) -> Any:
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default


def save_task(task_dict: Dict[str, Any]) -> None:
    """upsert task main record (idempotent)."""
    db: Session = SessionLocal()
    try:
        tid = task_dict["task_id"]
        row = db.query(CtfTaskModel).filter(CtfTaskModel.task_id == tid).first()
        if row is None:
            row = CtfTaskModel(task_id=tid)
            db.add(row)
        # 基本字段
        row.title = task_dict.get("title", row.title or "")
        row.description = task_dict.get("description", row.description or "")
        row.category_hint = task_dict.get("category_hint", row.category_hint or "auto")
        row.flag_format = task_dict.get("flag_format") or None
        row.authorized = bool(task_dict.get("authorized", False))
        row.allow_network = bool(task_dict.get("allow_network", False))
        if "allowed_hosts" in task_dict:
            row.allowed_hosts = _j(task_dict.get("allowed_hosts", [])) or "[]"
        if "allowed_ports" in task_dict:
            row.allowed_ports = _j(task_dict.get("allowed_ports", [])) or "[]"
        row.max_rounds = int(task_dict.get("max_rounds", 8))
        row.max_time_sec = int(task_dict.get("max_time_sec", row.max_time_sec or 600))
        if "attachments" in task_dict:
            row.attachments = _j(task_dict.get("attachments", [])) or "[]"
        row.state = task_dict.get("state", row.state or "INIT")
        row.rounds_used = int(task_dict.get("rounds_used", 0))
        row.plan_json = _j(task_dict.get("plan")) or row.plan_json
        analysis = task_dict.get("analysis")
        if not isinstance(analysis, dict):
            analysis = _jd(row.analysis_json, {}) or {}
        else:
            analysis = dict(analysis)
        if "execution_mode" in task_dict or "max_parallel_agents" in task_dict:
            analysis["_managed_run"] = {
                "version": 1,
                "execution_mode": str(task_dict.get("execution_mode") or "auto"),
                "max_parallel_agents": int(task_dict.get("max_parallel_agents", 4) or 4),
            }
        row.analysis_json = _j(analysis) or row.analysis_json
        row.current_script = task_dict.get("current_script", "") or ""
        row.best_flag = task_dict.get("best_flag") or None
        # writeup_md: 仅在 to_dict() 提供时更新（避免空覆盖）
        wu = task_dict.get("writeup_md")
        if wu:
            row.writeup_md = wu
        row.error = task_dict.get("error", "") or ""
        # source 元数据（仅创建时设置，之后保留）
        if task_dict.get("source") and not row.source:
            row.source = task_dict["source"]
        if task_dict.get("demo_id") and not row.demo_id:
            row.demo_id = task_dict["demo_id"]
        if task_dict.get("expected_flag") and not row.expected_flag:
            row.expected_flag = task_dict["expected_flag"]
        if task_dict.get("engine"):
            row.engine = str(task_dict["engine"])
        if task_dict.get("agent_run_id"):
            row.agent_run_id = str(task_dict["agent_run_id"])
        if task_dict.get("agent_workspace"):
            row.agent_workspace = str(task_dict["agent_workspace"])
        # running 状态
        running = bool(task_dict.get("is_running", False))
        row.is_running = running
        if running and row.started_at is None:
            import datetime
            row.started_at = datetime.datetime.utcnow()
        if not running and row.started_at is not None and row.finished_at is None:
            import datetime
            row.finished_at = datetime.datetime.utcnow()
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("save_task failed: %s: %s", type(e).__name__, e)
    finally:
        db.close()


def append_event(task_id: str, event_dict: Dict[str, Any]) -> None:
    """append an evidence event."""
    db: Session = SessionLocal()
    try:
        ev = CtfEvent(
            task_id=task_id,
            step=event_dict.get("step", ""),
            timestamp=float(event_dict.get("timestamp", time.time())),
            duration_ms=int(event_dict.get("duration_ms", 0)),
            input_summary=(event_dict.get("input_summary") or "")[:500],
            output_summary=(event_dict.get("output_summary") or "")[:500],
            success=bool(event_dict.get("success", True)),
            artifacts_json=_j(event_dict.get("artifacts", {})) or "{}",
        )
        db.add(ev)
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("append_event failed: %s", e)
    finally:
        db.close()


def append_artifact(task_id: str, run_index: int, art_dict: Dict[str, Any]) -> None:
    """append a script run result."""
    db: Session = SessionLocal()
    try:
        a = CtfArtifact(
            task_id=task_id,
            run_index=run_index,
            success=bool(art_dict.get("success", False)),
            exit_code=int(art_dict.get("exit_code", 0)),
            stdout=(art_dict.get("stdout") or "")[:50000],
            stderr=(art_dict.get("stderr") or "")[:20000],
            duration_ms=int(art_dict.get("duration_ms", 0)),
            timed_out=bool(art_dict.get("timed_out", False)),
            workdir=art_dict.get("workdir", ""),
            error=art_dict.get("error"),
        )
        db.add(a)
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("append_artifact failed: %s", e)
    finally:
        db.close()


def upsert_flag(task_id: str, flag_dict: Dict[str, Any]) -> None:
    """upsert a candidate flag (dedupe by task_id+flag)."""
    db: Session = SessionLocal()
    try:
        flag = flag_dict.get("flag", "")
        if not flag:
            return
        existing = (
            db.query(CtfFlag)
            .filter(CtfFlag.task_id == task_id, CtfFlag.flag == flag)
            .first()
        )
        if existing:
            # bump confidence
            existing.confidence = min(0.99, float(existing.confidence or 0.5) + 0.1)
            db.commit()
            return
        f = CtfFlag(
            task_id=task_id,
            flag=flag,
            source=str(flag_dict.get("source", ""))[:256],
            line=flag_dict.get("line"),
            snippet=(flag_dict.get("snippet") or "")[:500],
            confidence=float(flag_dict.get("confidence", 0.5)),
            matched_pattern=flag_dict.get("matched_pattern"),
        )
        db.add(f)
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("upsert_flag failed: %s", e)
    finally:
        db.close()


def load_task_view(task_id: str) -> Optional[Dict[str, Any]]:
    """Load a task from DB as dict (for read-only views / API)."""
    db: Session = SessionLocal()
    try:
        row = db.query(CtfTaskModel).filter(CtfTaskModel.task_id == task_id).first()
        if row is None:
            return None
        events = (
            db.query(CtfEvent)
            .filter(CtfEvent.task_id == task_id)
            .order_by(CtfEvent.id.asc())
            .all()
        )
        artifacts = (
            db.query(CtfArtifact)
            .filter(CtfArtifact.task_id == task_id)
            .order_by(CtfArtifact.id.asc())
            .all()
        )
        flags = (
            db.query(CtfFlag)
            .filter(CtfFlag.task_id == task_id)
            .order_by(CtfFlag.confidence.desc())
            .all()
        )
        analysis = _jd(row.analysis_json) or {}
        managed_run = analysis.get("_managed_run", {}) if isinstance(analysis, dict) else {}
        return {
            "task_id": row.task_id,
            "title": row.title,
            "description": row.description,
            "category_hint": row.category_hint,
            "flag_format": row.flag_format,
            "authorized": row.authorized,
            "allow_network": row.allow_network,
            "allowed_hosts": _jd(row.allowed_hosts, []) or [],
            "allowed_ports": _jd(row.allowed_ports, []) or [],
            "max_rounds": row.max_rounds,
            "max_time_sec": row.max_time_sec,
            "attachments": _jd(row.attachments, []) or [],
            "state": row.state,
            "rounds_used": row.rounds_used,
            "plan": _jd(row.plan_json),
            "analysis": analysis,
            "execution_mode": str(managed_run.get("execution_mode") or "auto"),
            "max_parallel_agents": int(managed_run.get("max_parallel_agents", 4) or 4),
            "current_script": row.current_script,
            "script_runs": [
                {
                    "success": a.success,
                    "exit_code": a.exit_code,
                    "stdout": a.stdout,
                    "stderr": a.stderr,
                    "duration_ms": a.duration_ms,
                    "timed_out": a.timed_out,
                    "workdir": a.workdir,
                    "error": a.error,
                    "run_index": a.run_index,
                }
                for a in artifacts
            ],
            "shell_history": [],
            "evidence": [
                {
                    "step": e.step,
                    "timestamp": e.timestamp,
                    "duration_ms": e.duration_ms,
                    "input_summary": e.input_summary,
                    "output_summary": e.output_summary,
                    "success": e.success,
                    "artifacts": _jd(e.artifacts_json, {}) or {},
                }
                for e in events
            ],
            "candidate_flags": [
                {
                    "flag": f.flag,
                    "source": f.source,
                    "line": f.line,
                    "snippet": f.snippet,
                    "confidence": f.confidence,
                    "matched_pattern": f.matched_pattern,
                }
                for f in flags
            ],
            "best_flag": row.best_flag,
            "has_writeup": bool(row.writeup_md),
            "writeup_md": row.writeup_md,
            "error": row.error or "",
            "is_running": row.is_running,
            "source": row.source,
            "demo_id": row.demo_id,
            "engine": row.engine or "legacy",
            "agent_run_id": row.agent_run_id,
            "agent_workspace": row.agent_workspace,
            # ⚠️ expected_flag 不返回到 API（防作弊）
            "created_at": row.created_at.timestamp() if row.created_at else 0,
            "updated_at": row.updated_at.timestamp() if row.updated_at else 0,
        }
    finally:
        db.close()


def list_tasks_view(limit: int = 100) -> List[Dict[str, Any]]:
    db: Session = SessionLocal()
    try:
        rows = (
            db.query(CtfTaskModel)
            .order_by(CtfTaskModel.created_at.desc())
            .limit(limit)
            .all()
        )
        out = []
        for row in rows:
            out.append({
                "task_id": row.task_id,
                "title": row.title,
                "description": row.description,
                "category_hint": row.category_hint,
                "flag_format": row.flag_format,
                "authorized": row.authorized,
                "allow_network": row.allow_network,
                "allowed_hosts": _jd(row.allowed_hosts, []) or [],
                "allowed_ports": _jd(row.allowed_ports, []) or [],
                "max_rounds": row.max_rounds,
                "max_time_sec": row.max_time_sec,
                "attachments": _jd(row.attachments, []) or [],
                "state": row.state,
                "rounds_used": row.rounds_used,
                "plan": _jd(row.plan_json),
                "analysis": _jd(row.analysis_json),
                "current_script": row.current_script,
                "shell_history": [],
                # 列表页轻量字段
                "script_runs": [],
                "evidence": [],
                "candidate_flags": [],
                "best_flag": row.best_flag,
                "has_writeup": bool(row.writeup_md),
                "error": row.error or "",
                "is_running": row.is_running,
                "source": row.source,
                "demo_id": row.demo_id,
                "engine": row.engine or "legacy",
                "agent_run_id": row.agent_run_id,
                "agent_workspace": row.agent_workspace,
                "created_at": row.created_at.timestamp() if row.created_at else 0,
                "updated_at": row.updated_at.timestamp() if row.updated_at else 0,
            })
        return out
    finally:
        db.close()


def get_expected_flag(task_id: str) -> Optional[str]:
    """只允许 benchmark / 评测代码读取，orchestrator 不可访问。"""
    db: Session = SessionLocal()
    try:
        row = db.query(CtfTaskModel).filter(CtfTaskModel.task_id == task_id).first()
        return row.expected_flag if row else None
    finally:
        db.close()


def save_writeup(task_id: str, md: str) -> None:
    db: Session = SessionLocal()
    try:
        row = db.query(CtfTaskModel).filter(CtfTaskModel.task_id == task_id).first()
        if row is None:
            return
        row.writeup_md = md
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        logger.warning("save_writeup failed: %s", e)
    finally:
        db.close()


def get_writeup(task_id: str) -> Optional[str]:
    db: Session = SessionLocal()
    try:
        row = db.query(CtfTaskModel).filter(CtfTaskModel.task_id == task_id).first()
        if row is None:
            return None
        return row.writeup_md or None
    finally:
        db.close()


def is_task_running(task_id: str) -> bool:
    db: Session = SessionLocal()
    try:
        row = db.query(CtfTaskModel).filter(CtfTaskModel.task_id == task_id).first()
        return bool(row and row.is_running)
    finally:
        db.close()
