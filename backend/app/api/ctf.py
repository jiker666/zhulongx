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

import asyncio
import json
import os
import shutil
import time
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.core.ctf_agent_orchestrator import CtfOrchestrator, CtfState, get_orchestrator
from app.core.ctf_persistence import (
    get_expected_flag,
    get_writeup,
    is_task_running,
    list_tasks_view,
    load_task_view,
)
from app.core.llm_adapter import get_adapter
from app.core.blackboard import get_blackboard
from app.core.cost_accounting import get_cost_accounting
from app.core.model_router import get_model_router
from app.schemas.blackboard import HintIn, IntentUpdateIn


router = APIRouter(prefix="/ctf", tags=["ctf"])

# ---------- schemas ----------


class TaskCreateIn(BaseModel):
    title: str = Field(..., description="题目标题")
    description: str = Field("", description="题面")
    category: str = Field("auto", description="auto|web|crypto|reverse|pwn|misc|forensics")
    flag_format: Optional[str] = Field(None, description="例如 SCTF\\{.*\\}")
    authorized: bool = Field(False, description="是否已获授权")
    allow_network: bool = Field(False, description="是否允许联网（需 authorized=true）")
    max_rounds: int = Field(8, ge=1, le=16)


class TaskSolveIn(BaseModel):
    mode: str = Field("auto", description="auto|assist|manual")
    max_rounds: int = Field(8, ge=1, le=16)


# ---------- async runner ----------

# 全局线程池（避免阻塞 event loop）
_runner_lock = threading.Lock()
_running_tasks: Dict[str, threading.Thread] = {}


def _run_task_in_thread(task_id: str, max_rounds: int) -> None:
    """在独立线程中运行 orchestrator（不阻塞 FastAPI event loop）。"""
    try:
        orch = get_orchestrator()
        orch.run(task_id, max_rounds=max_rounds)
    except Exception as e:  # noqa: BLE001
        # 标记失败
        import logging
        logging.getLogger(__name__).exception("async run failed: %s", task_id)
        try:
            task = orch.get_task(task_id)
            if task:
                task.state = CtfState.FAILED
                task.error = f"async runner error: {type(e).__name__}: {e}"
                from app.core.ctf_persistence import save_task
                save_task(task.to_dict())
        except Exception:
            pass
    finally:
        with _runner_lock:
            _running_tasks.pop(task_id, None)


def _start_async_run(task_id: str, max_rounds: int) -> None:
    """启动后台线程执行任务。"""
    with _runner_lock:
        if task_id in _running_tasks:
            return  # 已在运行
        if is_task_running(task_id):
            return  # DB 标记为运行中
    t = threading.Thread(
        target=_run_task_in_thread,
        args=(task_id, max_rounds),
        daemon=True,
        name=f"ctf-run-{task_id}",
    )
    with _runner_lock:
        _running_tasks[task_id] = t
    t.start()


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
    adapter = get_adapter()
    if adapter.mock_mode:
        mode = "mock"
    elif not adapter.enabled:
        mode = "disabled"
    else:
        mode = "live"
    return {
        "mode": mode,
        "provider": adapter.provider,
        "model": adapter.model,
        "base_url_host": adapter.base_url.split("//")[-1].split("/")[0] if adapter.base_url else "",
        "api_key_configured": bool(adapter.api_key and adapter.api_key != "replace_me"),
        "enabled": adapter.enabled,
    }


# ---------- endpoints ----------


@router.post("/tasks")
def create_task(payload: TaskCreateIn):
    orch = get_orchestrator()
    task = orch.create_task(
        title=payload.title,
        description=payload.description,
        category_hint=payload.category,
        flag_format=payload.flag_format,
        authorized=payload.authorized,
        allow_network=payload.allow_network,
        max_rounds=payload.max_rounds,
        source="api",
    )
    return {"task_id": task.task_id, "state": task.state.value}


@router.get("/tasks")
def list_tasks():
    """从 DB 加载所有任务（重启后仍可查）。"""
    return list_tasks_view(limit=200)


@router.get("/tasks/{task_id}")
def get_task(task_id: str):
    """优先从内存取（运行中），否则从 DB 取（历史）。"""
    orch = get_orchestrator()
    task = orch.get_task(task_id)
    if task:
        return task.to_dict()
    # 从 DB 取
    view = load_task_view(task_id)
    if not view:
        raise HTTPException(404, f"task not found: {task_id}")
    return view


@router.post("/tasks/{task_id}/attachments")
async def upload_attachment(
    task_id: str,
    file: UploadFile = File(...),
):
    orch = get_orchestrator()
    task = orch.get_task(task_id)
    if not task:
        # 也允许从 DB 恢复（但不支持再加附件）
        raise HTTPException(404, f"task not found (or already finished): {task_id}")
    saved = _save_upload(file, task_id)
    orch.add_attachment(task_id, saved)
    return {"saved_path": saved, "filename": file.filename, "size": os.path.getsize(saved)}


@router.post("/tasks/{task_id}/solve")
def solve_task(task_id: str, payload: TaskSolveIn):
    """异步启动解题。立即返回，不阻塞。"""
    orch = get_orchestrator()
    task = orch.get_task(task_id)
    if not task:
        raise HTTPException(404, f"task not found: {task_id}")
    if payload.mode == "manual":
        return {"task_id": task_id, "state": "MANUAL", "note": "manual 模式：仅创建不执行"}
    # 检查是否已在运行
    if is_task_running(task_id):
        return {"task_id": task_id, "state": task.state.value, "note": "任务已在运行中"}
    # 异步启动
    _start_async_run(task_id, payload.max_rounds)
    return {
        "task_id": task_id,
        "state": task.state.value,
        "note": "已异步启动，请轮询 /events 或 /tasks/{task_id} 获取进度",
        "poll_interval_ms": 1000,
    }


@router.get("/tasks/{task_id}/events")
def get_events(task_id: str):
    """事件流（DB-backed，重启后仍可查）。"""
    # 优先从内存取（运行中实时数据）
    orch = get_orchestrator()
    task = orch.get_task(task_id)
    if task:
        return {
            "task_id": task_id,
            "state": task.state.value,
            "is_running": task.is_running,
            "events": [e.to_dict() for e in task.evidence],
            "script_runs": task.script_runs,
            "candidate_flags": task.candidate_flags,
            "best_flag": task.best_flag,
            "current_script": task.current_script,
        }
    # 从 DB 取
    view = load_task_view(task_id)
    if not view:
        raise HTTPException(404, f"task not found: {task_id}")
    return {
        "task_id": task_id,
        "state": view["state"],
        "is_running": view.get("is_running", False),
        "events": view["evidence"],
        "script_runs": view["script_runs"],
        "candidate_flags": view["candidate_flags"],
        "best_flag": view["best_flag"],
        "current_script": view["current_script"],
    }


@router.get("/tasks/{task_id}/writeup", response_class=PlainTextResponse)
def get_writeup_endpoint(task_id: str):
    # 先从 DB 取
    md = get_writeup(task_id)
    if md:
        return md
    # 再从内存取
    orch = get_orchestrator()
    task = orch.get_task(task_id)
    if task and task.writeup_md:
        return task.writeup_md
    raise HTTPException(404, "writeup not generated yet")


@router.get("/demos")
def list_demos():
    demos = _list_demos()
    # 附加 LLM 模式信息
    return {"demos": demos, "llm": _llm_status()}


@router.post("/demos/{demo_id}/run")
def run_demo(demo_id: str, max_rounds: int = 8, sync: bool = False):
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

    orch = get_orchestrator()
    expected_flag = None
    expected = case_dir / "expected_flag.txt"
    if expected.is_file():
        expected_flag = expected.read_text(encoding="utf-8").strip()

    task = orch.create_task(
        title=meta.get("title", demo_id),
        description=meta.get("description", ""),
        category_hint=meta.get("category", "auto"),
        flag_format=meta.get("flag_format"),
        authorized=True,
        allow_network=meta.get("allow_network", False),
        max_rounds=max_rounds,
        source="demo",
        demo_id=demo_id,
        expected_flag=expected_flag,  # ⚠️ 仅 benchmark 用，orchestrator 不读
    )
    # 注入附件（排除 expected_flag.txt）
    att_dir = case_dir / "attachment"
    if att_dir.is_dir():
        for item in att_dir.iterdir():
            if item.is_file() and item.name != "expected_flag.txt":
                upload_dir = Path(settings.UPLOAD_DIR) / task.task_id
                upload_dir.mkdir(parents=True, exist_ok=True)
                dst = upload_dir / item.name
                shutil.copy2(item, dst)
                orch.add_attachment(task.task_id, str(dst))

    # Web demo 特殊处理：自动启动本地靶场
    target_url = meta.get("target_url", "")
    if meta.get("category") == "web" and target_url:
        from app.core.web_target_manager import ensure_target_running
        try:
            target_info = ensure_target_running(demo_id, case_dir)
            task.description += f"\n[靶场已启动] {target_info['url']}"
            # 更新 DB
            from app.core.ctf_persistence import save_task
            save_task(task.to_dict())
        except Exception as e:  # noqa: BLE001
            # 靶场启动失败不阻塞，Agent 仍可分析源码
            import logging
            logging.getLogger(__name__).warning("web target start failed: %s", e)

    # 同步 or 异步
    if sync:
        orch.run(task.task_id, max_rounds=max_rounds)
    else:
        _start_async_run(task.task_id, max_rounds)

    return {
        "task_id": task.task_id,
        "state": task.state.value,
        "expected_flag": expected_flag,  # 仅 benchmark 比对用，不返回给 orchestrator
        "note": "已异步启动" if not sync else "已完成",
    }


@router.get("/benchmark")
def benchmark():
    """汇总所有 CTF 任务的统计指标（DB-backed）。"""
    tasks = list_tasks_view(limit=500)
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
