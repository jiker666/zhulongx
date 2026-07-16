"""
CTF API Router — 烛龙·玄枢 的 CTF 任务接口（异步 + DB 持久化版）。

Endpoints:
- POST   /api/ctf/tasks                          创建任务
- GET    /api/ctf/tasks                          列出任务（DB-backed）
- GET    /api/ctf/tasks/{task_id}                获取任务详情（DB-backed，重启后仍可查）
- POST   /api/ctf/tasks/{task_id}/attachments   上传附件
- POST   /api/ctf/tasks/{task_id}/solve          启动解题（异步，立即返回）
- GET    /api/ctf/tasks/{task_id}/events         获取事件流（DB-backed）
- GET    /api/ctf/tasks/{task_id}/writeup        导出 WP
- GET    /api/ctf/demos                          列出内置 demo
- POST   /api/ctf/demos/{demo_id}/run            运行内置 demo（异步）
- GET    /api/ctf/benchmark                      能力评测
- GET    /api/ctf/llm/status                     LLM 模式（mock/live/disabled）
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.core.ctf_persistence import get_writeup, save_task
from app.core.blackboard import get_blackboard
from app.core.cost_accounting import get_cost_accounting
from app.core.model_router import get_model_router
from app.schemas.blackboard import HintIn, IntentUpdateIn
from app.scenarios.ctf.service import ctf_session_service


router = APIRouter(prefix="/ctf", tags=["ctf"])

# The retired direct-call orchestrator imports this symbol. Formal endpoints never
# use it; keeping it here prevents compatibility tests from coupling to v3.
_cancel_events: Dict[str, threading.Event] = {}

# ---------- schemas ----------


class TaskCreateIn(BaseModel):
    title: str = Field(..., description="题目标题")
    description: str = Field("", description="题面")
    category: str = Field("auto", description="auto|web|crypto|reverse|pwn|misc|forensics")
    flag_format: Optional[str] = Field(None, description="例如 SCTF\\{.*\\}")
    authorized: bool = Field(False, description="是否已获授权")
    allow_network: bool = Field(False, description="是否允许联网（需 authorized=true）")
    allowed_hosts: list[str] = Field(default_factory=list, max_length=100)
    allowed_ports: list[int] = Field(default_factory=list, max_length=100)
    max_rounds: int = Field(0, ge=0, description="最大轮数，0=无限")
    max_time_sec: int = Field(600, ge=30, le=3600, description="最大运行时间(秒)")
    execution_mode: Literal["auto", "coordinator", "single"] = "auto"
    max_parallel_agents: int = Field(default=4, ge=1, le=16)


class TaskSolveIn(BaseModel):
    mode: str = Field("auto", description="auto|assist|manual")
    max_rounds: int = Field(0, ge=0, description="最大轮数，0=无限")
    max_time_sec: int = Field(600, ge=30, le=3600, description="最大运行时间(秒)")


# ---------- helpers ----------


def _save_upload(upload_file: UploadFile, task_id: str) -> str:
    """安全保存上传文件到 task 专属目录。"""
    upload_dir = Path(settings.UPLOAD_DIR) / task_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    # 防路径穿越
    safe_name = Path(upload_file.filename or "upload.bin").name
    if not safe_name or safe_name.startswith("."):
        safe_name = f"upload_{int(time.time())}"
    # ⚠️ 反作弊：禁止上传名为 expected_flag.txt 的文件
    if safe_name == "expected_flag.txt":
        raise HTTPException(400, "expected_flag.txt is anti-cheat protected, upload rejected")
    dst = upload_dir / safe_name
    if dst.exists():
        dst = upload_dir / f"{dst.stem}_{uuid.uuid4().hex[:8]}{dst.suffix}"
    size_limit = settings.MAX_UPLOAD_SIZE
    with dst.open("wb") as out:
        written = 0
        while True:
            chunk = upload_file.file.read(64 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > size_limit:
                out.close()
                dst.unlink(missing_ok=True)
                raise HTTPException(413, f"upload too large (>{size_limit} bytes)")
            out.write(chunk)
    return str(dst)


def _list_demos() -> List[Dict[str, Any]]:
    """扫描内置 CTF demo。"""
    demo_root = Path(settings.CTF_DEMO_DIR)
    if not demo_root.is_dir():
        return []
    demos: List[Dict[str, Any]] = []
    for case_dir in sorted(demo_root.iterdir()):
        if not case_dir.is_dir():
            continue
        challenge_json = case_dir / "challenge.json"
        if not challenge_json.is_file():
            continue
        try:
            meta = json.loads(challenge_json.read_text(encoding="utf-8"))
        except Exception:
            continue
        demos.append({
            "id": case_dir.name,
            "title": meta.get("title", case_dir.name),
            "category": meta.get("category", "misc"),
            "difficulty": meta.get("difficulty", "easy"),
            "description": meta.get("description", "")[:300],
            "flag_format": meta.get("flag_format"),
            "has_attachment": (case_dir / "attachment").is_dir(),
            "needs_llm": meta.get("needs_llm", False),
            "est_time_sec": meta.get("est_time_sec", 5),
            "path": str(case_dir),
        })
    return demos


def _llm_status() -> Dict[str, Any]:
    """返回当前 LLM 模式（mock / live / disabled），不泄露 key。"""
    configured = bool(settings.LLM_ENABLED and settings.LLM_API_KEY and settings.LLM_API_KEY != "replace_me")
    return {
        "mode": "live" if configured else "disabled",
        "provider": settings.LLM_PROVIDER,
        "model": settings.LLM_MODEL,
        "base_url_host": settings.LLM_BASE_URL.split("//")[-1].split("/")[0] if settings.LLM_BASE_URL else "",
        "api_key_configured": configured,
        "enabled": configured,
    }


# ---------- endpoints ----------


@router.post("/tasks")
def create_task(payload: TaskCreateIn):
    task = ctf_session_service.create_task(
        title=payload.title,
        description=payload.description,
        category_hint=payload.category,
        flag_format=payload.flag_format,
        authorized=payload.authorized,
        allow_network=payload.allow_network,
        allowed_hosts=tuple(payload.allowed_hosts),
        allowed_ports=tuple(payload.allowed_ports),
        max_rounds=payload.max_rounds,
        max_time_sec=payload.max_time_sec,
        execution_mode=payload.execution_mode,
        max_parallel_agents=payload.max_parallel_agents,
        source="api",
    )
    return {"task_id": task["task_id"], "state": task["state"], "engine": "v3"}


@router.get("/tasks")
def list_tasks():
    """从 DB 加载所有任务（重启后仍可查）。"""
    return ctf_session_service.list_tasks(limit=200)


@router.get("/tasks/{task_id}")
def get_task(task_id: str):
    try:
        return ctf_session_service.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"task not found: {task_id}")


@router.post("/tasks/{task_id}/attachments")
async def upload_attachment(
    task_id: str,
    file: UploadFile = File(...),
):
    try:
        ctf_session_service.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"task not found (or already finished): {task_id}")
    saved = _save_upload(file, task_id)
    if not ctf_session_service.add_attachment(task_id, saved):
        Path(saved).unlink(missing_ok=True)
        raise HTTPException(409, "attachments cannot be changed after a ManagedRun is created")
    return {"saved_path": saved, "filename": file.filename, "size": os.path.getsize(saved)}


@router.post("/tasks/{task_id}/solve")
def solve_task(task_id: str, payload: TaskSolveIn):
    """异步启动解题。立即返回，不阻塞。"""
    try:
        task = ctf_session_service.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"task not found: {task_id}")
    if payload.mode == "manual":
        return {"task_id": task_id, "state": "MANUAL", "note": "manual 模式：仅创建不执行"}
    try:
        task, started = ctf_session_service.start(
            task_id,
            max_rounds=payload.max_rounds,
            max_time_sec=payload.max_time_sec,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "task_id": task_id,
        "run_id": task.get("agent_run_id"),
        "state": task["state"],
        "agent_status": task.get("agent_status"),
        "note": "已异步启动，请增量轮询 /events" if started else "任务未启动或已在运行/终止",
        "poll_interval_ms": 1000,
    }


@router.post("/tasks/{task_id}/stop")
def stop_task(task_id: str):
    """手动停止正在运行的任务。"""
    try:
        ctf_session_service.get_task(task_id)
    except KeyError:
        raise HTTPException(404, f"task not found: {task_id}")
    abort_requested = ctf_session_service.abort(task_id, "用户手动停止")
    return {
        "task_id": task_id,
        "state": "HUMAN_REQUIRED",
        "note": "已请求停止；运行线程完成清理后自动退出",
        "abort_requested": abort_requested,
    }


@router.get("/tasks/{task_id}/events")
def get_events(task_id: str, after_sequence: int = Query(default=0, ge=0)):
    """Canonical v3 events with a reconnect cursor and compatibility projections."""
    try:
        return ctf_session_service.events(task_id, after_sequence=after_sequence)
    except KeyError:
        raise HTTPException(404, f"task not found: {task_id}")


@router.get("/tasks/{task_id}/writeup", response_class=PlainTextResponse)
def get_writeup_endpoint(task_id: str):
    md = get_writeup(task_id)
    if md:
        return md
    raise HTTPException(404, "writeup not generated yet")


@router.get("/demos")
def list_demos():
    demos = _list_demos()
    # 附加 LLM 模式信息
    return {"demos": demos, "llm": _llm_status()}


@router.post("/demos/{demo_id}/run")
def run_demo(demo_id: str, max_rounds: int = 0, max_time_sec: int = 600, sync: bool = False):
    """运行内置 demo 题。默认异步，sync=true 同步等待。"""
    demo_root = Path(settings.CTF_DEMO_DIR)
    case_dir = demo_root / demo_id
    if not case_dir.is_dir():
        raise HTTPException(404, f"demo not found: {demo_id}")
    challenge_json = case_dir / "challenge.json"
    if not challenge_json.is_file():
        raise HTTPException(404, "challenge.json missing")
    try:
        meta = json.loads(challenge_json.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(500, f"invalid challenge.json: {e}")

    expected_flag = None
    expected = case_dir / "expected_flag.txt"
    if expected.is_file():
        expected_flag = expected.read_text(encoding="utf-8").strip()

    task = ctf_session_service.create_task(
        title=meta.get("title", demo_id),
        description=meta.get("description", ""),
        category_hint=meta.get("category", "auto"),
        flag_format=meta.get("flag_format"),
        authorized=True,
        allow_network=meta.get("allow_network", False),
        max_rounds=max_rounds,
        execution_mode="single",
        source="demo",
        demo_id=demo_id,
        expected_flag=expected_flag,  # ⚠️ 仅 benchmark 用，orchestrator 不读
    )
    # 注入附件（排除 expected_flag.txt）
    att_dir = case_dir / "attachment"
    if att_dir.is_dir():
        for item in att_dir.iterdir():
            if item.is_file() and item.name != "expected_flag.txt":
                upload_dir = Path(settings.UPLOAD_DIR) / task["task_id"]
                upload_dir.mkdir(parents=True, exist_ok=True)
                dst = upload_dir / item.name
                if not dst.exists():
                    shutil.copy2(item, dst)
                ctf_session_service.add_attachment(task["task_id"], str(dst))

    # Web demo 特殊处理：自动启动本地靶场
    target_url = meta.get("target_url", "")
    if meta.get("category") == "web" and target_url:
        from app.core.web_target_manager import ensure_target_running
        try:
            target_info = ensure_target_running(demo_id, case_dir)
            task["description"] += f"\n[靶场已启动] {target_info['url']}"
            save_task(task)
        except Exception as e:  # noqa: BLE001
            # 靶场启动失败不阻塞，Agent 仍可分析源码
            import logging
            logging.getLogger(__name__).warning("web target start failed: %s", e)

    # 同步 or 异步
    task, _ = ctf_session_service.start(
        task["task_id"],
        max_rounds=max_rounds,
        max_time_sec=max_time_sec,
        sync=sync,
    )

    return {
        "task_id": task["task_id"],
        "run_id": task.get("agent_run_id"),
        "state": task["state"],
        "agent_status": task.get("agent_status"),
        "best_flag": task.get("best_flag"),
        "note": "已异步启动" if not sync else "已完成",
    }


@router.get("/benchmark")
def benchmark():
    """汇总所有 CTF 任务的统计指标（DB-backed）。"""
    tasks = ctf_session_service.list_tasks(limit=500)
    total = len(tasks)
    if not total:
        return {
            "total": 0, "solved": 0, "success_rate": 0.0,
            "avg_duration_ms": 0, "category_breakdown": {},
            "category_success_rate": {}, "human_takeover": 0,
            "tool_calls_total": 0, "needs_llm_count": 0,
        }
    solved = sum(1 for t in tasks if t["state"] == "DONE")
    durations = []
    for t in tasks:
        if t["state"] == "DONE" and t.get("created_at") and t.get("updated_at"):
            durations.append((t["updated_at"] - t["created_at"]) * 1000)
    avg_duration = sum(durations) / len(durations) if durations else 0
    by_cat: Dict[str, Dict[str, int]] = {}
    for t in tasks:
        cat = (t.get("plan") or {}).get("category") if isinstance(t.get("plan"), dict) else "unknown"
        if not cat:
            cat = t.get("category_hint") or "unknown"
        rec = by_cat.setdefault(cat, {"total": 0, "solved": 0, "needs_llm": 0})
        rec["total"] += 1
        if t["state"] == "DONE":
            rec["solved"] += 1
    cat_rate = {k: (v["solved"] / v["total"] if v["total"] else 0) for k, v in by_cat.items()}
    human = sum(1 for t in tasks if t["state"] == "HUMAN_REQUIRED")
    # 统计每题工具调用数（events 里 step=run_script 的次数）
    tool_calls = 0
    needs_llm = 0
    for t in tasks:
        # 粗略：script_runs 数量 + evidence 数量
        tool_calls += len(t.get("script_runs", [])) + len(t.get("evidence", []))
    return {
        "total": total,
        "solved": solved,
        "success_rate": round(solved / total, 3),
        "avg_duration_ms": round(avg_duration, 0),
        "category_breakdown": by_cat,
        "category_success_rate": cat_rate,
        "human_takeover": human,
        "tool_calls_total": tool_calls,
        "needs_llm_count": needs_llm,
    }


@router.get("/llm/status")
def llm_status():
    return _llm_status()


# ---------- v6: Blackboard / Cost / Router ----------


@router.get("/tasks/{task_id}/blackboard")
def get_blackboard_endpoint(task_id: str):
    """获取任务的事实黑板 / 意图队列 / 提示。"""
    bb = get_blackboard()
    return bb.snapshot(task_id)


@router.post("/tasks/{task_id}/hints")
def add_hint_endpoint(task_id: str, payload: HintIn):
    """添加人工 / Observer 提示。"""
    bb = get_blackboard()
    hint = bb.add_hint(task_id=task_id, content=payload.content, source=payload.source)
    return hint.to_dict()


@router.patch("/tasks/{task_id}/intents/{intent_id}")
def update_intent_endpoint(task_id: str, intent_id: str, payload: IntentUpdateIn):
    """更新意图状态。"""
    bb = get_blackboard()
    updated = bb.update_intent(
        task_id, intent_id,
        status=payload.status,
        title=payload.title,
        rationale=payload.rationale,
        priority=payload.priority,
        result_fact_ids=payload.result_fact_ids,
    )
    if not updated:
        raise HTTPException(404, f"intent not found: {intent_id}")
    return updated.to_dict()


@router.get("/tasks/{task_id}/cost")
def get_task_cost_endpoint(task_id: str):
    """获取任务的 LLM 调用成本汇总。"""
    acc = get_cost_accounting()
    summary = acc.get_task_summary(task_id)
    return summary.to_dict()


@router.get("/tasks/{task_id}/cost/records")
def get_task_cost_records_endpoint(task_id: str, limit: int = 100):
    """获取任务的 LLM 调用明细（脱敏）。"""
    acc = get_cost_accounting()
    records = acc.get_task_records(task_id)[-limit:]
    return {"task_id": task_id, "records": [r.to_dict() for r in records]}


@router.get("/llm/router/status")
def llm_router_status():
    """获取模型路由状态（脱敏，不泄露 key）。"""
    router = get_model_router()
    return router.status()
